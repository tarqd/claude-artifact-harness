/**
 * What the frame, the shell and the server must agree on for `mcp`: the
 * manifest grammar, the error vocabulary, the caching policy, the call
 * identity a cache entry is keyed by, and the shape of a tool result
 * (reference/contract/0.2.32/mcp.d.ts; docs/surface-area.md §5.8).
 *
 * Browser-safe on purpose: the frame module and the shell bundle import it,
 * so nothing here may touch Node.
 */
import { isCapError, type CapError } from "../../protocol/errors.ts";

export const CAP = "mcp";

/* --------------------------------- limits -------------------------------- */

/** Watches one view may hold at once (mcp.d.ts `bad_request`). */
export const MAX_WATCHES = 64;
/** `staleTime` is capped so revoked access stops answering within this. */
export const MAX_STALE_TIME_MS = 300_000;
export const DEFAULT_GC_TIME_MS = 300_000;
export const MAX_GC_TIME_MS = 86_400_000;
/** `refetchInterval` is clamped up to this floor (mcp.d.ts `watchTool`). */
export const MIN_REFETCH_INTERVAL_MS = 30_000;
/** `retryAfterMs` is shell-clamped at this. */
export const MAX_RETRY_AFTER_MS = 60_000;
/** A server or tool name on the wire. */
export const MAX_NAME_LENGTH = 256;
/** Serialized tool input (the platform validates args at 280 KiB). */
export const MAX_INPUT_BYTES = 262_144;
/** Nesting the input may have (docs/analysis/shell.md §5). */
export const MAX_INPUT_DEPTH = 40;
/** The platform's `capBudgets.mcp[method]` is clamped to this before +2 s. */
export const MAX_BUDGET_MS = 600_000;
export const BUDGET_GRACE_MS = 2_000;
export const DEFAULT_BUDGET_MS = 130_000;

/* --------------------------------- errors -------------------------------- */

export const MCP_ERROR_CODES = [
  "needs_reauth",
  "server_not_connected",
  "selection_required",
  "server_not_found",
  "server_unavailable",
  "not_in_manifest",
  "blocked_by_policy",
  "approval_required",
  "tool_error",
  "bad_request",
  "cancelled",
  "rate_limited",
  "upstream_error",
  "not_granted",
  "capability_disabled",
  "capability_removed",
  "transform_error",
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export function isMcpErrorCode(v: unknown): v is McpErrorCode {
  return typeof v === "string" && (MCP_ERROR_CODES as readonly string[]).includes(v);
}

export interface McpError extends CapError {
  code: McpErrorCode;
  server?: string;
  retryable?: true;
  retryAfterMs?: number;
  result?: unknown;
}

/** Codes the layer producing them stamps `retryable: true` on. */
const RETRYABLE: ReadonlySet<string> = new Set(["server_unavailable", "rate_limited"]);

/**
 * Build a wire error. `retryable` is stamped only as `true` and only for the
 * codes that mean "try once more unattended"; `retryAfterMs` is clamped.
 */
export function mcpError(
  code: McpErrorCode,
  message: string,
  extra: { server?: string; retryAfterMs?: number; result?: unknown } = {},
): McpError {
  const out: McpError = { code, message };
  if (typeof extra.server === "string") out.server = extra.server;
  if (RETRYABLE.has(code)) out.retryable = true;
  if (typeof extra.retryAfterMs === "number" && Number.isFinite(extra.retryAfterMs)) {
    out.retryAfterMs = Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Math.round(extra.retryAfterMs)));
  }
  if (extra.result !== undefined) out.result = extra.result;
  return out;
}

export const badRequest = (message: string): McpError => mcpError("bad_request", message);

/**
 * Anything that reached us as an error, in the vocabulary a page may branch
 * on: a known code is kept with its documented extras, `invalid_content`
 * (the RPC client refusing to clone arguments) is a caller bug, and an
 * unknown code is `upstream_error` — exactly the rule mcp.d.ts gives pages.
 */
export function asMcpError(err: unknown): McpError {
  if (!isCapError(err)) {
    return mcpError("upstream_error", err instanceof Error ? err.message : String(err));
  }
  if (isMcpErrorCode(err.code)) {
    const out = mcpError(err.code, err.message, {
      ...(typeof err.server === "string" ? { server: err.server } : {}),
      ...(typeof err.retryAfterMs === "number" ? { retryAfterMs: err.retryAfterMs } : {}),
      ...(err.result !== undefined ? { result: err.result } : {}),
    });
    // The producing layer may stamp `retryable` on a newer code; keep it.
    if (err.retryable === true) out.retryable = true;
    return out;
  }
  if (err.code === "invalid_content" || err.code === "invalid_request") {
    return badRequest(err.message);
  }
  return mcpError("upstream_error", err.message);
}

