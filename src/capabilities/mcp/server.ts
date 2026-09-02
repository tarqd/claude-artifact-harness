/**
 * `mcp` backend on the shell origin: the two lanes the shell's broker calls.
 *
 *   POST /api/frame/mcp/servers  {artifactId}                  -> {servers: [...]}
 *   POST /api/frame/mcp/call     {artifactId, server, tool, input} -> {result}
 *
 * Everything the page API promises is re-checked here — this route, not the
 * shell page, is what a direct HTTP caller meets: the request must come from
 * the shell origin itself (consent lives there, and a connector call has
 * side effects), it must carry a viewer session already (nothing is minted
 * here: the connector spends the operator's credential), the artifact must
 * declare `mcp`, the `(server, tool)` must be in its manifest, `host:`
 * servers are never run by a service, the viewer must be able to interact,
 * and the connector comes from the directory (`directory.ts`), never from
 * the request. Results go back as the connector produced them plus the one
 * header the broker reads, `X-Frame-Mcp-No-Store`.
 */
import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { capError, type CapError } from "../../protocol/errors.ts";
import { isArtifactId } from "../../protocol/paths.ts";
import type { Viewer } from "../../server/auth.ts";
import type { ArtifactMeta } from "../../server/store.ts";
import type { ServerApps, ServerContext } from "../../server/types.ts";
import { createClientPool } from "./client.ts";
import { selectDirectory, type ConnectorDirectory } from "./directory.ts";
import {
  inManifest,
  isHostServer,
  isMcpErrorCode,
  isName,
  isPlainJson,
  mcpError,
  readManifest,
  utf8Bytes,
  MAX_INPUT_BYTES,
  type Manifest,
  type McpError,
  type ToolInfo,
} from "./protocol.ts";

/** Largest request body: an input under the 256 KiB cap plus its envelope. */
const MAX_BODY_BYTES = 512 * 1024;
/** Largest result forwarded to the shell; a connector past this is broken or hostile. */
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
/** Calls one viewer may have running at once, across every tab they have. */
const MAX_CALLS_PER_VIEWER = 8;
/** Calls and listings in flight at once, server-wide, whoever asks. */
const MAX_CALLS_TOTAL = 64;
const SERVERS_TIMEOUT_MS = 65_000;
const CALL_TIMEOUT_MS = 120_000;

type FailStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 502 | 503;

class Refusal extends Error {
  constructor(
    readonly status: FailStatus,
    readonly error: CapError,
  ) {
    super(error.message);
  }
}

function refuse(status: FailStatus, code: string, message: string): never {
  throw new Refusal(status, capError(code, message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The HTTP status a page error travels under. The body carries the code. */
function statusFor(error: McpError): FailStatus {
  switch (error.code) {
    case "bad_request":
    case "not_in_manifest":
    case "cancelled":
      return 400;
    case "needs_reauth":
      return 401;
    case "not_granted":
    case "blocked_by_policy":
    case "approval_required":
      return 403;
    case "server_not_connected":
    case "server_not_found":
      return 404;
    case "rate_limited":
      return 429;
    case "server_unavailable":
      return 503;
    case "upstream_error":
    case "tool_error":
      return 502;
    default:
      return 500;
  }
}

/**
 * Only the shell page, and only a browser it has already seated, may call
 * these lanes; the viewer it carries is the answer. A connector call has
 * side effects and the viewer's consent is kept in the shell page alone, so
 * a request from any other site — which the browser would otherwise send as
 * a "simple" cross-site POST, with the cookie under `SameSite=Lax` left
 * off but the effect still happening — is refused. So is one with no viewer
 * cookie of ours: a connector runs on the operator's credential, which every
 * viewer shares, and `auth.viewer()` would mint an identity for whoever
 * asked and hand it the default level, turning a published manifest into a
 * public API onto the connector. Both run before the body is read, so a
 * caller with no session never gets half a megabyte buffered for it.
 */
function fromShellSession(c: Context, ctx: ServerContext): Viewer {
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    refuse(415, "bad_request", "the body must be application/json");
  }
  const site = c.req.header("sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    refuse(403, "not_granted", "connector calls are only accepted from the shell page");
  }
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== ctx.shellOrigin) {
    refuse(403, "not_granted", "connector calls are only accepted from the shell page");
  }
  const viewer = ctx.auth.existingViewer(c);
  if (!viewer) {
    refuse(403, "not_granted", "connector calls need a viewer session; open the artifact page first");
  }
  return viewer;
}

/**
 * Read the body with a running byte cap: a request that declares no length
 * (chunked) or lies about it is refused as soon as it crosses the cap, never
 * after it has been buffered whole.
 */
async function readBody(c: Context): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    refuse(413, "too_large", "the request body is too large");
  }
  let bytes: Uint8Array;
  const stream = c.req.raw.body;
  if (!stream) {
    bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) refuse(413, "too_large", "the request body is too large");
  } else {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          refuse(413, "too_large", "the request body is too large");
        }
        chunks.push(value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released by cancel() */
      }
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    refuse(400, "bad_request", "bad request body");
  }
  if (!isRecord(parsed)) refuse(400, "bad_request", "bad request body");
  return parsed as Record<string, unknown>;
}

