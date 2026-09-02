/**
 * The upstream half: one MCP client per configured server, on the official
 * SDK, connected lazily and reconnected after a drop. This is the only file
 * in the slice that imports the SDK; the frame and shell bundles never see
 * it (`server.ts` alone imports it, and only `src/server/routes.ts` imports
 * `server.ts`).
 *
 * Errors are folded into the page's vocabulary here (`mapUpstreamError`):
 * a lapsed credential is `needs_reauth`, an unreachable or failing server
 * is `server_unavailable` (retryable), a missing one `server_not_found`, an
 * abort `cancelled`, and everything else `upstream_error`.
 *
 * Note for operators: the SDK reaches the server through the global
 * `fetch`, which on Node does not read `HTTPS_PROXY`. Behind a proxy, hand
 * `createClientPool` a `fetch` built on an `undici` proxy agent.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError as SdkMcpError } from "@modelcontextprotocol/sdk/types.js";
import type {
  ConnectorFactory,
  ConnectorHandle,
  ConnectorTools,
  McpServerConfig,
  RawCallResult,
} from "./directory.ts";
import { isMcpErrorCode, mcpError, readToolInfo, type McpError, type ToolInfo } from "./protocol.ts";

/** How long a `tools/list` answer serves before it is asked again. */
const DEFAULT_LIST_TTL_MS = 60_000;
const CONNECT_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 120_000;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ClientPoolOptions {
  listToolsTtlMs?: number;
  /** A fetch to reach servers with (a proxy agent, or a test double). */
  fetch?: FetchLike;
  clientInfo?: { name: string; version: string };
}

interface Entry {
  config: McpServerConfig;
  client: Client | null;
  connecting: Promise<Client> | null;
  tools: { at: number; value: ToolInfo[] } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpStatus(err: unknown): number | undefined {
  if (err instanceof StreamableHTTPError || err instanceof SseError) return err.code;
  return undefined;
}

function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TypeError" && /fetch failed|network/i.test(err.message)) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (isRecord(cause) && typeof cause.code === "string") {
    return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR/.test(cause.code);
  }
  return false;
}

/** The page's error for whatever the SDK or the network threw. */
export function mapUpstreamError(err: unknown, server: string): McpError {
  // A connector may already speak the vocabulary (the fake does).
  if (isRecord(err) && isMcpErrorCode(err.code) && typeof err.message === "string") {
    return mcpError(err.code, err.message, {
      server,
      ...(typeof err.retryAfterMs === "number" ? { retryAfterMs: err.retryAfterMs } : {}),
      ...(err.result !== undefined ? { result: err.result } : {}),
    });
  }
  if (err instanceof Error && err.name === "AbortError") {
    return mcpError("cancelled", "the call was cancelled", { server });
  }
  if (err instanceof UnauthorizedError) {
    return mcpError("needs_reauth", `${server} needs to be reconnected`, { server });
  }
  const status = httpStatus(err);
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return mcpError("needs_reauth", `${server} answered ${status}`, { server });
    }
    if (status === 404) return mcpError("server_not_found", `${server} is gone (404)`, { server });
    if (status === 429) {
      return mcpError("server_unavailable", `${server} is throttling (429)`, { server, retryAfterMs: 5_000 });
    }
    if (status >= 500) return mcpError("server_unavailable", `${server} answered ${status}`, { server });
    return mcpError("upstream_error", `${server} answered ${status}`, { server });
  }
  if (err instanceof SdkMcpError) {
    if (err.code === ErrorCode.RequestTimeout) {
      return mcpError("server_unavailable", `${server} did not answer in time`, { server });
    }
    if (err.code === ErrorCode.ConnectionClosed) {
      return mcpError("server_unavailable", `the connection to ${server} closed`, { server });
    }
    return mcpError("upstream_error", err.message, { server });
  }
  if (isNetworkFailure(err)) {
    return mcpError("server_unavailable", `${server} is unreachable`, { server });
  }
  return mcpError("upstream_error", err instanceof Error ? err.message : String(err), { server });
}