/* -------------------------------- manifest -------------------------------- */

export interface ManifestServer {
  server: string;
  tools: string[];
}

export interface Manifest {
  servers: ManifestServer[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A usable server or tool name: a non-empty string within the limit. */
export function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LENGTH;
}

/**
 * Read `capabilities.mcp.config` as the manifest `{servers: [{server, tools}]}`.
 * Malformed entries are dropped rather than refused: the declaration was
 * accepted at publish, and a page must still be able to run for the servers
 * it declared properly. An entry with no usable tool names is dropped too —
 * the platform refuses those at publish, and "no tools" never means "all
 * tools". Repeated servers merge into one entry.
 */
export function readManifest(config: unknown): Manifest {
  const servers = new Map<string, Set<string>>();
  const raw = isRecord(config) ? config.servers : undefined;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isRecord(entry) || !isName(entry.server) || !Array.isArray(entry.tools)) continue;
      const tools = entry.tools.filter(isName);
      if (tools.length === 0) continue;
      const set = servers.get(entry.server) ?? new Set<string>();
      for (const tool of tools) set.add(tool);
      servers.set(entry.server, set);
    }
  }
  return {
    servers: [...servers].map(([server, tools]) => ({ server, tools: [...tools] })),
  };
}

/** `host:<name>` names a server on the viewer's device, reached via the Claude app. */
export function isHostServer(server: string): boolean {
  return server.startsWith("host:");
}

export function manifestServer(manifest: Manifest, server: string): ManifestServer | null {
  return manifest.servers.find((entry) => entry.server === server) ?? null;
}

export function inManifest(manifest: Manifest, server: string, tool: string): boolean {
  return manifestServer(manifest, server)?.tools.includes(tool) ?? false;
}

/* ------------------------------ plain JSON -------------------------------- */

/**
 * Whether a value is plain JSON: objects with a plain prototype, arrays,
 * strings, finite numbers, booleans and null, to a bounded depth. A `Map`,
 * `Set`, `Date`, typed array, `BigInt`, function or symbol is not. An
 * `undefined` property is tolerated (JSON drops it), a bare `undefined` is
 * not — that is what "omit the argument" is for.
 */
export function isPlainJson(value: unknown, depth = 0): boolean {
  if (depth > MAX_INPUT_DEPTH) return false;
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      break;
    default:
      return false;
  }
  if (Array.isArray(value)) return value.every((item) => isPlainJson(item, depth + 1));
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const item of Object.values(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    if (!isPlainJson(item, depth + 1)) return false;
  }
  return true;
}

/** JSON with object keys sorted at every level, so property order never matters. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value) ?? "null";
}

/**
 * The input-less call: `undefined`, `null` and `{}` all mean it
 * (mcp.d.ts `invalidate`). Everything else is kept as given.
 */
export function normalizeInput(input: unknown): unknown {
  if (input === undefined || input === null) return {};
  return input;
}

/** Joins the parts of an identity; never occurs in a name or in JSON text. */
export const IDENTITY_SEPARATOR = "\u0000";

/** The order-insensitive identity a cache entry and a watch are keyed by. */
export function callIdentity(server: string, tool: string, input: unknown): string {
  return `${server}${IDENTITY_SEPARATOR}${tool}${IDENTITY_SEPARATOR}${canonicalJson(normalizeInput(input))}`;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** The checked `(server, tool, input)` of a call, or the `bad_request` to reject with. */
export function validateCallArgs(
  server: unknown,
  tool: unknown,
  input: unknown,
): { server: string; tool: string; input: unknown } {
  if (!isName(server)) throw badRequest("server must be a connector's display name");
  if (!isName(tool)) throw badRequest("tool must be a tool name");
  const normalized = normalizeInput(input);
  if (!isRecord(normalized) || !isPlainJson(normalized)) {
    throw badRequest("input must be a plain JSON object of tool arguments (Map, Set, Date, typed arrays and BigInt are not)");
  }
  const bytes = utf8Bytes(JSON.stringify(normalized) ?? "null");
  if (bytes > MAX_INPUT_BYTES) throw badRequest("input is over the 256 KiB limit");
  return { server, tool, input: normalized };
}

/* ------------------------------- cache policy ----------------------------- */

/** The page's `cache` option after validation. */
export type CacheOption = false | { staleTime?: number; gcTime?: number; refresh?: boolean } | undefined;

function readMs(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw badRequest(`cache.${what} must be a number of milliseconds`);
  }
  return value;
}

