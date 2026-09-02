/**
 * Where the connectors come from. On claude.ai a page calls "the viewer's
 * connectors": per-account servers with per-viewer credentials. This harness
 * has no account service, so the first directory is server-wide — the
 * operator declares named servers and every viewer shares them — behind the
 * one seam a per-viewer store would implement later: `resolve(viewerId,
 * displayName)`.
 *
 *   MCP_SERVERS='[{"name":"Weather","url":"https://…/mcp","headers":{…}}]'
 *   MCP_SERVERS_FILE=./mcp-servers.json      (same JSON, from a file)
 *   MCP_BACKEND=fake                         (deterministic in-process connectors)
 *
 * The fake directory is what the tests run against: three connectors whose
 * tools exercise every path a page can hit — annotated reads and writes, an
 * unannotated tool, a tool that fails, a slow one, a flaky one, an image, a
 * connector whose credentials lapsed and one whose results must not be
 * cached — and a counter (`fakeCallCount`) so a test can tell a cache hit
 * from a fresh execution.
 */
import { readFileSync } from "node:fs";
import { mcpError, type ToolInfo } from "./protocol.ts";

/** A tool result as the connector produced it (content, structured output, failure flag). */
export interface RawCallResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface ConnectorTools {
  /** The connector's auth posture in the upstream vocabulary (§5.8). */
  authStatus: string;
  tools: ToolInfo[];
}

/** One connector a viewer can call. */
export interface ConnectorHandle {
  name: string;
  /** Results must never be cached shell-side (`X-Frame-Mcp-No-Store`). */
  noStore?: boolean;
  listTools(signal: AbortSignal): Promise<ConnectorTools>;
  callTool(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<RawCallResult>;
}

/** The lookup seam. Server-wide today; a per-viewer store fits the same shape. */
export interface ConnectorDirectory {
  resolve(viewerId: string, displayName: string): Promise<ConnectorHandle | null>;
  close(): Promise<void>;
}

/* ------------------------------ configuration ----------------------------- */

export interface McpServerConfig {
  /** The display name a page addresses the server by. */
  name: string;
  url: string;
  headers?: Record<string, string>;
  /** `http` (Streamable HTTP, the default) or `sse` (the legacy transport). */
  transport?: "http" | "sse";
  /** Results from this server are never cached by the shell. */
  noStore?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the server list, refusing anything that would only fail later. */
export function parseServersConfig(value: unknown): McpServerConfig[] {
  const rows = isRecord(value) && Array.isArray(value.servers) ? value.servers : value;
  if (!Array.isArray(rows)) throw new Error("MCP_SERVERS must be a JSON array of {name, url}");
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) throw new Error("each MCP server is an object {name, url}");
    const { name, url, headers, transport, noStore } = row;
    if (typeof name !== "string" || name.trim() === "") throw new Error("an MCP server needs a name");
    if (name.startsWith("host:")) throw new Error(`"${name}": host: names are reserved for the viewer's device`);
    if (seen.has(name)) throw new Error(`"${name}" is declared twice`);
    if (typeof url !== "string") throw new Error(`"${name}" needs a url`);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`"${name}": ${url} is not a URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`"${name}": the url must be http(s)`);
    }
    const config: McpServerConfig = { name, url: parsed.href };
    if (headers !== undefined) {
      if (!isRecord(headers) || Object.values(headers).some((v) => typeof v !== "string")) {
        throw new Error(`"${name}": headers must be an object of strings`);
      }
      config.headers = headers as Record<string, string>;
    }
    if (transport !== undefined) {
      if (transport !== "http" && transport !== "sse") {
        throw new Error(`"${name}": transport must be "http" or "sse"`);
      }
      config.transport = transport;
    }
    if (noStore !== undefined) {
      if (typeof noStore !== "boolean") throw new Error(`"${name}": noStore must be a boolean`);
      config.noStore = noStore;
    }
    seen.add(name);
    out.push(config);
  }
  return out;
}

/**
 * Parse configuration JSON without quoting it back: the text can carry a
 * credential, and `JSON.parse`'s own message embeds a snippet of the input.
 */
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
}

/** `MCP_SERVERS` (inline JSON), else `MCP_SERVERS_FILE` (a path), else nothing. */
export function readServersFromEnv(env: NodeJS.ProcessEnv = process.env): McpServerConfig[] {
  const inline = env.MCP_SERVERS;
  if (inline && inline.trim() !== "") return parseServersConfig(parseJson(inline, "MCP_SERVERS"));
  const file = env.MCP_SERVERS_FILE;
  if (file && file.trim() !== "") {
    return parseServersConfig(parseJson(readFileSync(file, "utf8"), "MCP_SERVERS_FILE"));
  }
  return [];
}

/* ------------------------------- directories ------------------------------ */

/** A pool that turns a configuration into a live connector (see client.ts). */
export interface ConnectorFactory {
  handle(config: McpServerConfig): ConnectorHandle;
  close(): Promise<void>;
}

/** Every viewer sees the same servers: the configuration is the directory. */
export function configDirectory(servers: McpServerConfig[], factory: ConnectorFactory): ConnectorDirectory {
  const handles = new Map<string, ConnectorHandle>();
  for (const config of servers) handles.set(config.name, factory.handle(config));
  return {
    resolve: async (_viewerId, displayName) => handles.get(displayName) ?? null,
    close: () => factory.close(),
  };
}

export function emptyDirectory(): ConnectorDirectory {
  return { resolve: async () => null, close: async () => undefined };
}

/* ---------------------------------- fake ---------------------------------- */

let fakeCalls = 0;

/** Test hook: how many tool calls the fake connectors have executed. */
export function fakeCallCount(): number {
  return fakeCalls;
}

export function resetFakeCalls(): void {
  fakeCalls = 0;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort(): void {
      clearTimeout(timer);
      reject(mcpError("cancelled", "the call was cancelled"));
    }
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const text = (value: string): { type: "text"; text: string } => ({ type: "text", text: value });

/** A 1×1 transparent PNG, for the `image` tool. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const FAKE_SERVER = "Fake Tools";
export const FAKE_REAUTH_SERVER = "Needs Auth";
export const FAKE_NOSTORE_SERVER = "No Store";

const FAKE_TOOLS: ToolInfo[] = [
  { name: "echo", description: "Echo the input back, with the call number.", annotations: { readOnlyHint: true } },
  { name: "write", description: "Pretend to write something.", annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "plain", description: "A tool that declares nothing about itself." },
  { name: "fail", description: "Always reports a tool-level failure." },
  { name: "slow", description: "Answers after `ms` milliseconds (default 1500).", annotations: { readOnlyHint: true } },
  { name: "flaky", description: "The upstream is unreachable.", annotations: { readOnlyHint: true } },
  { name: "image", description: "Returns an image block and a caption.", annotations: { readOnlyHint: true } },
];

function fakeTools(): ConnectorHandle {
  return {
    name: FAKE_SERVER,
    listTools: async () => ({ authStatus: "not_required", tools: FAKE_TOOLS.map((t) => ({ ...t })) }),
    async callTool(tool, input, signal) {
      if (!FAKE_TOOLS.some((t) => t.name === tool)) {
        throw mcpError("upstream_error", `Fake Tools has no tool named ${tool}`, { server: FAKE_SERVER });
      }
      if (tool === "flaky") {
        throw mcpError("server_unavailable", "the fake upstream is unreachable", {
          server: FAKE_SERVER,
          retryAfterMs: 1_000,
        });
      }
      const n = ++fakeCalls;
      switch (tool) {
        case "echo":
          return {
            content: [text(JSON.stringify({ echo: input, call: n }))],
            structuredContent: { echo: input, call: n },
          };
        case "write":
          return { content: [text(`wrote #${n}`)] };
        case "plain":
          return { content: [text(JSON.stringify({ call: n }))] };
        case "fail":
          return { content: [text(`the fixture tool failed on call #${n}`)], isError: true };
        case "slow": {
          const ms = typeof input.ms === "number" && input.ms > 0 ? input.ms : 1_500;
          await delay(ms, signal);
          return { content: [text(JSON.stringify({ slow: true, call: n }))] };
        }
        case "image":
          return {
            content: [{ type: "image", data: PIXEL, mimeType: "image/png" }, text(`one pixel, call #${n}`)],
          };
        default:
          return { content: [] };
      }
    },
  };
}

