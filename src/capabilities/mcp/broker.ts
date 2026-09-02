/**
 * `mcp` broker: the shell side of "call the viewer's connectors".
 *
 * It owns what the platform's shell owns (docs/analysis/shell.md §"mcp"):
 * the manifest gate, the `host:` refusal, first-call consent per server, the
 * result cache with its shell-attested `cache` marker, coalescing of
 * identical in-flight calls, the watch registry with its refetch loop, and
 * `invalidate`. No credential ever reaches the frame: the shell calls its own
 * backend same-origin with the viewer cookie, and the server holds whatever
 * the connector needs.
 *
 * The cache lives here, in shell memory, per artifact and viewer — the
 * platform's is per viewer + artifact too, "cleared on logout", which a
 * page-scoped map gives for free.
 */
import { isCapError } from "../../protocol/errors.ts";
import type { BrokerCall, BrokerContext, ConsentRequest } from "../../shell/types.ts";
import {
  DEFAULT_GC_TIME_MS,
  IDENTITY_SEPARATOR,
  MAX_GC_TIME_MS,
  MAX_STALE_TIME_MS,
  MAX_WATCHES,
  asMcpError,
  badRequest,
  callIdentity,
  inManifest,
  isHostServer,
  manifestServer,
  mcpError,
  readCacheOption,
  readManifest,
  readRefetchInterval,
  readToolInfo,
  resolveCachePolicy,
  serverConsentKey,
  validateCallArgs,
  type CacheMarker,
  type Manifest,
  type McpError,
  type ToolAnnotations,
  type ToolInfo,
} from "./protocol.ts";

/** Entries held at once; the oldest is dropped past this (never swept else). */
const MAX_CACHE_ENTRIES = 256;
/** How long one `listTools` answer serves annotation lookups. */
const TOOL_INFO_TTL_MS = 60_000;
const SERVERS_TIMEOUT_MS = 65_000;
const CALL_TIMEOUT_MS = 125_000;

/* ------------------------------- environment ------------------------------ */

/**
 * What the broker observes of the browser, behind one object so the unit
 * tests can run it under a fake clock and a fake document.
 */
export interface BrokerEnv {
  fetch(input: string, init: RequestInit): Promise<Response>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** True while the page (and so the frame) is hidden. */
  hidden(): boolean;
  /** Run `fn` each time the page becomes visible; returns the unsubscribe. */
  onVisible(fn: () => void): () => void;
  /** Run `fn` after the current turn (a watch's first delivery). */
  defer(fn: () => void): void;
}

function browserEnv(): BrokerEnv {
  return {
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
    onVisible: (fn) => {
      if (typeof document === "undefined") return () => undefined;
      const listener = (): void => {
        if (document.visibilityState === "visible") fn();
      };
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    defer: (fn) => {
      void Promise.resolve().then(fn);
    },
  };
}

let env: BrokerEnv = browserEnv();

/** Test seam: replace parts of the environment. */
export function setMcpBrokerEnv(overrides: Partial<BrokerEnv>): void {
  env = { ...browserEnv(), ...overrides };
}

/* --------------------------------- state ---------------------------------- */

interface StoredResult {
  content: unknown[];
  structuredContent?: unknown;
}

interface CacheEntry {
  raw: StoredResult;
  storedAt: number;
  expiresAt: number;
}

interface Watch {
  watchId: string;
  ctx: BrokerContext;
  key: string;
  server: string;
  tool: string;
  input: unknown;
  staleTime: number;
  gcTime: number;
  refetchInterval: number | null;
  timer: unknown;
  /** A poll fell due while hidden; refetch once the page shows again. */
  catchUp: boolean;
  active: boolean;
}

interface ViewState {
  inflight: Map<string, AbortController>;
  watches: Map<string, Watch>;
  stopVisibility: (() => void) | null;
}

interface ToolInfoCache {
  at: number;
  servers: Map<string, Map<string, ToolInfo>>;
}

/** Cached results, keyed by artifact, viewer and the call's identity. */
const cache = new Map<string, CacheEntry>();
/** Executions in flight, by the same key, so identical calls share one. */
const executions = new Map<string, Promise<StoredResult>>();
/** Watches by cache key, across every view, for delivery. */
const watchers = new Map<string, Set<Watch>>();
/** One consent dialog per server key, however many calls wait on it. */
const consentInFlight = new Map<string, Promise<boolean>>();
/** The last `listTools` answer per artifact and viewer, for annotations. */
const toolInfo = new Map<string, ToolInfoCache>();
/** Decisions this session could not persist (see permissions/broker.ts). */
const remembered = new Map<string, string>();
const views = new WeakMap<BrokerContext, ViewState>();

/** Test seam: unit tests share a module registry, so they reset it. */
export function resetMcpBrokerState(): void {
  cache.clear();
  executions.clear();
  watchers.clear();
  consentInFlight.clear();
  toolInfo.clear();
  remembered.clear();
  env = browserEnv();
}

function viewState(ctx: BrokerContext): ViewState {
  let state = views.get(ctx);
  if (!state) {
    state = { inflight: new Map(), watches: new Map(), stopVisibility: null };
    views.set(ctx, state);
  }
  return state;
}

function scope(ctx: BrokerContext): string {
  return `${ctx.boot.artifactId}|${ctx.viewer.id}|`;
}

function cacheKey(ctx: BrokerContext, identity: string): string {
  return `${scope(ctx)}${identity}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* -------------------------------- manifest -------------------------------- */

export function manifestOf(ctx: BrokerContext): Manifest {
  return readManifest(ctx.boot.capabilities.mcp?.config);
}

/** The gate every call and watch passes: declared, then not a device server. */
function checkTarget(ctx: BrokerContext, server: string, tool: string): void {
  if (!inManifest(manifestOf(ctx), server, tool)) {
    throw mcpError("not_in_manifest", `${server}/${tool} is outside this artifact's manifest`, { server });
  }
  if (isHostServer(server)) {
    throw mcpError(
      "server_not_connected",
      `${server} is a server on the viewer's device; this surface has no host bridge`,
      { server },
    );
  }
}