/** Validate `options.cache` for `callTool` (`refresh` allowed) or `watchTool`. */
export function readCacheOption(raw: unknown, arm: "call" | "watch"): CacheOption {
  if (raw === undefined || raw === null) return undefined;
  if (raw === false) return false;
  if (!isRecord(raw)) throw badRequest("cache must be false or an object");
  const out: { staleTime?: number; gcTime?: number; refresh?: boolean } = {};
  const staleTime = readMs(raw.staleTime, "staleTime");
  const gcTime = readMs(raw.gcTime, "gcTime");
  if (staleTime !== undefined) out.staleTime = staleTime;
  if (gcTime !== undefined) out.gcTime = gcTime;
  if (arm === "call" && raw.refresh !== undefined) {
    if (typeof raw.refresh !== "boolean") throw badRequest("cache.refresh must be a boolean");
    out.refresh = raw.refresh;
  }
  return out;
}

export interface CachePolicy {
  /** Serve a stored entry younger than `staleTime` without executing. */
  read: boolean;
  /** Store a successful result (and feed watchers of the identity). */
  write: boolean;
  staleTime: number;
  gcTime: number;
}

const UNCACHED: CachePolicy = Object.freeze({ read: false, write: false, staleTime: 0, gcTime: 0 });

/**
 * mcp.d.ts `CallToolOptions.cache`: a wire-explicit `readOnlyHint: false` is
 * the policy floor (never cached, options ignored); `false` never caches;
 * omitted caches only tools with a wire-explicit `readOnlyHint: true`; an
 * object opts in and tunes, with `staleTime` capped at 5 min, `gcTime` at
 * 24 h, and a non-positive `gcTime` meaning "do not cache".
 */
export function resolveCachePolicy(option: CacheOption, readOnlyHint: boolean | undefined): CachePolicy {
  if (readOnlyHint === false) return UNCACHED;
  if (option === false) return UNCACHED;
  if (option === undefined) {
    return readOnlyHint === true
      ? { read: true, write: true, staleTime: 0, gcTime: DEFAULT_GC_TIME_MS }
      : UNCACHED;
  }
  const gcTime = option.gcTime === undefined ? DEFAULT_GC_TIME_MS : Math.min(option.gcTime, MAX_GC_TIME_MS);
  if (gcTime <= 0) return UNCACHED;
  const staleTime = Math.max(0, Math.min(option.staleTime ?? 0, MAX_STALE_TIME_MS));
  return { read: option.refresh !== true, write: true, staleTime, gcTime };
}

/** `watchTool`'s `refetchInterval`: absent means no polling; else ≥ 30 s. */
export function readRefetchInterval(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw badRequest("refetchInterval must be a positive number of milliseconds");
  }
  return Math.max(raw, MIN_REFETCH_INTERVAL_MS);
}

/* --------------------------------- results -------------------------------- */

export interface ContentBlock {
  type: string;
  [k: string]: unknown;
}

export interface CacheMarker {
  storedAt: number;
  revalidating: boolean;
}

export interface CallToolResult {
  content: ContentBlock[];
  structuredContent?: unknown;
  payload?: unknown;
  cache?: CacheMarker;
}

/**
 * `payload`: `structuredContent` when present, else the first text block's
 * text parsed as JSON when it parses, else that text verbatim, else absent.
 */