function fakeReauth(): ConnectorHandle {
  return {
    name: FAKE_REAUTH_SERVER,
    listTools: async () => ({ authStatus: "token_invalid", tools: [] }),
    async callTool() {
      throw mcpError("needs_reauth", "the fake connector's token has lapsed", { server: FAKE_REAUTH_SERVER });
    },
  };
}

function fakeNoStore(): ConnectorHandle {
  return {
    name: FAKE_NOSTORE_SERVER,
    noStore: true,
    listTools: async () => ({
      authStatus: "authenticated",
      tools: [{ name: "echo", description: "Echo, never cached.", annotations: { readOnlyHint: true } }],
    }),
    async callTool(tool, input) {
      if (tool !== "echo") {
        throw mcpError("upstream_error", `No Store has no tool named ${tool}`, { server: FAKE_NOSTORE_SERVER });
      }
      const n = ++fakeCalls;
      return { content: [text(JSON.stringify({ echo: input, call: n }))] };
    },
  };
}

export function fakeDirectory(): ConnectorDirectory {
  const handles = new Map<string, ConnectorHandle>(
    [fakeTools(), fakeReauth(), fakeNoStore()].map((handle) => [handle.name, handle]),
  );
  return {
    resolve: async (_viewerId, displayName) => handles.get(displayName) ?? null,
    close: async () => undefined,
  };
}

/* -------------------------------- selection ------------------------------- */

/**
 * The directory this process runs: the fake under `MCP_BACKEND=fake`, else
 * the configured servers (none configured is fine — every server is then
 * `server_not_connected`, exactly as a viewer with no connectors sees).
 * A configuration that cannot be read is an error to the operator, so it is
 * thrown rather than turned into an empty directory.
 */
export function selectDirectory(
  factory: () => ConnectorFactory,
  env: NodeJS.ProcessEnv = process.env,
): ConnectorDirectory {
  if ((env.MCP_BACKEND ?? "").toLowerCase() === "fake") return fakeDirectory();
  const servers = readServersFromEnv(env);
  if (servers.length === 0) return emptyDirectory();
  return configDirectory(servers, factory());
}

