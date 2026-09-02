/**
 * `mcp` — the page-facing namespace (reference/contract/0.2.32/mcp.d.ts):
 *
 *   callTool(server, tool, input?, options?)      -> CallToolResult
 *   watchTool(server, tool, input, handler, opts?) -> unsubscribe()
 *   invalidate(server?, tool?, input?)           -> void
 *   listTools()                                  -> {servers: [...]}
 *
 * The frame owns the caller-bug half of the contract: argument shapes, the
 * plain-JSON rule for `input`, option validation, the 64-watch cap and the
 * synchronous `TypeError` for a missing handler — so an obvious mistake never
 * costs a round trip and the page sees the documented `bad_request`. The
 * shell re-checks everything, because a frame is not trusted.
 *
 * Like `sample`, this module runs its own `__frame_cap` client over an
 * `RpcHost` instead of `createRpc`: `callTool` must know its own id to post
 * `cancelCall`, and watches receive unsolicited `__frame_mcp_watch` pushes.
 *
 * Wire (docs/surface-area.md §5.8): id prefix `c`, watch ids `w<rand>-<n>`,
 * reply budget `capBudgets.mcp[method]` (clamped to 600 s, +2 s) else 130 s,
 * `upstream_error` on timeout, an `__frame_cap_ack` extends it to 900 s.
 */
import { browserRpcHost, type RpcHost } from "../../frame/rpc.ts";
import type { FrameContext } from "../../frame/types.ts";
import { capIdPrefix } from "../../protocol/capabilities.ts";
import { isFrameCapAck, isFrameCapReply, RPC_ACK_TIMEOUT_MS } from "../../protocol/messages.ts";
import {
  CAP,
  DEFAULT_BUDGET_MS,
  MAX_WATCHES,
  asMcpError,
  badRequest,
  errorText,
  isFrameMcpWatch,
  isName,
  isPlainJson,
  mcpError,
  noReply,
  normalizeResult,
  readCacheOption,
  readListToolsReply,
  readRefetchInterval,
  replyBudget,
  validateCallArgs,
  type CacheMarker,
  type CallToolResult,
  type ListToolsResult,
  type McpError,
} from "./protocol.ts";

export { CAP } from "./protocol.ts";

export type WatchEvent =
  | { type: "data"; result: CallToolResult }
  | { type: "error"; error: McpError };

export type Unsubscribe = () => void;

export interface CallToolOptions {
  cache?: false | { staleTime?: number; gcTime?: number; refresh?: boolean };
  signal?: AbortSignal;
}

export interface WatchToolOptions {
  cache?: { staleTime?: number; gcTime?: number };
  refetchInterval?: number;
}

export interface McpNamespace {
  callTool(server: string, tool: string, input?: unknown, options?: CallToolOptions): Promise<CallToolResult>;
  watchTool(
    server: string,
    tool: string,
    input: unknown,
    handler: (ev: WatchEvent) => void,
    options?: WatchToolOptions,
  ): Unsubscribe;
  invalidate(server?: string, tool?: string, input?: unknown): Promise<void>;
  listTools(): Promise<ListToolsResult>;
}

export interface McpClientOptions {
  /** Test seam: stands in for `parent.postMessage` (see `frame/rpc.ts`). */
  host?: RpcHost;
  /** Test seam: register the page-hide hook; defaults to `window` `pagehide`. */
  onPageHide?: (fn: () => void) => void;
  /** Test seam: the random half of a watch id. */
  random?: () => string;
  /** Test seam: where a throwing watch handler is reported. */
  reportError?: (err: unknown) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: McpError) => void;
  timer: unknown;
  acked: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { aborted?: unknown }).aborted === "boolean" &&
    typeof (value as { addEventListener?: unknown }).addEventListener === "function"
  );
}

function isCacheMarker(value: unknown): value is CacheMarker {
  return (
    isRecord(value) &&
    typeof value.storedAt === "number" &&
    Number.isFinite(value.storedAt) &&
    typeof value.revalidating === "boolean"
  );
}

/**
 * A result the shell sent, in the page's shape. The shell forwards the
 * connector's result as it came (plus its own `cache` stamp); deriving
 * `payload` and turning `isError` into a rejection is the runtime's job, as
 * on the platform. Returns the `tool_error` to reject with for a failure.
 */
export function readResultReply(raw: unknown): { result: CallToolResult } | { error: McpError } {
  const { result, isError } = normalizeResult(raw);
  if (isRecord(raw) && isCacheMarker(raw.cache)) {
    result.cache = { storedAt: raw.cache.storedAt, revalidating: raw.cache.revalidating };
  }
  if (isError) {
    return { error: mcpError("tool_error", errorText(result), { result }) };
  }
  return { result };
}

