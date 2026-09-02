/**
 * The backend, over real sockets, with the deterministic fake model
 * (`SAMPLE_BACKEND=fake`) so no key and no network are needed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Streams, openStreamCount } from "../../src/capabilities/sample/server.ts";
import { startServer, type RunningServer } from "../../src/server/index.ts";
import type { SampleEvent } from "../../src/capabilities/sample/protocol.ts";

let server: RunningServer;
let readOnly: RunningServer;
let dataDir: string;
let artifactId: string;
let plainId: string;
/** Declares `sample`, but neither images nor tools. */
let bareId: string;
let cookie: string;

const PAGE = "<p>sample fixture</p>";

async function create(
  target: RunningServer,
  capabilities: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(`${target.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ html: PAGE, capabilities }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

async function callSample(
  body: Record<string, unknown>,
  target: RunningServer = server,
): Promise<Response> {
  return fetch(`${target.shellOrigin}/api/frame/sample/call`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ artifactId, ...body }),
  });
}

async function* events(response: Response): AsyncGenerator<SampleEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      carry += decoder.decode(value, { stream: true });
      const parts = carry.split("\n\n");
      carry = parts.pop() ?? "";
      for (const part of parts) {
        const data = part
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (data) yield JSON.parse(data) as SampleEvent;
      }
    }
  } finally {
    // Leaving early must hang up on the server, or its stream stays open.
    await reader.cancel().catch(() => undefined);
  }
}

async function collect(response: Response): Promise<SampleEvent[]> {
  const out: SampleEvent[] = [];
  for await (const event of events(response)) out.push(event);
  return out;
}

function textOf(list: SampleEvent[]): string {
  return list
    .filter((e): e is Extract<SampleEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("");
}

let callSeq = 0;
const nextCallId = (): string => `call-${++callSeq}-${Math.random().toString(36).slice(2)}`;

beforeAll(async () => {
  process.env.SAMPLE_BACKEND = "fake";
  dataDir = await mkdtemp(join(tmpdir(), "sample-server-"));
  server = await startServer({ shellPort: 0, framePort: 0, dataDir, openAdminApi: true });
  readOnly = await startServer({
    shellPort: 0,
    framePort: 0,
    dataDir,
    openAdminApi: true,
    defaultLevel: "view",
  });
  artifactId = await create(server, { sample: { config: { images: {}, tools: {} } } });
  bareId = await create(server, { sample: {} });
  plainId = await create(server, { db: {} });
  // One viewer identity for every request in this file: the tool-results lane
  // only answers the viewer whose call is waiting.
  const page = await fetch(`${server.shellOrigin}/a/${artifactId}`);
  cookie = (page.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).toMatch(/^av=/);
});

afterAll(async () => {
  delete process.env.SAMPLE_BACKEND;
  await Promise.all([server.close(), readOnly.close()]);
  await rm(dataDir, { recursive: true, force: true });
});

describe("POST /api/frame/sample/call", () => {
  it("streams start, text deltas and done", async () => {
    const response = await callSample({ callId: nextCallId(), input: "hello there" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const list = await collect(response);
    expect(list[0]).toEqual({ type: "start", modelTierApplied: "default" });
    expect(list.at(-1)).toEqual({ type: "done", truncated: false });
    expect(list.filter((e) => e.type === "text").length).toBeGreaterThan(1);
    expect(textOf(list)).toMatch(/^echo #\d+ \(default\): hello there$/);
  });

  it("applies the tier it was asked for", async () => {
    const list = await collect(
      await callSample({ callId: nextCallId(), input: "hi", modelTier: "quick" }),
    );
    expect(list[0]).toEqual({ type: "start", modelTierApplied: "quick" });
    expect(textOf(list)).toContain("(quick)");
  });

  it("answers json format with a parseable value", async () => {
    const list = await collect(
      await callSample({ callId: nextCallId(), input: "give me json", format: "json" }),
    );
    expect(JSON.parse(textOf(list))).toMatchObject({ tier: "default", echo: "give me json" });
  });

  it("reports truncation and backend errors as events", async () => {
    const truncated = await collect(
      await callSample({ callId: nextCallId(), input: "!truncate please" }),
    );
    expect(truncated.at(-1)).toEqual({ type: "done", truncated: true });

    const failed = await collect(
      await callSample({ callId: nextCallId(), input: "!error:rate_limited" }),
    );
    expect(failed.at(-1)).toMatchObject({ type: "error", code: "rate_limited" });
  });

  it("runs one tool round through the tool_results lane", async () => {
    const callId = nextCallId();
    const response = await callSample({
      callId,
      input: "use the tool",
      tools: [{ name: "page_title", description: "the page title" }],
    });
    const seen: SampleEvent[] = [];
    for await (const event of events(response)) {
      seen.push(event);
      if (event.type === "tool_use") {
        expect(event.calls[0]).toMatchObject({ name: "page_title" });
        const reply = await fetch(`${server.shellOrigin}/api/frame/sample/tool_results`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({
            callId,
            results: [{ id: event.calls[0]?.id, content: "Sample fixture" }],
          }),
        });
        expect(reply.status).toBe(200);
      }
    }
    expect(textOf(seen)).toContain("[page_title -> Sample fixture]");
    expect(seen.at(-1)).toEqual({ type: "done", truncated: false });
  });

  it("refuses tool results for a call nobody is waiting on", async () => {
    const response = await fetch(`${server.shellOrigin}/api/frame/sample/tool_results`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ callId: "nope", results: [] }),
    });
    expect(response.status).toBe(404);
  });

  it("refuses another viewer's tool results", async () => {
    const callId = nextCallId();
    const response = await callSample({
      callId,
      input: "use the tool",
      tools: [{ name: "t", description: "d" }],
    });
    const iterator = events(response);
    let toolCallId = "";
    for await (const event of iterator) {
      if (event.type === "tool_use") {
        toolCallId = event.calls[0]?.id ?? "";
        break;
      }
    }
    expect(toolCallId).not.toBe("");
    const stranger = await fetch(`${server.shellOrigin}/api/frame/sample/tool_results`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callId, results: [{ id: toolCallId, content: "x" }] }),
    });
    expect(stranger.status).toBe(403);
    await iterator.return(undefined);
  });

  it("refuses a bad body, an unknown artifact and one that does not declare sample", async () => {
    expect((await callSample({ input: "hi" })).status).toBe(400);
    expect((await callSample({ callId: nextCallId(), input: "" })).status).toBe(400);
    expect(
      (await callSample({ callId: nextCallId(), input: "x".repeat(70_000) })).status,
    ).toBe(400);

    const missing = await fetch(`${server.shellOrigin}/api/frame/sample/call`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        callId: nextCallId(),
        artifactId: "ffffffffffffffffffffffffffffffff",
        input: "hi",
      }),
    });
    expect(missing.status).toBe(404);

    const undeclared = await fetch(`${server.shellOrigin}/api/frame/sample/call`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ callId: nextCallId(), artifactId: plainId, input: "hi" }),
    });
    expect(undeclared.status).toBe(400);
    expect((await undeclared.json()) as { code: string }).toMatchObject({ code: "not_declared" });
  });

  it("refuses images and tools the artifact never declared", async () => {
    const withTools = await fetch(`${server.shellOrigin}/api/frame/sample/call`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        callId: nextCallId(),
        artifactId: bareId,
        input: "hi",
        tools: [{ name: "t", description: "d" }],
      }),
    });
    expect(withTools.status).toBe(400);
    expect((await withTools.json()) as { code: string }).toMatchObject({
      code: "tools_unavailable",
    });

    const withImages = await fetch(`${server.shellOrigin}/api/frame/sample/call`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        callId: nextCallId(),
        artifactId: bareId,
        input: "hi",
        images: [{ mediaType: "image/png", data: "AAAA" }],
      }),
    });
    expect(withImages.status).toBe(400);
    expect((await withImages.json()) as { code: string }).toMatchObject({
      code: "images_unavailable",
    });
  });

  it("caps images by count, type and size even when they are declared", async () => {
    const image = { mediaType: "image/png", data: "A".repeat(1000) };
    const many = await callSample({
      callId: nextCallId(),
      input: "hi",
      images: Array.from({ length: 5 }, () => image),
    });
    expect(many.status).toBe(400);
    expect((await many.json()) as { code: string }).toMatchObject({ code: "image_rejected" });

    const wrongType = await callSample({
      callId: nextCallId(),
      input: "hi",
      images: [{ mediaType: "text/html", data: "AAAA" }],
    });
    expect(wrongType.status).toBe(400);
    expect((await wrongType.json()) as { code: string }).toMatchObject({ code: "image_rejected" });

    const huge = await callSample({
      callId: nextCallId(),
      input: "hi",
      images: [{ mediaType: "image/png", data: "A".repeat(3_000_000) }],
    });
    expect(huge.status).toBe(400);
    expect((await huge.json()) as { code: string }).toMatchObject({ code: "image_rejected" });
  });

  it("caps how many tools one call may offer", async () => {
    const response = await callSample({
      callId: nextCallId(),
      input: "hi",
      tools: Array.from({ length: 17 }, (_, i) => ({ name: `t${i}`, description: "d" })),
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "invalid_request" });
  });

  it("refuses a body larger than the limit before parsing it", async () => {
    const response = await fetch(`${server.shellOrigin}/api/frame/sample/call`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        callId: nextCallId(),
        artifactId,
        input: "hi",
        pad: "x".repeat(8_100_000),
      }),
    });
    expect(response.status).toBe(413);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "too_large" });
  });

  it("refuses a view-only viewer", async () => {
    const response = await fetch(`${readOnly.shellOrigin}/api/frame/sample/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callId: nextCallId(), artifactId, input: "hi" }),
    });
    expect(response.status).toBe(403);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "not_granted" });
  });

  it("says so when no key and no fake backend are configured", async () => {
    delete process.env.SAMPLE_BACKEND;
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const response = await callSample({ callId: nextCallId(), input: "hi" });
      expect(response.status).toBe(503);
      expect((await response.json()) as { code: string }).toMatchObject({
        code: "sampling_disabled",
      });
    } finally {
      process.env.SAMPLE_BACKEND = "fake";
      if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
    }
  });
});