/* --------------------------------- consent -------------------------------- */

function readStored(key: string): string | null {
  try {
    const stored = globalThis.localStorage?.getItem(key);
    if (stored !== undefined && stored !== null) return stored;
  } catch {
    /* falls through to what this session remembers */
  }
  return remembered.get(key) ?? null;
}

function writeStored(key: string, value: string): void {
  remembered.set(key, value);
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* private mode, or no storage at all: this session remembers it instead */
  }
}

/** The dialog the viewer reads; shared with `permissions.request("mcp:<server>")`. */
export function consentCopy(server: string, tools: readonly string[]): ConsentRequest {
  const list = tools.length > 0 ? tools.join(", ") : "its tools";
  return {
    title: `Let this artifact use ${server}?`,
    body: `This page wants to call ${list} on your "${server}" connector, on your behalf. It can do this whenever you use the page.`,
    confirmLabel: "Allow",
    cancelLabel: "Not now",
  };
}

const NOT_GRANTED = (server: string): McpError =>
  mcpError("not_granted", `the viewer has not allowed this artifact to use ${server}`, { server });

async function ensureConsent(ctx: BrokerContext, callId: string, server: string): Promise<void> {
  const key = serverConsentKey(ctx.boot.artifactId, server);
  const stored = readStored(key);
  if (stored === "granted") return;
  if (stored === "denied") throw NOT_GRANTED(server);

  // The frame's budget is extended while a viewer decides, and every call
  // that arrives meanwhile waits on the one dialog.
  ctx.ack(callId);
  let dialog = consentInFlight.get(key);
  if (!dialog) {
    const tools = manifestServer(manifestOf(ctx), server)?.tools ?? [];
    dialog = ctx
      .consent(consentCopy(server, tools))
      .then((granted) => {
        // A decision that landed meanwhile (the permissions dialog for the
        // same key) is the viewer's first answer; do not overwrite it.
        const raced = readStored(key);
        if (raced === "granted" || raced === "denied") return raced === "granted";
        writeStored(key, granted ? "granted" : "denied");
        return granted;
      })
      .finally(() => consentInFlight.delete(key));
    consentInFlight.set(key, dialog);
  }
  if (!(await dialog)) throw NOT_GRANTED(server);
}

/* --------------------------------- backend -------------------------------- */

const CANCELLED = (): McpError =>
  mcpError("cancelled", "the call was cancelled - the tool may still have run");