const CANCELLED = (): McpError =>
  mcpError("cancelled", "the call was cancelled - the tool may still have run");

function defaultRandom(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

export function createMcp(ctx: FrameContext, options: McpClientOptions = {}): McpNamespace {
  const host = options.host ?? browserRpcHost(ctx.shellOrigin);
  const random = options.random ?? defaultRandom;
  const report =
    options.reportError ??
    ((err: unknown): void => {
      try {
        console.error("mcp watch handler threw", err);
      } catch {
        /* nothing to report to */
      }
    });
  const pipe = ctx.pipe(CAP);
  const idPrefix = capIdPrefix(CAP);
  const callBudget = replyBudget(ctx.capBudgets, "callTool");
  const listBudget = replyBudget(ctx.capBudgets, "listTools");

  const pending = new Map<string, Pending>();
  const watches = new Map<string, (ev: WatchEvent) => void>();
  let counter = 0;
  let watchCounter = 0;

  /* ------------------------------ transport ------------------------------ */

  const settle = (id: string): Pending | undefined => {
    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      host.clearTimer(entry.timer);
    }
    return entry;
  };

  const expire = (id: string): void => {
    settle(id)?.reject(noReply());
  };

  const nextId = (): string => `${idPrefix}${++counter}`;

  /** A call that waits for its `__frame_cap_r`. */
  function request(id: string, method: string, args: unknown[], budgetMs: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = {
        resolve,
        reject,
        timer: host.setTimer(() => expire(id), budgetMs),
        acked: false,
      };
      pending.set(id, entry);
      try {
        host.post({ __frame_cap: true, cap: CAP, id, method, args }, ctx.shellOrigin);
      } catch {
        settle(id);
        reject(badRequest("arguments must be cloneable"));
      }
    });
  }

  /** A call whose answer nobody waits for (`cancelCall`, `unwatchTool`). */
  function notify(method: string, args: unknown[]): void {
    try {
      host.post({ __frame_cap: true, cap: CAP, id: nextId(), method, args }, ctx.shellOrigin);
    } catch {
      /* a cancel or unwatch the shell never hears is harmless */
    }
  }

  host.listen((ev) => {
    if (!host.accepts(ev)) return;
    const data = ev.data;
    if (isFrameCapReply(data)) {
      const entry = settle(data.id);
      if (!entry) return;
      if (data.error !== undefined && data.error !== null) entry.reject(asMcpError(data.error));
      else entry.resolve(data.result);
      return;
    }
    if (isFrameCapAck(data)) {
      const entry = pending.get(data.id);
      if (!entry || entry.acked) return;
      entry.acked = true;
      host.clearTimer(entry.timer);
      entry.timer = host.setTimer(() => expire(data.id), RPC_ACK_TIMEOUT_MS);
      return;
    }
    if (isFrameMcpWatch(data)) {
      const deliver = watches.get(data.watchId);
      if (!deliver) return;
      if (data.ev.type === "error") {
        deliver({ type: "error", error: asMcpError(data.ev.error) });
        return;
      }
      const read = readResultReply(data.ev.result);
      deliver("error" in read ? { type: "error", error: read.error } : { type: "data", result: read.result });
    }
  });

  /* ------------------------------- callTool ------------------------------ */

  function readCallOptions(raw: unknown): { cache: unknown; signal: AbortSignal | undefined; wire: Record<string, unknown> } {
    if (raw === undefined || raw === null) return { cache: undefined, signal: undefined, wire: {} };
    if (!isRecord(raw)) throw badRequest("options must be an object");
    const cache = readCacheOption(raw.cache, "call");
    let signal: AbortSignal | undefined;
    if (raw.signal !== undefined && raw.signal !== null) {
      if (!looksLikeSignal(raw.signal)) throw badRequest("options.signal must be an AbortSignal");
      signal = raw.signal;
    }
    // The signal is held here and never crosses to the shell (mcp.d.ts).
    const wire: Record<string, unknown> = {};
    if (cache !== undefined) wire.cache = cache;
    return { cache, signal, wire };
  }

  const callTool = pipe.wrap(
    "callTool",
    async (server: unknown, tool: unknown, input?: unknown, options?: unknown): Promise<CallToolResult> => {
      const args = validateCallArgs(server, tool, input);
      const opts = readCallOptions(options);
      if (opts.signal?.aborted) throw CANCELLED();

      const id = nextId();
      const onAbort = (): void => {
        const entry = settle(id);
        if (!entry) return;
        notify("cancelCall", [id]);
        entry.reject(CANCELLED());
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      let reply: unknown;
      try {
        reply = await request(id, "callTool", [args.server, args.tool, args.input, opts.wire], callBudget);
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
      }
      const read = readResultReply(reply);
      if ("error" in read) throw read.error;
      return read.result;
    },
  );

  /* ------------------------------ watchTool ------------------------------ */

  function watchTool(
    server: unknown,
    tool: unknown,
    input: unknown,
    handler: unknown,
    options?: unknown,
  ): Unsubscribe {
    // The one synchronous throw on this surface: with no handler there is
    // no event channel to route a failure to.
    if (typeof handler !== "function") {
      throw new TypeError("watchTool needs a handler function");
    }
    const fn = handler as (ev: WatchEvent) => void;
    let active = true;
    let registered = false;
    const watchId = `w${random()}-${++watchCounter}`;

    const deliver = (ev: WatchEvent): void => {
      if (!active) return;
      try {
        fn(ev);
      } catch (err) {
        report(err);
      }
    };
    // Every failure is an event, and no event fires before a microtask, so
    // the page has stored the unsubscribe before anything can arrive.
    const failLater = (error: McpError): void => {
      void Promise.resolve().then(() => deliver({ type: "error", error }));
    };
    const unsubscribe: Unsubscribe = () => {
      if (!active) return;
      active = false;
      if (registered) {
        registered = false;
        watches.delete(watchId);
        notify("unwatchTool", [watchId]);
      }
    };

    let wire: unknown[];
    try {
      const args = validateCallArgs(server, tool, input);
      if (options !== undefined && options !== null && !isRecord(options)) {
        throw badRequest("options must be an object");
      }
      const opts = isRecord(options) ? options : {};
      const cache = readCacheOption(opts.cache, "watch");
      if (cache === false) throw badRequest("watchTool cannot run uncached: it delivers through the cache");
      if (cache?.gcTime !== undefined && cache.gcTime <= 0) {
        throw badRequest("a watch keeps its result to replay it: cache.gcTime must be positive");
      }
      const refetchInterval = readRefetchInterval(opts.refetchInterval);
      const wireOptions: Record<string, unknown> = { watchId };
      if (cache !== undefined) wireOptions.cache = cache;
      if (refetchInterval !== null) wireOptions.refetchInterval = refetchInterval;
      wire = [args.server, args.tool, args.input, wireOptions];
    } catch (err) {
      failLater(asMcpError(err));
      return unsubscribe;
    }
    if (watches.size >= MAX_WATCHES) {
      failLater(badRequest(`at most ${MAX_WATCHES} watches per view - unsubscribe unused watches`));
      return unsubscribe;
    }

    watches.set(watchId, deliver);
    registered = true;
    request(nextId(), "watchTool", wire, callBudget).then(
      () => undefined,
      (err: unknown) => {
        // A registration failure: no live updates will ever arrive.
        if (watches.get(watchId) === deliver) {
          watches.delete(watchId);
          registered = false;
        }
        deliver({ type: "error", error: asMcpError(err) });
      },
    );
    return unsubscribe;
  }

  /* ------------------------------ invalidate ----------------------------- */

  const invalidate = pipe.wrap(
    "invalidate",
    async (server?: unknown, tool?: unknown, input?: unknown): Promise<void> => {
      const args: unknown[] = [];
      if (server !== undefined) {
        if (!isName(server)) throw badRequest("server must be a connector's display name");
        args.push(server);
      }
      if (tool !== undefined) {
        if (server === undefined) throw badRequest("invalidate(tool) needs the server too");
        if (!isName(tool)) throw badRequest("tool must be a tool name");
        args.push(tool);
      }
      if (input !== undefined) {
        if (server === undefined || tool === undefined) {
          throw badRequest("invalidate(input) needs the server and tool too");
        }
        // The same rule as callTool: arguments are a plain JSON object.
        if (input !== null && (!isRecord(input) || !isPlainJson(input))) {
          throw badRequest("input must be a plain JSON object of tool arguments");
        }
        args.push(input);
      }
      await request(nextId(), "invalidate", args, DEFAULT_BUDGET_MS);
    },
  );

  /* ------------------------------- listTools ----------------------------- */

  const listTools = pipe.wrap("listTools", async (): Promise<ListToolsResult> => {
    const reply = await request(nextId(), "listTools", [], listBudget);
    return readListToolsReply(reply);
  });

  /* ------------------------------- teardown ------------------------------ */

  const releaseAll = (): void => {
    for (const watchId of [...watches.keys()]) {
      watches.delete(watchId);
      notify("unwatchTool", [watchId]);
    }
  };
  if (options.onPageHide) options.onPageHide(releaseAll);
  else if (typeof window !== "undefined") window.addEventListener("pagehide", releaseAll);

  return Object.freeze({ callTool, watchTool, invalidate, listTools }) as McpNamespace;
}

export function install(ctx: FrameContext): void {
  ctx.mount(CAP, createMcp(ctx));
}
