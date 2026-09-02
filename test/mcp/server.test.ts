/**
 * The backend, over real sockets, with the fake connector directory
 * (`MCP_BACKEND=fake`) so no upstream and no network are needed: the gate,
 * the manifest intersection of `/servers`, and every refusal and result
 * shape of `/call`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../src/server/index.ts";
import { fakeCallCount } from "../../src/capabilities/mcp/directory.ts";

let server: RunningServer;
let readOnly: RunningServer;
let dataDir: string;
let artifactId: string;
let plainId: string;
let cookie: string;

const PAGE = "<p>mcp fixture</p>";
const MANIFEST = {
  servers: [
    { server: "Fake Tools", tools: ["echo", "write", "plain", "fail", "slow", "flaky", "image"] },
    { server: "host:local", tools: ["read_file"] },
    { server: "Needs Auth", tools: ["anything"] },
    { server: "No Store", tools: ["echo"] },
    { server: "Nowhere", tools: ["x"] },
  ],
};

async function create(target: RunningServer, capabilities: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${target.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ html: PAGE, capabilities }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

function post(path: string, body: unknown, target: RunningServer = server, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${target.shellOrigin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const servers = (body: unknown = { artifactId }, target?: RunningServer): Promise<Response> =>
  post("/api/frame/mcp/servers", body, target);
const call = (body: Record<string, unknown>, target?: RunningServer): Promise<Response> =>
  post("/api/frame/mcp/call", { artifactId, ...body }, target);

beforeAll(async () => {
  process.env.MCP_BACKEND = "fake";
  dataDir = await mkdtemp(join(tmpdir(), "mcp-server-"));
  server = await startServer({ shellPort: 0, framePort: 0, dataDir, openAdminApi: true });
  readOnly = await startServer({ shellPort: 0, framePort: 0, dataDir, openAdminApi: true, defaultLevel: "view" });
  artifactId = await create(server, { mcp: MANIFEST });
  plainId = await create(server, { db: {} });
  const page = await fetch(`${server.shellOrigin}/a/${artifactId}`);
  cookie = (page.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).toMatch(/^av=/);
});

afterAll(async () => {
  delete process.env.MCP_BACKEND;
  await Promise.all([server.close(), readOnly.close()]);
  await rm(dataDir, { recursive: true, force: true });
});

describe("the gate", () => {
  it("refuses a bad body, an unknown artifact and one that does not declare mcp", async () => {
    expect((await servers("not json")).status).toBe(400);
    expect((await servers({})).status).toBe(400);
    expect((await servers({ artifactId: "0".repeat(32) })).status).toBe(404);
    const undeclared = await servers({ artifactId: plainId });
    expect(undeclared.status).toBe(400);
    expect(await undeclared.json()).toMatchObject({ code: "not_declared" });
  });

  it("refuses a viewer who may only view", async () => {
    const response = await call({ server: "Fake Tools", tool: "echo", input: {} }, readOnly);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "not_granted" });
  });

  it("refuses a body over the cap, declared or chunked", async () => {
    const response = await call({ server: "Fake Tools", tool: "echo", input: { big: "x".repeat(600_000) } });
    expect(response.status).toBe(413);
    // No content-length at all: the cap is enforced on the stream.
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 4_000_000) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode("x".repeat(64 * 1024)));
        sent += 64 * 1024;
      },
    });
    const chunked = await fetch(`${server.shellOrigin}/api/frame/mcp/call`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body,
      // @ts-expect-error -- Node's fetch needs this for a streaming body
      duplex: "half",
    }).catch(() => null);
    // Node may report the early close as a failed fetch rather than a 413;
    // either way the server never buffered the four megabytes.
    if (chunked) expect(chunked.status).toBe(413);
    expect(sent).toBeLessThan(4_000_000);
  });

  it("only accepts the shell page's own requests", async () => {
    const crossSite = await post("/api/frame/mcp/call", { artifactId, server: "Fake Tools", tool: "echo", input: {} }, server, {
      "sec-fetch-site": "cross-site",
      origin: "https://evil.example",
    });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({ code: "not_granted" });
    const otherOrigin = await post("/api/frame/mcp/servers", { artifactId }, server, { origin: "https://evil.example" });
    expect(otherOrigin.status).toBe(403);
    // A "simple" request (no preflight) is refused by its content type.
    const simple = await fetch(`${server.shellOrigin}/api/frame/mcp/call`, {
      method: "POST",
      headers: { "content-type": "text/plain", cookie },
      body: JSON.stringify({ artifactId, server: "Fake Tools", tool: "echo", input: {} }),
    });
    expect(simple.status).toBe(415);
    // The shell page itself passes.
    const own = await post("/api/frame/mcp/servers", { artifactId }, server, { "sec-fetch-site": "same-origin", origin: server.shellOrigin });
    expect(own.status).toBe(200);
  });
});

describe("POST /api/frame/mcp/servers", () => {
  it("lists the manifest intersected with the directory, omitting host: and unknown servers", async () => {
    const response = await servers();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { servers: Array<{ server: string; authStatus: string; tools: Array<{ name: string; annotations?: unknown }> }> };
    expect(body.servers.map((row) => row.server)).toEqual(["Fake Tools", "Needs Auth", "No Store"]);
    const fake = body.servers[0]!;
    expect(fake.authStatus).toBe("not_required");
    expect(fake.tools.map((t) => t.name)).toEqual(["echo", "write", "plain", "fail", "slow", "flaky", "image"]);
    expect(fake.tools[0]!.annotations).toEqual({ readOnlyHint: true });
    expect(fake.tools[2]!.annotations).toBeUndefined();
    expect(body.servers[1]).toEqual({ server: "Needs Auth", authStatus: "token_invalid", tools: [] });
    expect(body.servers[2]!.tools.map((t) => t.name)).toEqual(["echo"]);
  });

  it("intersects: a tool the manifest does not name is not listed", async () => {
    const narrow = await create(server, { mcp: { config: { servers: [{ server: "Fake Tools", tools: ["echo", "nope"] }] } } });
    const response = await servers({ artifactId: narrow });
    const body = (await response.json()) as { servers: Array<{ tools: Array<{ name: string }> }> };
    expect(body.servers[0]!.tools.map((t) => t.name)).toEqual(["echo"]);
  });
});

describe("POST /api/frame/mcp/call", () => {
  it("runs a tool and returns the connector's result as it came", async () => {
    const before = fakeCallCount();
    const response = await call({ server: "Fake Tools", tool: "echo", input: { hello: "there" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-mcp-no-store")).toBeNull();
    const body = (await response.json()) as { result: Record<string, unknown> };
    expect(body.result.structuredContent).toEqual({ echo: { hello: "there" }, call: before + 1 });
    expect(body.result.content).toEqual([{ type: "text", text: JSON.stringify({ echo: { hello: "there" }, call: before + 1 }) }]);
    expect("isError" in body.result).toBe(false);
  });

  it("returns a tool-level failure as a 200 with isError", async () => {
    const response = await call({ server: "Fake Tools", tool: "fail" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { isError: true } });
  });

  it("marks results from a no-store connector", async () => {
    const response = await call({ server: "No Store", tool: "echo", input: {} });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-mcp-no-store")).toBe("1");
  });

  it("refuses what the manifest does not name, and host: servers", async () => {
    const outside = await call({ server: "Fake Tools", tool: "nope", input: {} });
    expect(outside.status).toBe(400);
    expect(await outside.json()).toMatchObject({ code: "not_in_manifest" });
    const host = await call({ server: "host:local", tool: "read_file", input: {} });
    expect(host.status).toBe(404);
    expect(await host.json()).toMatchObject({ code: "server_not_connected" });
    const nowhere = await call({ server: "Nowhere", tool: "x", input: {} });
    expect(nowhere.status).toBe(404);
    expect(await nowhere.json()).toMatchObject({ code: "server_not_connected", server: "Nowhere" });
  });

  it("refuses arguments that are not a plain JSON object", async () => {
    const list = await call({ server: "Fake Tools", tool: "echo", input: [1, 2] });
    expect(list.status).toBe(400);
    expect(await list.json()).toMatchObject({ code: "bad_request" });
    const missing = await call({ server: "Fake Tools", tool: "echo" });
    expect(missing.status).toBe(200);
  });

  it("maps connector failures to the page's codes and statuses", async () => {
    const reauth = await call({ server: "Needs Auth", tool: "anything", input: {} });
    expect(reauth.status).toBe(401);
    expect(await reauth.json()).toMatchObject({ code: "needs_reauth", server: "Needs Auth" });
    const flaky = await call({ server: "Fake Tools", tool: "flaky", input: {} });
    expect(flaky.status).toBe(503);
    expect(await flaky.json()).toMatchObject({ code: "server_unavailable", retryable: true, retryAfterMs: 1_000 });
  });

  it("caps calls one viewer may run at once", async () => {
    const before = fakeCallCount();
    const slow = Array.from({ length: 8 }, () => call({ server: "Fake Tools", tool: "slow", input: { ms: 800 } }));
    // The slow tool counts its call as it starts: wait until all eight run.
    await waitFor(() => fakeCallCount() === before + 8);
    const ninth = await call({ server: "Fake Tools", tool: "echo", input: {} });
    expect(ninth.status).toBe(429);
    expect(await ninth.json()).toMatchObject({ code: "rate_limited", retryable: true });
    const done = await Promise.all(slow);
    expect(done.every((r) => r.status === 200)).toBe(true);
    const tenth = await call({ server: "Fake Tools", tool: "echo", input: {} });
    expect(tenth.status).toBe(200);
  });

  it("aborts the connector call when the client goes away", async () => {
    const before = fakeCallCount();
    const controller = new AbortController();
    const pending = fetch(`${server.shellOrigin}/api/frame/mcp/call`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ artifactId, server: "Fake Tools", tool: "slow", input: { ms: 3_000 } }),
      signal: controller.signal,
    });
    await waitFor(() => fakeCallCount() === before + 1);
    const started = Date.now();
    controller.abort();
    await expect(pending).rejects.toThrow();
    // The connector's own promise settles promptly on the abort rather than
    // after three seconds: a second call is admitted at once.
    const next = await call({ server: "Fake Tools", tool: "echo", input: {} });
    expect(next.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

async function waitFor(condition: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
