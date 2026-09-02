/**
 * The SDK client pool against a real MCP server: the SDK's own `McpServer`
 * over Streamable HTTP on a `node:http` listener in this process. Lazy
 * connection, `tools/list` and `tools/call`, annotations, structured
 * output, abort, and the error mapping for a server that is gone, refuses
 * auth, or never existed.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createClientPool, mapUpstreamError } from "../../src/capabilities/mcp/client.ts";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ErrorCode, McpError as SdkMcpError } from "@modelcontextprotocol/sdk/types.js";

let http: Server;
let url: string;
let seenAuth: string[] = [];

function fixtureServer(): McpServer {
  const mcp = new McpServer({ name: "fixture", version: "1.0.0" });
  mcp.registerTool(
    "echo",
    {
      description: "Echo the input.",
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({
      content: [{ type: "text", text: JSON.stringify({ echo: text }) }],
      structuredContent: { echo: text },
    }),
  );
  mcp.registerTool(
    "slow",
    { description: "Waits.", inputSchema: { ms: z.number() } },
    async ({ ms }, extra) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ content: [{ type: "text", text: "done" }] }), ms);
        extra.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve({ content: [{ type: "text", text: "aborted" }] });
        });
      }),
  );
  mcp.registerTool("broken", { description: "Always fails." }, async () => ({
    content: [{ type: "text", text: "nope" }],
    isError: true,
  }));
  return mcp;
}

beforeAll(async () => {
  http = createServer(async (req, res) => {
    seenAuth.push(req.headers.authorization ?? "");
    if (req.url?.startsWith("/locked")) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.url?.startsWith("/gone")) {
      res.writeHead(404).end();
      return;
    }
    if (req.url?.startsWith("/broken")) {
      res.writeHead(500).end();
      return;
    }
    // Stateless: one server and transport per request, as the SDK documents.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = fixtureServer();
    res.on("close", () => void transport.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;
  url = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe("the pool", () => {
  it("connects lazily, lists tools with annotations, and calls one", async () => {
    const pool = createClientPool();
    const handle = pool.handle({ name: "Fixture", url: `${url}/mcp`, headers: { authorization: "Bearer t" } });
    const listed = await handle.listTools(new AbortController().signal);
    expect(listed.authStatus).toBe("authenticated");
    expect(listed.tools.map((t) => t.name).sort()).toEqual(["broken", "echo", "slow"]);
    expect(listed.tools.find((t) => t.name === "echo")).toEqual({
      name: "echo",
      description: "Echo the input.",
      annotations: { readOnlyHint: true },
    });
    expect(listed.tools.find((t) => t.name === "slow")!.annotations).toBeUndefined();
    expect(seenAuth.some((h) => h === "Bearer t")).toBe(true);

    const result = await handle.callTool("echo", { text: "hi" }, new AbortController().signal);
    expect(result.structuredContent).toEqual({ echo: "hi" });
    expect(result.content).toEqual([{ type: "text", text: '{"echo":"hi"}' }]);
    expect(result.isError).toBeUndefined();

    const failed = await handle.callTool("broken", {}, new AbortController().signal);
    expect(failed.isError).toBe(true);
    await pool.close();
  });

  it("serves tools/list from its cache within the ttl", async () => {
    const pool = createClientPool({ listToolsTtlMs: 60_000 });
    const handle = pool.handle({ name: "Fixture", url: `${url}/mcp` });
    await handle.listTools(new AbortController().signal);
    const requests = seenAuth.length;
    await handle.listTools(new AbortController().signal);
    expect(seenAuth.length).toBe(requests);
    await pool.close();
  });

  it("aborts a call in flight", async () => {
    const pool = createClientPool();
    const handle = pool.handle({ name: "Fixture", url: `${url}/mcp` });
    const controller = new AbortController();
    const pending = handle.callTool("slow", { ms: 5_000 }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await pool.close();
  });

  it("maps a locked, a missing and a failing server", async () => {
    const pool = createClientPool();
    const locked = pool.handle({ name: "Locked", url: `${url}/locked` });
    expect(await locked.listTools(new AbortController().signal)).toEqual({ authStatus: "auth_required", tools: [] });
    await expect(locked.callTool("echo", {}, new AbortController().signal)).rejects.toMatchObject({
      code: "needs_reauth",
      server: "Locked",
    });
    const gone = pool.handle({ name: "Gone", url: `${url}/gone` });
    await expect(gone.callTool("echo", {}, new AbortController().signal)).rejects.toMatchObject({
      code: "server_not_found",
    });
    const broken = pool.handle({ name: "Broken", url: `${url}/broken` });
    await expect(broken.callTool("echo", {}, new AbortController().signal)).rejects.toMatchObject({
      code: "server_unavailable",
      retryable: true,
    });
    const nowhere = pool.handle({ name: "Nowhere", url: "http://127.0.0.1:9/mcp" });
    await expect(nowhere.callTool("echo", {}, new AbortController().signal)).rejects.toMatchObject({
      code: "server_unavailable",
      retryable: true,
    });
    await pool.close();
  });
});

describe("mapUpstreamError", () => {
  it("folds the SDK's and the network's failures into the page's codes", () => {
    expect(mapUpstreamError(new UnauthorizedError("x"), "S")).toMatchObject({ code: "needs_reauth", server: "S" });
    expect(mapUpstreamError(new StreamableHTTPError(403, "no"), "S").code).toBe("needs_reauth");
    expect(mapUpstreamError(new StreamableHTTPError(404, "no"), "S").code).toBe("server_not_found");
    expect(mapUpstreamError(new StreamableHTTPError(429, "no"), "S")).toMatchObject({ code: "server_unavailable", retryAfterMs: 5_000 });
    expect(mapUpstreamError(new StreamableHTTPError(502, "no"), "S").code).toBe("server_unavailable");
    expect(mapUpstreamError(new StreamableHTTPError(418, "no"), "S").code).toBe("upstream_error");
    expect(mapUpstreamError(new SdkMcpError(ErrorCode.RequestTimeout, "t"), "S").code).toBe("server_unavailable");
    expect(mapUpstreamError(new SdkMcpError(ErrorCode.InvalidParams, "p"), "S").code).toBe("upstream_error");
    const aborted = new Error("x");
    aborted.name = "AbortError";
    expect(mapUpstreamError(aborted, "S").code).toBe("cancelled");
    const refused = new TypeError("fetch failed");
    (refused as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
    expect(mapUpstreamError(refused, "S").code).toBe("server_unavailable");
    expect(mapUpstreamError({ code: "tool_error", message: "m", result: { isError: true } }, "S")).toEqual({
      code: "tool_error",
      message: "m",
      server: "S",
      result: { isError: true },
    });
    expect(mapUpstreamError("weird", "S")).toEqual({ code: "upstream_error", message: "weird", server: "S" });
  });
});