/** The failure a same-origin backend call turns into. */
async function backendError(response: Response): Promise<McpError> {
  let body: unknown = null;
  try {
    const text = await response.text();
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }
  if (isCapError(body)) return asMcpError(body);
  return mcpError("upstream_error", `the mcp backend answered ${response.status}`);
}

function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done(): void } {
  const controller = new AbortController();
  const timer = env.setTimer(() => controller.abort(), ms);
  const forward = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forward, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      env.clearTimer(timer);
      signal?.removeEventListener("abort", forward);
    },
  };
}

async function postJson(
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
  ms: number,
): Promise<Response> {
  const guard = withTimeout(signal, ms);
  try {
    return await env.fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: guard.signal,
    });
  } catch (err) {
    if (signal?.aborted) throw CANCELLED();
    if (guard.signal.aborted) {
      throw mcpError("server_unavailable", "the mcp backend did not answer in time");
    }
    throw mcpError("upstream_error", err instanceof Error ? err.message : String(err));
  } finally {
    guard.done();
  }
}

interface ServersReply {
  servers: Array<{ server: string; authStatus: string; tools: ToolInfo[] }>;
}

/** `POST /api/frame/mcp/servers`: the manifest intersected with what is connected. */
async function fetchServers(ctx: BrokerContext, signal?: AbortSignal): Promise<ServersReply> {
  const response = await postJson(
    "/api/frame/mcp/servers",
    { artifactId: ctx.boot.artifactId },
    signal,
    SERVERS_TIMEOUT_MS,
  );
  if (!response.ok) throw await backendError(response);
  const body: unknown = await response.json().catch(() => null);
  const rows = isRecord(body) && Array.isArray(body.servers) ? body.servers : [];
  const servers: ServersReply["servers"] = [];
  const info: ToolInfoCache = { at: env.now(), servers: new Map() };
  for (const row of rows) {
    if (!isRecord(row) || typeof row.server !== "string") continue;
    const tools = Array.isArray(row.tools)
      ? row.tools.map(readToolInfo).filter((tool): tool is ToolInfo => tool !== null)
      : [];
    servers.push({
      server: row.server,
      authStatus: typeof row.authStatus === "string" ? row.authStatus : "unknown",
      tools,
    });
    info.servers.set(row.server, new Map(tools.map((tool) => [tool.name, tool])));
  }
  toolInfo.set(scope(ctx), info);
  return { servers };
}

/**
 * The connector's own description of a tool, for the caching default. A
 * recent `listTools` answers from memory; otherwise one is fetched. A server
 * the backend does not list is not connected for this viewer.
 */
async function annotationsFor(
  ctx: BrokerContext,
  server: string,
  tool: string,
  signal: AbortSignal,
): Promise<ToolAnnotations | undefined> {
  let info = toolInfo.get(scope(ctx));
  if (!info || env.now() - info.at > TOOL_INFO_TTL_MS) {
    await fetchServers(ctx, signal);
    info = toolInfo.get(scope(ctx));
  }
  const tools = info?.servers.get(server);
  if (!tools) {
    throw mcpError("server_not_connected", `no connector named ${server} is available to this viewer`, {
      server,
    });
  }
  return tools.get(tool)?.annotations;
}

/** `POST /api/frame/mcp/call`: one execution upstream. */
async function callBackend(
  ctx: BrokerContext,
  server: string,
  tool: string,
  input: unknown,
  signal: AbortSignal | undefined,
): Promise<{ raw: StoredResult; isError: boolean; noStore: boolean }> {
  const response = await postJson(
    "/api/frame/mcp/call",
    { artifactId: ctx.boot.artifactId, server, tool, input },
    signal,
    CALL_TIMEOUT_MS,
  );
  if (!response.ok) throw await backendError(response);
  const body: unknown = await response.json().catch(() => null);
  const result = isRecord(body) && isRecord(body.result) ? body.result : null;
  if (!result) throw mcpError("upstream_error", "the mcp backend answered without a result", { server });
  // Only the shell stamps `cache`; whatever came from upstream is dropped.
  const raw: StoredResult = { content: Array.isArray(result.content) ? result.content : [] };
  if (result.structuredContent !== undefined) raw.structuredContent = result.structuredContent;
  return {
    raw,
    isError: result.isError === true,
    noStore: response.headers.get("x-frame-mcp-no-store") === "1",
  };
}

/* ---------------------------------- cache --------------------------------- */