interface Gate {
  meta: ArtifactMeta;
  manifest: Manifest;
  viewerId: string;
}

/** Resolve the artifact and its manifest for an already-seated viewer, or refuse. */
async function gate(ctx: ServerContext, viewer: Viewer, body: Record<string, unknown>): Promise<Gate> {
  const artifactId = body.artifactId;
  if (typeof artifactId !== "string" || !isArtifactId(artifactId)) {
    refuse(400, "bad_request", "bad artifact id");
  }
  const meta = await ctx.store.readMeta(artifactId);
  if (!meta) refuse(404, "not_declared", "no such artifact");
  const declared = meta.capabilities.mcp;
  if (!declared) refuse(400, "not_declared", "this artifact does not declare mcp");
  const level = ctx.auth.levelFor(viewer, meta);
  if (level === "view") refuse(403, "not_granted", "this viewer may not use connectors here");
  return { meta, manifest: readManifest(declared.config), viewerId: viewer.id };
}

/** A signal that fires when the client goes away or the budget runs out. */
function budget(c: Context, ms: number): { signal: AbortSignal; done(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onClose = (): void => controller.abort();
  c.req.raw.signal.addEventListener("abort", onClose, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      c.req.raw.signal.removeEventListener("abort", onClose);
    },
  };
}

/** Whatever a connector threw, as a page error in the closed vocabulary. */
function asPageError(err: unknown, server: string): McpError {
  if (isRecord(err) && isMcpErrorCode(err.code) && typeof err.message === "string") {
    return mcpError(err.code, err.message, {
      server: typeof err.server === "string" ? err.server : server,
      ...(typeof err.retryAfterMs === "number" ? { retryAfterMs: err.retryAfterMs } : {}),
      ...(err.result !== undefined ? { result: err.result } : {}),
    });
  }
  return mcpError("upstream_error", err instanceof Error ? err.message : String(err), { server });
}

/** The upstream auth vocabulary for a `listTools` that failed on one server. */
function statusOfFailure(err: unknown): string {
  return isRecord(err) && err.code === "needs_reauth" ? "auth_required" : "unknown";
}

/** In-flight accounting: one slot per request, per viewer and server-wide. */
class Slots {
  private total = 0;
  private readonly perViewer = new Map<string, number>();

  take(viewerId: string, countViewer: boolean): (() => void) | null {
    const held = this.perViewer.get(viewerId) ?? 0;
    if (this.total >= MAX_CALLS_TOTAL) return null;
    if (countViewer && held >= MAX_CALLS_PER_VIEWER) return null;
    this.total++;
    if (countViewer) this.perViewer.set(viewerId, held + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      if (!countViewer) return;
      const now = this.perViewer.get(viewerId) ?? 1;
      if (now <= 1) this.perViewer.delete(viewerId);
      else this.perViewer.set(viewerId, now - 1);
    };
  }
}