export function createClientPool(options: ClientPoolOptions = {}): ConnectorFactory {
  const ttl = options.listToolsTtlMs ?? DEFAULT_LIST_TTL_MS;
  const clientInfo = options.clientInfo ?? { name: "claude-artifact-harness", version: "0.1.0" };
  const entries: Entry[] = [];

  function transportFor(config: McpServerConfig, kind: "http" | "sse"): Transport {
    const url = new URL(config.url);
    const init: RequestInit = config.headers ? { headers: config.headers } : {};
    const shared = {
      requestInit: init,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    };
    return kind === "sse"
      ? new SSEClientTransport(url, shared)
      : new StreamableHTTPClientTransport(url, shared);
  }

  async function connectWith(entry: Entry, kind: "http" | "sse"): Promise<Client> {
    const client = new Client(clientInfo);
    client.onclose = () => {
      if (entry.client === client) entry.client = null;
    };
    client.onerror = () => undefined;
    try {
      await client.connect(transportFor(entry.config, kind), { timeout: CONNECT_TIMEOUT_MS });
    } catch (err) {
      // A transport that failed to start is not closed by the SDK; an SSE
      // one would otherwise keep reconnecting on its own.
      await client.close().catch(() => undefined);
      throw err;
    }
    return client;
  }

  /** The live client, connecting once however many callers arrive at once. */
  function connect(entry: Entry): Promise<Client> {
    if (entry.client) return Promise.resolve(entry.client);
    if (entry.connecting) return entry.connecting;
    const kind = entry.config.transport ?? "http";
    const attempt = (async (): Promise<Client> => {
      try {
        return await connectWith(entry, kind);
      } catch (err) {
        // A server that only speaks the legacy transport refuses the POST
        // with 404 or 405 (the Streamable HTTP spec's fallback rule): try
        // SSE once. Any other status is the server's real answer.
        const status = httpStatus(err);
        if (kind === "http" && entry.config.transport === undefined && (status === 404 || status === 405)) {
          return await connectWith(entry, "sse");
        }
        throw err;
      }
    })();
    entry.connecting = attempt
      .then((client) => {
        entry.client = client;
        return client;
      })
      .finally(() => {
        entry.connecting = null;
      });
    return entry.connecting;
  }

  function dropClient(entry: Entry): void {
    const client = entry.client;
    entry.client = null;
    entry.tools = null;
    if (client) void client.close().catch(() => undefined);
  }

  /**
   * The one `Client` per server is shared by every viewer, so it is dropped
   * only when the transport itself is gone — never for one request's
   * timeout or HTTP status, which would fail everyone else's calls in
   * flight. A lapsed credential also forgets the listing, so `listTools`
   * stops reporting the connector as connected.
   */
  function afterFailure(entry: Entry, err: unknown, mapped: McpError): void {
    const transportDead =
      (err instanceof SdkMcpError && err.code === ErrorCode.ConnectionClosed) || isNetworkFailure(err);
    if (transportDead) dropClient(entry);
    else if (mapped.code === "needs_reauth") dropClient(entry);
  }

  function handle(config: McpServerConfig): ConnectorHandle {
    const entry: Entry = { config, client: null, connecting: null, tools: null };
    entries.push(entry);
    const name = config.name;

    async function listTools(signal: AbortSignal): Promise<ConnectorTools> {
      const held = entry.tools;
      if (held && Date.now() - held.at < ttl) return { authStatus: "authenticated", tools: held.value };
      let client: Client;
      try {
        client = await connect(entry);
      } catch (err) {
        const mapped = mapUpstreamError(err, name);
        if (mapped.code === "needs_reauth") return { authStatus: "auth_required", tools: [] };
        throw mapped;
      }
      try {
        const reply = await client.listTools(undefined, { signal, timeout: LIST_TIMEOUT_MS });
        const tools = reply.tools.map(readToolInfo).filter((tool): tool is ToolInfo => tool !== null);
        entry.tools = { at: Date.now(), value: tools };
        return { authStatus: "authenticated", tools };
      } catch (err) {
        const mapped = mapUpstreamError(err, name);
        afterFailure(entry, err, mapped);
        if (mapped.code === "needs_reauth") return { authStatus: "auth_required", tools: [] };
        throw mapped;
      }
    }

    async function callTool(
      tool: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<RawCallResult> {
      let client: Client;
      try {
        client = await connect(entry);
      } catch (err) {
        throw mapUpstreamError(err, name);
      }
      try {
        const reply = await client.callTool({ name: tool, arguments: input }, undefined, {
          signal,
          timeout: CALL_TIMEOUT_MS,
        });
        const record = reply as Record<string, unknown>;
        const out: RawCallResult = { content: Array.isArray(record.content) ? record.content : [] };
        if (record.structuredContent !== undefined) out.structuredContent = record.structuredContent;
        if (record.isError === true) out.isError = true;
        return out;
      } catch (err) {
        // The SDK reports an abort as a closed request, not an AbortError.
        if (signal.aborted) throw mcpError("cancelled", "the call was cancelled", { server: name });
        const mapped = mapUpstreamError(err, name);
        afterFailure(entry, err, mapped);
        throw mapped;
      }
    }

    return {
      name,
      ...(config.noStore ? { noStore: true } : {}),
      listTools,
      callTool,
    };
  }

  return {
    handle,
    async close() {
      await Promise.all(
        entries.map(async (entry) => {
          const client = entry.client ?? (await entry.connecting?.catch(() => null)) ?? null;
          entry.client = null;
          if (client) await client.close().catch(() => undefined);
        }),
      );
    },
  };
}