/* ------------------------------ concurrency ------------------------------- */

/** A prompt the fake backend answers slowly enough to hold a stream open. */
const HOLD = `!slow ${"x".repeat(4_000)}`;

/** A viewer cookie of its own, as a first visit to the shell page mints one. */
async function mintCookie(): Promise<string> {
  const page = await fetch(`${server.shellOrigin}/a/${artifactId}`);
  const minted = (page.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(minted).toMatch(/^av=/);
  return minted;
}

/** One call, with the given cookie or none at all, abortable by the caller. */
function open(signal: AbortSignal, jar: string | null, input: string): Promise<Response> {
  return fetch(`${server.shellOrigin}/api/frame/sample/call`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(jar === null ? {} : { cookie: jar }) },
    body: JSON.stringify({ callId: nextCallId(), artifactId, input }),
    signal,
  });
}

/** `n` calls at once on one cookie, every one held open until `signal` fires. */
function hold(signal: AbortSignal, jar: string | null, n: number): Promise<Response[]> {
  return Promise.all(Array.from({ length: n }, () => open(signal, jar, HOLD)));
}

async function waitFor(predicate: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`condition never held (open streams: ${openStreamCount()})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The caps are absolute, so every test here starts from an idle server. */
async function idle(): Promise<void> {
  await waitFor(() => openStreamCount() === 0);
}

describe("concurrency caps", () => {
  beforeEach(idle);

  it("charges cookie-less callers one budget, not a fresh one each", async () => {
    const controller = new AbortController();
    try {
      const held = await hold(controller.signal, null, 8);
      expect(held.every((r) => r.status === 200)).toBe(true);
      await waitFor(() => openStreamCount() === 8);
      // Nine cookie-less calls used to be nine viewers: each request minted
      // its own id, so each got its own eight-stream budget.
      const ninth = await open(controller.signal, null, "hi");
      expect(ninth.status).toBe(429);
      expect((await ninth.json()) as { code: string }).toMatchObject({ code: "rate_limited" });
      // And a refusal hands out no identity, so the caller it refused cannot
      // pocket a cookie from it and come back with a budget of its own.
      expect(ninth.headers.get("set-cookie")).toBe(null);
      // A viewer holding a cookie of their own still gets their own budget.
      const legit = await open(controller.signal, await mintCookie(), "hello there");
      expect(legit.status).toBe(200);
      expect(textOf(await collect(legit))).toContain("hello there");
    } finally {
      controller.abort();
      await idle().catch(() => undefined);
    }
  }, 30_000);

  it("caps one address however many cookies it farms", async () => {
    const controller = new AbortController();
    try {
      const [first, second, third] = await Promise.all([
        mintCookie(),
        mintCookie(),
        mintCookie(),
      ]);
      // Two viewers from one address, each inside their own budget: both are
      // served, so the address bound is worth more than one viewer's.
      const held = [
        ...(await hold(controller.signal, first, 8)),
        ...(await hold(controller.signal, second, 8)),
      ];
      expect(held.every((r) => r.status === 200)).toBe(true);
      await waitFor(() => openStreamCount() === 16);
      // A third cookie off the same address buys nothing: a stream is charged
      // to its address as well as to its viewer, so farming cookies — which
      // any visit to the shell page hands out — no longer walks past the cap.
      const farmed = await open(controller.signal, third, "hi");
      expect(farmed.status).toBe(429);
      expect((await farmed.json()) as { code: string }).toMatchObject({ code: "rate_limited" });
      // Nor does dropping the cookie again.
      const bare = await open(controller.signal, null, "hi");
      expect(bare.status).toBe(429);
      expect(openStreamCount()).toBe(16);
    } finally {
      controller.abort();
      await idle().catch(() => undefined);
    }
  }, 30_000);

  it("frees a slot when the stream ends, so the next call goes through", async () => {
    const jar = await mintCookie();
    for (let i = 0; i < 10; i++) {
      const response = await fetch(`${server.shellOrigin}/api/frame/sample/call`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: jar },
        body: JSON.stringify({ callId: nextCallId(), artifactId, input: "hi" }),
      });
      expect(response.status).toBe(200);
      await collect(response);
    }
    await idle();
  }, 30_000);
});

/**
 * The server-wide bound sits above the per-address one, so one address — all
 * a test has — cannot reach it over HTTP: the accounting is driven directly.
 */
describe("Streams accounting", () => {
  function fill(streams: Streams, caller: string, address: string, n: number): (() => void)[] {
    return Array.from({ length: n }, () => {
      const release = streams.take(caller, address);
      expect(release).not.toBe(null);
      return release as () => void;
    });
  }

  it("holds one caller to 8 streams and one address to 16", () => {
    const streams = new Streams();
    fill(streams, "viewer:a", "10.0.0.1", 8);
    expect(streams.take("viewer:a", "10.0.0.1")).toBe(null);
    // A second viewer behind that address is still served...
    fill(streams, "viewer:b", "10.0.0.1", 8);
    expect(streams.open).toBe(16);
    // ...and a third is not: the address is at a bound of its own.
    expect(streams.take("viewer:c", "10.0.0.1")).toBe(null);
    // Another address is untouched by all of it.
    expect(streams.take("viewer:c", "10.0.0.2")).not.toBe(null);
  });

  it("holds the server to 32 streams however many addresses ask", () => {
    const streams = new Streams();
    for (let i = 0; i < 4; i++) fill(streams, `viewer:${i}`, `10.0.0.${i}`, 8);
    expect(streams.open).toBe(32);
    // A fresh viewer at a fresh address, inside both of the other bounds,
    // still waits: the server has no stream left to give.
    expect(streams.take("viewer:new", "10.0.9.9")).toBe(null);
  });

  it("gives a slot back on release, and only once", () => {
    const streams = new Streams();
    const [release] = fill(streams, "viewer:a", "10.0.0.1", 8);
    expect(streams.take("viewer:a", "10.0.0.1")).toBe(null);
    release!();
    release!();
    expect(streams.open).toBe(7);
    expect(streams.take("viewer:a", "10.0.0.1")).not.toBe(null);
  });
});