export function routes(apps: ServerApps, ctx: ServerContext): void {
  // Built at boot so a misconfigured `MCP_SERVERS` fails the server start
  // rather than every request; latched shut on shutdown so a late request
  // cannot open upstream clients nothing will close.
  const directory: ConnectorDirectory = selectDirectory(() => createClientPool());
  let closed = false;
  ctx.onShutdown(async () => {
    closed = true;
    await directory.close();
  });
  const directoryOf = (): ConnectorDirectory => {
    if (closed) refuse(503, "server_unavailable", "this server is shutting down");
    return directory;
  };
  const slots = new Slots();
  const busy = (c: Context, server?: string): Response =>
    c.json(
      mcpError("rate_limited", "too many connector calls at once", {
        ...(server ? { server } : {}),
        retryAfterMs: 2_000,
      }),
      429,
    );

  apps.shell.post("/api/frame/mcp/servers", async (c) => {
    let resolved: Gate;
    let dir: ConnectorDirectory;
    try {
      const viewer = fromShellSession(c, ctx);
      resolved = await gate(ctx, viewer, await readBody(c));
      dir = directoryOf();
    } catch (err) {
      if (err instanceof Refusal) return c.json(err.error, err.status);
      throw err;
    }
    const release = slots.take(resolved.viewerId, false);
    if (!release) return busy(c);
    const guard = budget(c, SERVERS_TIMEOUT_MS);
    try {
      const rows = await Promise.all(
        resolved.manifest.servers
          .filter((entry) => !isHostServer(entry.server))
          .map(async (entry) => {
            try {
              const handle = await dir.resolve(resolved.viewerId, entry.server);
              if (!handle) return null;
              const listed = await handle.listTools(guard.signal);
              const allowed = new Set(entry.tools);
              const tools: ToolInfo[] = listed.tools.filter((tool) => allowed.has(tool.name));
              return { server: entry.server, authStatus: listed.authStatus, tools };
            } catch (err) {
              return { server: entry.server, authStatus: statusOfFailure(err), tools: [] };
            }
          }),
      );
      return c.json({ servers: rows.filter((row) => row !== null) });
    } finally {
      guard.done();
      release();
    }
  });

  apps.shell.post("/api/frame/mcp/call", async (c) => {
    let plan: {
      gate: Gate;
      server: string;
      tool: string;
      input: Record<string, unknown>;
      dir: ConnectorDirectory;
    };
    try {
      const viewer = fromShellSession(c, ctx);
      const body = await readBody(c);
      const resolved = await gate(ctx, viewer, body);
      const { server, tool } = body;
      if (!isName(server)) refuse(400, "bad_request", "server must be a connector's display name");
      if (!isName(tool)) refuse(400, "bad_request", "tool must be a tool name");
      if (!inManifest(resolved.manifest, server, tool)) {
        refuse(400, "not_in_manifest", `${server}/${tool} is outside this artifact's manifest`);
      }
      if (isHostServer(server)) {
        refuse(404, "server_not_connected", `${server} runs on the viewer's device; a service never runs it`);
      }
      const raw = body.input === undefined || body.input === null ? {} : body.input;
      if (!isRecord(raw) || !isPlainJson(raw)) {
        refuse(400, "bad_request", "input must be a plain JSON object of tool arguments");
      }
      if (utf8Bytes(JSON.stringify(raw)) > MAX_INPUT_BYTES) {
        refuse(400, "bad_request", "input is over the 256 KiB limit");
      }
      plan = { gate: resolved, server, tool, input: raw, dir: directoryOf() };
    } catch (err) {
      if (err instanceof Refusal) return c.json(err.error, err.status);
      throw err;
    }

    const { gate: resolved, server, tool, input, dir } = plan;
    let handle;
    try {
      handle = await dir.resolve(resolved.viewerId, server);
    } catch (err) {
      const error = asPageError(err, server);
      return c.json(error, statusFor(error) as StatusCode as 400);
    }
    if (!handle) {
      const error = mcpError("server_not_connected", `no connector named ${server} is available`, { server });
      return c.json(error, 404);
    }

    const release = slots.take(resolved.viewerId, true);
    if (!release) return busy(c, server);
    const guard = budget(c, CALL_TIMEOUT_MS);
    try {
      const result = await handle.callTool(tool, input, guard.signal);
      const encoded = JSON.stringify({ result });
      if (encoded.length > MAX_RESULT_BYTES) {
        const error = mcpError("upstream_error", `${server} answered with a result over 4 MB`, { server });
        return c.json(error, 502);
      }
      if (handle.noStore) c.header("x-frame-mcp-no-store", "1");
      c.header("content-type", "application/json; charset=UTF-8");
      return c.body(encoded, 200);
    } catch (err) {
      const error = asPageError(err, server);
      if (guard.signal.aborted && error.code !== "cancelled") {
        return c.json(mcpError("server_unavailable", `${server} did not answer in time`, { server }), 503);
      }
      return c.json(error, statusFor(error) as StatusCode as 400);
    } finally {
      guard.done();
      release();
    }
  });
}