function cacheGet(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= env.now()) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function cacheSet(key: string, entry: CacheEntry): void {
  const now = env.now();
  for (const [k, held] of cache) {
    if (held.expiresAt <= now) cache.delete(k);
  }
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function withMarker(raw: StoredResult, marker: CacheMarker): Record<string, unknown> {
  return { ...raw, cache: marker };
}

function asWire(raw: StoredResult, isError: boolean): Record<string, unknown> {
  return isError ? { ...raw, isError: true } : { ...raw };
}

/**
 * Execute a call, sharing one flight with every identical cached call in
 * progress, storing a successful result when asked to and feeding the
 * watchers of the identity. `signal` cancels this caller's wait; a shared
 * flight runs on for the others.
 */
async function execute(
  ctx: BrokerContext,
  key: string,
  server: string,
  tool: string,
  input: unknown,
  policy: { write: boolean; gcTime: number },
  signal: AbortSignal | undefined,
  origin: Watch | null,
): Promise<Record<string, unknown>> {
  let flight = policy.write ? executions.get(key) : undefined;
  let fresh: Promise<{ raw: StoredResult; isError: boolean }> | null = null;
  if (!flight) {
    const run = callBackend(ctx, server, tool, input, policy.write ? undefined : signal).then(
      ({ raw, isError, noStore }) => {
        if (policy.write && !noStore && !isError) {
          const storedAt = env.now();
          cacheSet(key, { raw, storedAt, expiresAt: storedAt + policy.gcTime });
          notifyWatchers(key, raw, storedAt, origin);
        }
        return { raw, isError };
      },
    );
    if (policy.write) {
      flight = run.then((outcome) => {
        if (outcome.isError) throw mcpError("tool_error", "the tool reported an error", { server });
        return outcome.raw;
      });
      executions.set(key, flight);
      // A shared flight's rejection reaches its own callers; the cleanup must
      // not turn it into an unhandled rejection of its own.
      const cleanup = (): void => {
        if (executions.get(key) === flight) executions.delete(key);
      };
      flight.then(cleanup, cleanup);
    }
    fresh = run;
  }
  const outcome = fresh ?? (flight as Promise<StoredResult>).then((raw) => ({ raw, isError: false }));
  const settled = await raceWithSignal(outcome, signal);
  return asWire(settled.raw, settled.isError);
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(CANCELLED());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/* --------------------------------- watches -------------------------------- */

function pushWatch(watch: Watch, ev: Record<string, unknown>): void {
  if (!watch.active) return;
  watch.ctx.toFrame({ __frame_mcp_watch: true, watchId: watch.watchId, ev });
}

/** A stored result reached every watcher of its identity (but the one that fetched it). */
function notifyWatchers(key: string, raw: StoredResult, storedAt: number, except: Watch | null): void {
  const set = watchers.get(key);
  if (!set) return;
  for (const watch of set) {
    if (watch === except) continue;
    pushWatch(watch, {
      type: "data",
      result: withMarker(raw, { storedAt, revalidating: false }),
      server: watch.server,
    });
  }
}

/** Execute for one watch: its own delivery is fresh, everyone else's is the stored copy. */
async function refresh(watch: Watch): Promise<void> {
  try {
    const result = await execute(
      watch.ctx,
      watch.key,
      watch.server,
      watch.tool,
      watch.input,
      { write: true, gcTime: watch.gcTime },
      undefined,
      watch,
    );
    if (result.isError === true) {
      pushWatch(watch, {
        type: "error",
        error: mcpError("tool_error", "the tool reported an error", { server: watch.server, result }),
      });
      return;
    }
    pushWatch(watch, { type: "data", result, server: watch.server });
  } catch (err) {
    pushWatch(watch, { type: "error", error: asMcpError(err) });
  }
}

function armPoll(watch: Watch): void {
  if (watch.refetchInterval === null || !watch.active) return;
  watch.timer = env.setTimer(() => {
    watch.timer = null;
    if (!watch.active) return;
    if (env.hidden()) {
      // Paused while hidden; the catch-up refetch runs when the page shows.
      watch.catchUp = true;
    } else {
      void refresh(watch);
      armPoll(watch);
    }
  }, watch.refetchInterval);
}

function onVisible(state: ViewState): void {
  for (const watch of state.watches.values()) {
    if (!watch.catchUp) continue;
    watch.catchUp = false;
    void refresh(watch);
    armPoll(watch);
  }
}

/** The first delivery: replay what is stored, then refresh if that was stale. */
function startWatch(watch: Watch): void {
  if (!watch.active) return;
  const hit = cacheGet(watch.key);
  const stale = !hit || env.now() - hit.storedAt >= watch.staleTime;
  if (hit) {
    pushWatch(watch, {
      type: "data",
      result: withMarker(hit.raw, { storedAt: hit.storedAt, revalidating: stale }),
      server: watch.server,
    });
  }
  if (stale) void refresh(watch);
  armPoll(watch);
}

function removeWatch(state: ViewState, watch: Watch): void {
  watch.active = false;
  if (watch.timer !== null) {
    env.clearTimer(watch.timer);
    watch.timer = null;
  }
  state.watches.delete(watch.watchId);
  const set = watchers.get(watch.key);
  if (set) {
    set.delete(watch);
    if (set.size === 0) watchers.delete(watch.key);
  }
  if (state.watches.size === 0 && state.stopVisibility) {
    state.stopVisibility();
    state.stopVisibility = null;
  }
}

/* --------------------------------- handlers ------------------------------- */

function readOptions(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw badRequest("options must be an object");
  return raw;
}

async function handleListTools(ctx: BrokerContext): Promise<unknown> {
  const { servers } = await fetchServers(ctx);
  return servers.filter((row) => !isHostServer(row.server));
}

async function handleCallTool(call: BrokerCall, ctx: BrokerContext): Promise<unknown> {
  const [server, tool, input, rawOptions] = call.args;
  const args = validateCallArgs(server, tool, input);
  const options = readOptions(rawOptions);
  const cacheOption = readCacheOption(options.cache, "call");
  checkTarget(ctx, args.server, args.tool);

  const state = viewState(ctx);
  const controller = new AbortController();
  state.inflight.set(call.id, controller);
  try {
    await ensureConsent(ctx, call.id, args.server);
    if (controller.signal.aborted) throw CANCELLED();

    const annotations = await annotationsFor(ctx, args.server, args.tool, controller.signal);
    const policy = resolveCachePolicy(cacheOption, annotations?.readOnlyHint);
    const key = cacheKey(ctx, callIdentity(args.server, args.tool, args.input));

    if (policy.read) {
      const hit = cacheGet(key);
      if (hit && env.now() - hit.storedAt < policy.staleTime) {
        return withMarker(hit.raw, { storedAt: hit.storedAt, revalidating: false });
      }
    }
    if (controller.signal.aborted) throw CANCELLED();
    return await execute(ctx, key, args.server, args.tool, args.input, policy, controller.signal, null);
  } finally {
    state.inflight.delete(call.id);
  }
}

function handleCancel(call: BrokerCall, ctx: BrokerContext): unknown {
  const callId = call.args[0];
  if (typeof callId !== "string") throw badRequest("cancelCall takes a call id");
  viewState(ctx).inflight.get(callId)?.abort();
  return { ok: true };
}

async function handleWatchTool(call: BrokerCall, ctx: BrokerContext): Promise<unknown> {
  const [server, tool, input, rawOptions] = call.args;
  const args = validateCallArgs(server, tool, input);
  const options = readOptions(rawOptions);
  const watchId = options.watchId;
  if (typeof watchId !== "string" || watchId.length === 0 || watchId.length > 64) {
    throw badRequest("watchTool needs a watch id");
  }
  const cacheOption = readCacheOption(options.cache, "watch");
  if (cacheOption === false) throw badRequest("a watch cannot opt out of the cache");
  const refetchInterval = readRefetchInterval(options.refetchInterval);
  checkTarget(ctx, args.server, args.tool);

  const state = viewState(ctx);
  if (state.watches.has(watchId)) throw badRequest(`watch ${watchId} is already registered`);
  if (state.watches.size >= MAX_WATCHES) {
    throw badRequest(`at most ${MAX_WATCHES} watches per view - unsubscribe unused watches`);
  }

  await ensureConsent(ctx, call.id, args.server);
  const annotations = await annotationsFor(ctx, args.server, args.tool, new AbortController().signal);
  if (annotations?.readOnlyHint === false) {
    throw badRequest(`watchTool watches reads only; ${args.tool} declares readOnlyHint: false`);
  }
  // Re-check after the awaits: the view may have filled up meanwhile.
  if (state.watches.has(watchId)) throw badRequest(`watch ${watchId} is already registered`);
  if (state.watches.size >= MAX_WATCHES) {
    throw badRequest(`at most ${MAX_WATCHES} watches per view - unsubscribe unused watches`);
  }

  const staleTime = Math.max(0, Math.min(cacheOption?.staleTime ?? 0, MAX_STALE_TIME_MS));
  const requestedGc = cacheOption?.gcTime;
  const gcTime =
    requestedGc === undefined || requestedGc <= 0 ? DEFAULT_GC_TIME_MS : Math.min(requestedGc, MAX_GC_TIME_MS);
  const key = cacheKey(ctx, callIdentity(args.server, args.tool, args.input));
  const watch: Watch = {
    watchId,
    ctx,
    key,
    server: args.server,
    tool: args.tool,
    input: args.input,
    staleTime,
    gcTime,
    refetchInterval,
    timer: null,
    catchUp: false,
    active: true,
  };
  state.watches.set(watchId, watch);
  let set = watchers.get(key);
  if (!set) {
    set = new Set();
    watchers.set(key, set);
  }
  set.add(watch);
  if (!state.stopVisibility) state.stopVisibility = env.onVisible(() => onVisible(state));

  // The registration reply goes first; the replay follows a turn later.
  env.defer(() => startWatch(watch));
  return { ok: true };
}

function handleUnwatch(call: BrokerCall, ctx: BrokerContext): unknown {
  const watchId = call.args[0];
  if (typeof watchId !== "string") throw badRequest("unwatchTool takes a watch id");
  const state = viewState(ctx);
  const watch = state.watches.get(watchId);
  if (watch) removeWatch(state, watch);
  return { ok: true };
}

async function handleInvalidate(call: BrokerCall, ctx: BrokerContext): Promise<unknown> {
  const [server, tool, input] = call.args;
  const hasServer = call.args.length >= 1 && server !== undefined && server !== null;
  const hasTool = call.args.length >= 2 && tool !== undefined && tool !== null;
  const hasInput = call.args.length >= 3;
  let prefix = scope(ctx);
  let exact: string | null = null;
  if (hasServer) {
    if (typeof server !== "string" || server.length === 0) throw badRequest("server must be a string");
    prefix += `${server}${IDENTITY_SEPARATOR}`;
  }
  if (hasTool) {
    if (!hasServer) throw badRequest("invalidate(tool) needs the server too");
    if (typeof tool !== "string" || tool.length === 0) throw badRequest("tool must be a string");
    prefix += `${tool}${IDENTITY_SEPARATOR}`;
  }
  if (hasInput) {
    if (!hasServer || !hasTool) throw badRequest("invalidate(input) needs the server and tool too");
    const checked = validateCallArgs(server, tool, input);
    exact = cacheKey(ctx, callIdentity(checked.server, checked.tool, checked.input));
  }
  const matches = (key: string): boolean => (exact !== null ? key === exact : key.startsWith(prefix));

  for (const key of [...cache.keys()]) {
    if (matches(key)) cache.delete(key);
  }
  // Every watched identity in scope re-executes and delivers, in any view.
  for (const [key, set] of watchers) {
    if (!matches(key)) continue;
    for (const watch of set) void refresh(watch);
  }
  return undefined;
}

export async function handle(call: BrokerCall, ctx: BrokerContext): Promise<unknown> {
  switch (call.method) {
    case "listTools":
      return handleListTools(ctx);
    case "callTool":
      return handleCallTool(call, ctx);
    case "cancelCall":
      return handleCancel(call, ctx);
    case "watchTool":
      return handleWatchTool(call, ctx);
    case "unwatchTool":
      return handleUnwatch(call, ctx);
    case "invalidate":
      return handleInvalidate(call, ctx);
    default:
      // mcp.d.ts: an unknown method on a shell reads `bad_request`.
      throw badRequest(`unknown method mcp.${call.method}`);
  }
}

/** A remounted view loses its window: every call and watch it held is over. */
export function dispose(ctx: BrokerContext): void {
  const state = views.get(ctx);
  if (!state) return;
  for (const controller of state.inflight.values()) controller.abort();
  state.inflight.clear();
  for (const watch of [...state.watches.values()]) removeWatch(state, watch);
  views.delete(ctx);
}