export function derivePayload(content: ContentBlock[], structuredContent: unknown): unknown {
  if (structuredContent !== undefined) return structuredContent;
  const text = content.find((block) => block.type === "text" && typeof block.text === "string");
  if (!text) return undefined;
  const raw = text.text as string;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * A tool result as it came from upstream, made into the page's shape: the
 * content blocks kept, `payload` derived, any inbound `cache` field stripped
 * (only the shell may stamp one), and `isError` read off and removed.
 */
export function normalizeResult(raw: unknown): { result: CallToolResult; isError: boolean } {
  const record = isRecord(raw) ? raw : {};
  const content: ContentBlock[] = Array.isArray(record.content)
    ? record.content.filter((block): block is ContentBlock => isRecord(block) && typeof block.type === "string")
    : [];
  const structuredContent = record.structuredContent;
  const result: CallToolResult = { content };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  const payload = derivePayload(content, structuredContent);
  if (payload !== undefined) result.payload = payload;
  return { result, isError: record.isError === true };
}

/** The human-readable message a failed tool reported, for `tool_error`. */
export function errorText(result: CallToolResult): string {
  const text = result.content.find((block) => block.type === "text" && typeof block.text === "string");
  return typeof text?.text === "string" && text.text.length > 0 ? text.text : "the tool reported an error";
}

/* --------------------------------- servers -------------------------------- */

export type ServerAuthStatus = "connected" | "needs_reauth" | "unknown";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface ToolInfo {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
}

export interface ServerInfo {
  server: string;
  authStatus: ServerAuthStatus;
  tools: ToolInfo[];
}

export interface ListToolsResult {
  servers: ServerInfo[];
}

/** The upstream auth vocabulary, folded to the closed set pages see (§5.8). */
export function normalizeAuthStatus(raw: unknown): ServerAuthStatus {
  switch (raw) {
    case "connected":
    case "authenticated":
    case "not_required":
      return "connected";
    case "needs_reauth":
    case "auth_required":
    case "token_invalid":
    case "refresh_failed":
    case "managed_auth_failed":
      return "needs_reauth";
    default:
      return "unknown";
  }
}

/** One tool as it came over the wire, or null when it is not one. */
export function readToolInfo(raw: unknown): ToolInfo | null {
  if (!isRecord(raw) || !isName(raw.name)) return null;
  const tool: ToolInfo = {
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : "",
  };
  if (isRecord(raw.annotations)) {
    const annotations: ToolAnnotations = {};
    if (typeof raw.annotations.readOnlyHint === "boolean") {
      annotations.readOnlyHint = raw.annotations.readOnlyHint;
    }
    if (typeof raw.annotations.destructiveHint === "boolean") {
      annotations.destructiveHint = raw.annotations.destructiveHint;
    }
    if (Object.keys(annotations).length > 0) tool.annotations = annotations;
  }
  return tool;
}

/**
 * The shell's `listTools` reply, `[{server, authStatus?, tools}]`, as the
 * page's `{servers}`. Unknown rows are dropped, statuses normalised.
 */
export function readListToolsReply(raw: unknown): ListToolsResult {
  const rows = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.servers) ? raw.servers : [];
  const servers: ServerInfo[] = [];
  for (const row of rows) {
    if (!isRecord(row) || !isName(row.server)) continue;
    const tools = Array.isArray(row.tools)
      ? row.tools.map(readToolInfo).filter((tool): tool is ToolInfo => tool !== null)
      : [];
    servers.push({ server: row.server, authStatus: normalizeAuthStatus(row.authStatus), tools });
  }
  return { servers };
}

/* ---------------------------------- wire ---------------------------------- */

/** The shell → frame push carrying a watch event. */
export interface FrameMcpWatch {
  __frame_mcp_watch: true;
  watchId: string;
  ev: WatchEventWire;
}

export type WatchEventWire =
  | { type: "data"; result: CallToolResult; server: string }
  | { type: "error"; error: McpError };

export function isFrameMcpWatch(data: unknown): data is FrameMcpWatch {
  if (!isRecord(data) || data.__frame_mcp_watch !== true) return false;
  if (typeof data.watchId !== "string") return false;
  const ev = data.ev;
  if (!isRecord(ev)) return false;
  if (ev.type === "data") return isRecord(ev.result);
  if (ev.type === "error") return isCapError(ev.error);
  return false;
}

/** The consent key a viewer's answer for one server is stored under. */
export function serverConsentKey(artifactId: string, server: string): string {
  return `consent:${artifactId}:mcp:${server}`;
}

/** The reply budget for a method: `capBudgets.mcp[method]` clamped, plus grace. */
export function replyBudget(budgets: unknown, method: "callTool" | "listTools"): number {
  const raw = isRecord(budgets) && isRecord(budgets.mcp) ? budgets.mcp[method] : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DEFAULT_BUDGET_MS;
  return Math.min(raw, MAX_BUDGET_MS) + BUDGET_GRACE_MS;
}

/** Wire error used when the shell never answers. */
export const noReply = (): McpError => mcpError("upstream_error", "no reply from shell");
