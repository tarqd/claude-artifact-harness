/**
 * `mcp` backend on the shell origin: the two lanes the shell's broker calls.
 *
 *   POST /api/frame/mcp/servers  {artifactId}                  -> {servers: [...]}
 *   POST /api/frame/mcp/call     {artifactId, server, tool, input} -> {result}
 *
 * Everything the page API promises is re-checked here — this route, not the
 * shell page, is what a direct HTTP caller meets: the artifact must declare
 * `mcp`, the `(server, tool)` must be in its manifest, `host:` servers are
 * never run by a service, the viewer must be able to interact, and the
 * connector comes from the directory (`directory.ts`), never from the
 * request. Results go back as the connector produced them plus the one
 * header the broker reads, `X-Frame-Mcp-No-Store`.
 */
import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { capError, type CapError } from "../../protocol/errors.ts";
import { isArtifactId } from "../../protocol/paths.ts";
import type { ArtifactMeta } from "../../server/store.ts";
import type { ServerApps, ServerContext } from "../../server/types.ts";
import { createClientPool } from "./client.ts";
import { isMcpErrorLike, selectDirectory, type ConnectorDirectory } from "./directory.ts";
import {
  inManifest,
  isHostServer,
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
/** Calls one viewer may have running at once, across every tab they have. */
const MAX_CALLS_PER_VIEWER = 8;
const SERVERS_TIMEOUT_MS = 65_000;
const CALL_TIMEOUT_MS = 120_000;

type FailStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503;

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

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    refuse(413, "too_large", "the request body is too large");
  }
  const raw = await c.req.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) refuse(413, "too_large", "the request body is too large");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw) as unknown;
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

/** Resolve the artifact, its manifest and the asking viewer, or refuse. */
async function gate(c: Context, ctx: ServerContext, body: Record<string, unknown>): Promise<Gate> {
  const artifactId = body.artifactId;
  if (typeof artifactId !== "string" || !isArtifactId(artifactId)) {
    refuse(400, "bad_request", "bad artifact id");
  }
  const meta = await ctx.store.readMeta(artifactId);
  if (!meta) refuse(404, "not_declared", "no such artifact");
  const declared = meta.capabilities.mcp;
  if (!declared) refuse(400, "not_declared", "this artifact does not declare mcp");
  const viewer = ctx.auth.viewer(c);
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

/** The upstream auth vocabulary for a `listTools` that failed on one server. */
function statusOfFailure(err: unknown): string {
  if (isMcpErrorLike(err) && err.code === "needs_reauth") return "auth_required";
  return "unknown";
}

export function routes(apps: ServerApps, ctx: ServerContext): void {
  // Built on first use so a test can set `MCP_BACKEND` before the first
  // request rather than before the server starts.
  let directory: ConnectorDirectory | null = null;
  const directoryOf = (): ConnectorDirectory => {
    if (!directory) directory = selectDirectory(() => createClientPool());
    return directory;
  };
  ctx.onShutdown(async () => {
    const held = directory;
    directory = null;
    if (held) await held.close();
  });

  const running = new Map<string, number>();

  apps.shell.post("/api/frame/mcp/servers", async (c) => {
    let resolved: Gate;
    try {
      resolved = await gate(c, ctx, await readBody(c));
    } catch (err) {
      if (err instanceof Refusal) return c.json(err.error, err.status);
      throw err;
    }
    const dir = directoryOf();
    const guard = budget(c, SERVERS_TIMEOUT_MS);
    try {
      const rows = await Promise.all(
        resolved.manifest.servers
          .filter((entry) => !isHostServer(entry.server))
          .map(async (entry) => {
            const handle = await dir.resolve(resolved.viewerId, entry.server);
            if (!handle) return null;
            try {
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
    }
  });

  apps.shell.post("/api/frame/mcp/call", async (c) => {
    let plan: { gate: Gate; server: string; tool: string; input: Record<string, unknown> };
    try {
      const body = await readBody(c);
      const resolved = await gate(c, ctx, body);
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
      plan = { gate: resolved, server, tool, input: raw };
    } catch (err) {
      if (err instanceof Refusal) return c.json(err.error, err.status);
      throw err;
    }

    const { gate: resolved, server, tool, input } = plan;
    const dir = directoryOf();
    const handle = await dir.resolve(resolved.viewerId, server);
    if (!handle) {
      const error = mcpError("server_not_connected", `no connector named ${server} is available`, { server });
      return c.json(error, 404);
    }

    const held = running.get(resolved.viewerId) ?? 0;
    if (held >= MAX_CALLS_PER_VIEWER) {
      const error = mcpError("rate_limited", "too many connector calls at once", { server, retryAfterMs: 2_000 });
      return c.json(error, 429);
    }
    running.set(resolved.viewerId, held + 1);
    const guard = budget(c, CALL_TIMEOUT_MS);
    try {
      const result = await handle.callTool(tool, input, guard.signal);
      if (handle.noStore) c.header("x-frame-mcp-no-store", "1");
      return c.json({ result });
    } catch (err) {
      const error: McpError = isMcpErrorLike(err)
        ? { ...err, server: err.server ?? server }
        : mcpError("upstream_error", err instanceof Error ? err.message : String(err), { server });
      if (guard.signal.aborted && error.code !== "cancelled") {
        return c.json(mcpError("server_unavailable", `${server} did not answer in time`, { server }), 503);
      }
      return c.json(error, statusFor(error) as StatusCode as 400);
    } finally {
      guard.done();
      const now = running.get(resolved.viewerId) ?? 1;
      if (now <= 1) running.delete(resolved.viewerId);
      else running.set(resolved.viewerId, now - 1);
    }
  });
}
