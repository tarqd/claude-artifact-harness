/**
 * The shell side: consent, the reply cache, concurrency, and the translation
 * of the backend's event stream into `__frame_cap_p` progress. The backend is
 * a fake `fetch`, so nothing here needs a server or a key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheKey,
  cachePolicy,
  consentKey,
  dispose,
  handle,
  resetSampleBrokerState,
  sseFrames,
} from "../../src/capabilities/sample/broker.ts";
import type { BrokerCall, BrokerContext, ShellBoot } from "../../src/shell/types.ts";
import type { SampleEvent } from "../../src/capabilities/sample/protocol.ts";

const ARTIFACT = "0123456789abcdef0123456789abcdef";

function boot(): ShellBoot {
  return {
    artifactId: ARTIFACT,
    version: "v1",
    title: "T",
    frameOrigin: "http://frame.test",
    frameUrl: "http://frame.test/_f/v1/",
    contract: "0.2.32",
    changes: [],
    flags: [],
    capabilities: { sample: { config: {} } },
    viewer: { id: "u_00000000000000000000AA", level: "interact", canEdit: false, isOwner: false },
    versionPollMs: 0,
  };
}

interface Ctx extends BrokerContext {
  progressed: Array<{ id: string; p: unknown }>;
  acked: string[];
  apiCalls: Array<{ path: string; body: unknown }>;
}

function context(overrides: Partial<BrokerContext> = {}): Ctx {
  const progressed: Array<{ id: string; p: unknown }> = [];
  const acked: string[] = [];
  const apiCalls: Array<{ path: string; body: unknown }> = [];
  const base = boot();
  const ctx: Ctx = {
    boot: base,
    version: "v1",
    viewer: base.viewer,
    flags: new Set(),
    toFrame: vi.fn(),
    ack: (id: string) => acked.push(id),
    progress: (id: string, p: unknown) => progressed.push({ id, p }),
    reloadView: vi.fn(),
    setVersion: vi.fn(),
    consent: vi.fn(async () => true),
    api: (async (path: string, init?: RequestInit) => {
      apiCalls.push({ path, body: JSON.parse(String(init?.body ?? "null")) as unknown });
      return { ok: true };
    }) as BrokerContext["api"],
    progressed,
    acked,
    apiCalls,
    ...overrides,
  } as Ctx;
  return ctx;
}

function call(args: unknown[], id = "a1", method = "sample"): BrokerCall {
  return { cap: "sample", id, method, args };
}

/* ------------------------------- fake fetch ------------------------------- */

function encodeEvents(events: SampleEvent[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

interface FetchLog {
  bodies: Array<Record<string, unknown>>;
  count: number;
}

/** A backend that answers each request with the same canned event list. */
function stubFetch(events: SampleEvent[]): FetchLog {
  const log: FetchLog = { bodies: [], count: 0 };
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    log.count++;
    log.bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(encodeEvents(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  return log;
}

/** A backend whose stream stays open until the test pushes into it. */
function liveFetch(): {
  log: FetchLog;
  push(event: SampleEvent): void;
  close(): void;
  /** Stop answering: the open stream errors and later requests fail at once. */
  stop(): void;
  opened: Promise<void>;
} {
  const log: FetchLog = { bodies: [], count: 0 };
  let stopped = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const encoder = new TextEncoder();
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    log.count++;
    log.bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        if (stopped) {
          c.error(new Error("backend stopped"));
          return;
        }
        controller = c;
        init.signal?.addEventListener("abort", () => {
          try {
            c.error(new DOMException("aborted", "AbortError"));
          } catch {
            /* already closed */
          }
        });
        open();
      },
    });
    return new Response(stream, { status: 200 });
  });
  return {
    log,
    opened,
    push: (event) => controller?.enqueue(encoder.encode(encodeEvents([event]))),
    close: () => controller?.close(),
    stop() {
      stopped = true;
      try {
        controller?.error(new Error("backend stopped"));
      } catch {
        /* already closed */
      }
    },
  };
}

const ANSWER: SampleEvent[] = [
  { type: "start", modelTierApplied: "default" },
  { type: "text", text: "he" },
  { type: "text", text: "llo" },
  { type: "done", truncated: false },
];

/* --------------------------------- storage -------------------------------- */

function fakeStorage(initial: Record<string, string> = {}): Map<string, string> {
  const map = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => map.set(k, v),
      removeItem: (k: string) => map.delete(k),
    },
  });
  return map;
}

beforeEach(() => {
  resetSampleBrokerState();
  fakeStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis as object, "localStorage");
});

/* --------------------------------- tests ---------------------------------- */

describe("sse framing", () => {
  it("reassembles data lines across chunk boundaries", () => {
    const first = sseFrames('event: text\ndata: {"a":', "");
    expect(first.frames).toEqual([]);
    const second = sseFrames('1}\n\nevent: done\ndata: {"b":2}\n\n', first.carry);
    expect(second.frames).toEqual(['{"a":1}', '{"b":2}']);
    expect(second.carry).toBe("");
  });
});

describe("consent", () => {
  it("asks once, acks while the dialog is up, and remembers the answer", async () => {
    const store = fakeStorage();
    stubFetch(ANSWER);
    const ctx = context();
    await handle(call(["hi"]), ctx);
    expect(ctx.acked).toEqual(["a1"]);
    expect(ctx.consent).toHaveBeenCalledTimes(1);
    expect(store.get(consentKey(ARTIFACT))).toBe("granted");

    await handle(call(["hi 2"], "a2"), ctx);
    expect(ctx.consent).toHaveBeenCalledTimes(1);
    expect(ctx.acked).toEqual(["a1"]);
  });

  it("rejects not_granted after a decline and never asks again", async () => {
    const store = fakeStorage();
    stubFetch(ANSWER);
    const ctx = context({ consent: vi.fn(async () => false) });
    await expect(handle(call(["hi"]), ctx)).rejects.toMatchObject({ code: "not_granted" });
    expect(store.get(consentKey(ARTIFACT))).toBe("denied");
    await expect(handle(call(["hi"], "a2"), ctx)).rejects.toMatchObject({ code: "not_granted" });
    expect(ctx.consent).toHaveBeenCalledTimes(1);
  });

  it("holds every waiting call behind one dialog", async () => {
    stubFetch(ANSWER);
    let release!: (granted: boolean) => void;
    const ctx = context({
      consent: vi.fn(() => new Promise<boolean>((resolve) => (release = resolve))),
    });
    const first = handle(call(["a"], "a1"), ctx);
    const second = handle(call(["b"], "a2"), ctx);
    await Promise.resolve();
    release(true);
    await Promise.all([first, second]);
    expect(ctx.consent).toHaveBeenCalledTimes(1);
    expect(ctx.acked).toEqual(["a1", "a2"]);
  });

  it("takes a stored grant without a dialog", async () => {
    fakeStorage({ [consentKey(ARTIFACT)]: "granted" });
    stubFetch(ANSWER);
    const ctx = context();
    await handle(call(["hi"]), ctx);
    expect(ctx.consent).not.toHaveBeenCalled();
    expect(ctx.acked).toEqual([]);
  });
});

describe("streaming", () => {
  beforeEach(() => fakeStorage({ [consentKey(ARTIFACT)]: "granted" }));

  it("forwards each delta as progress and resolves the whole answer", async () => {
    const log = stubFetch(ANSWER);
    const ctx = context();
    const result = await handle(call(["hi", "quick"]), ctx);
    expect(result).toEqual({ text: "hello", truncated: false, modelTierApplied: "default" });
    expect(ctx.progressed).toEqual([
      { id: "a1", p: { type: "text", text: "he" } },
      { id: "a1", p: { type: "text", text: "llo" } },
    ]);
    expect(log.bodies[0]).toMatchObject({ artifactId: ARTIFACT, input: "hi", modelTier: "quick" });
  });

  it("reports truncation and turns an error event into that code", async () => {
    stubFetch([
      { type: "start", modelTierApplied: "complex" },
      { type: "text", text: "cut" },
      { type: "done", truncated: true },
    ]);
    await expect(handle(call(["hi"]), context())).resolves.toEqual({
      text: "cut",
      truncated: true,
      modelTierApplied: "complex",
    });

    stubFetch([
      { type: "start", modelTierApplied: "default" },
      { type: "error", code: "refused", message: "no" },
    ]);
    // a different prompt, so the answer above is not replayed from the cache
    await expect(handle(call(["refuse me"], "a2"), context())).rejects.toMatchObject({
      code: "refused",
      message: "no",
    });
  });

  it("rejects empty_completion when no text arrived", async () => {
    stubFetch([
      { type: "start", modelTierApplied: "default" },
      { type: "done", truncated: false },
    ]);
    await expect(handle(call(["hi"]), context())).rejects.toMatchObject({
      code: "empty_completion",
    });
  });

  it("re-validates the frame's arguments", async () => {
    stubFetch(ANSWER);
    const ctx = context();
    await expect(handle(call([""]), ctx)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(handle(call(["x".repeat(70_000)]), ctx)).rejects.toMatchObject({
      code: "prompt_too_large",
    });
    await expect(handle(call(["hi", "turbo"]), ctx)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(handle(call(["hi"], "a1", "explode"), ctx)).rejects.toMatchObject({
      code: "capability_disabled",
    });
  });
});

describe("caching", () => {
  beforeEach(() => fakeStorage({ [consentKey(ARTIFACT)]: "granted" }));

  it("keys on verb, tier, input and images", () => {
    const base = {
      artifactId: ARTIFACT,
      viewerId: "u_1",
      verb: "sample" as const,
      input: "hi",
      modelTier: "default" as const,
      images: [],
    };
    expect(cacheKey(base)).toBe(cacheKey({ ...base }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, verb: "json" }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, modelTier: "quick" }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, input: "hello" }));
    expect(cacheKey(base)).not.toBe(
      cacheKey({ ...base, images: [{ mediaType: "image/png", data: "AAA" }] }),
    );
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, viewerId: "u_2" }));
  });

  it("reads the policy the page asked for", () => {
    expect(cachePolicy(undefined, false)).toEqual({ read: true, write: true, gcTime: 300_000 });
    expect(cachePolicy(false, false)).toEqual({ read: false, write: false, gcTime: 0 });
    expect(cachePolicy({ refresh: true }, false)).toMatchObject({ read: false, write: true });
    expect(cachePolicy({ gcTime: 1000 }, false).gcTime).toBe(1000);
    expect(cachePolicy({ gcTime: 1e12 }, false).gcTime).toBe(86_400_000);
    expect(cachePolicy(undefined, true)).toEqual({ read: false, write: false, gcTime: 0 });
  });

  it("replays a stored answer, still streaming it, and honours cache: false", async () => {
    const log = stubFetch(ANSWER);
    const ctx = context();
    await handle(call(["hi"]), ctx);
    const replay = await handle(call(["hi"], "a2"), ctx);
    expect(log.count).toBe(1);
    expect(replay).toMatchObject({ text: "hello" });
    // the replay reaches the page as one delta, so onText still renders
    expect(ctx.progressed.at(-1)).toEqual({ id: "a2", p: { type: "text", text: "hello" } });

    await handle(call(["hi", undefined, { cache: false }], "a3"), ctx);
    expect(log.count).toBe(2);
    await handle(call(["hi", undefined, { cache: { refresh: true } }], "a4"), ctx);
    expect(log.count).toBe(3);
    // a different tier is a different question
    await handle(call(["hi", "quick"], "a5"), ctx);
    expect(log.count).toBe(4);
  });

  it("expires an answer after gcTime", async () => {
    const log = stubFetch(ANSWER);
    const ctx = context();
    vi.useFakeTimers();
    try {
      await handle(call(["hi", undefined, { cache: { gcTime: 1000 } }]), ctx);
      vi.setSystemTime(Date.now() + 2000);
      await handle(call(["hi", undefined, { cache: { gcTime: 1000 } }], "a2"), ctx);
    } finally {
      vi.useRealTimers();
    }
    expect(log.count).toBe(2);
  });

  it("never caches a json reply that was cut short", async () => {
    const log = stubFetch([
      { type: "start", modelTierApplied: "default" },
      { type: "text", text: '{"a":1}' },
      { type: "done", truncated: true },
    ]);
    const ctx = context();
    // It parses, but the frame rejects invalid_json for a truncated reply, so
    // "Try again" has to reach the backend again.
    await handle(call(["cut", undefined, { format: "json" }]), ctx);
    await handle(call(["cut", undefined, { format: "json" }], "a2"), ctx);
    expect(log.count).toBe(2);
  });

  it("never caches a call with tools, nor a json reply that holds no JSON", async () => {
    const log = stubFetch(ANSWER);
    const ctx = context();
    const tools = [{ name: "t", description: "d" }];
    await handle(call(["hi", undefined, { tools }]), ctx);
    await handle(call(["hi", undefined, { tools }], "a2"), ctx);
    expect(log.count).toBe(2);

    await handle(call(["j", undefined, { format: "json" }], "a3"), ctx);
    await handle(call(["j", undefined, { format: "json" }], "a4"), ctx);
    expect(log.count).toBe(4); // "hello" is not JSON, so nothing was stored
  });
});

describe("tool rounds and cancellation", () => {
  beforeEach(() => fakeStorage({ [consentKey(ARTIFACT)]: "granted" }));

  it("forwards tool_use and posts the page's results to the backend", async () => {
    const live = liveFetch();
    const ctx = context();
    const promise = handle(call(["hi", undefined, { tools: [{ name: "t", description: "d" }] }]), ctx);
    await live.opened;
    live.push({ type: "start", modelTierApplied: "default" });
    live.push({ type: "tool_use", calls: [{ id: "t1", name: "t", input: {} }] });
    await vi.waitFor(() => expect(ctx.progressed.length).toBeGreaterThan(0));
    expect(ctx.progressed[0]?.p).toEqual({
      type: "tool_use",
      calls: [{ id: "t1", name: "t", input: {} }],
    });

    await handle(call(["a1", [{ id: "t1", content: "42" }]], "a2", "toolResults"), ctx);
    expect(ctx.apiCalls[0]?.path).toBe("/api/frame/sample/tool_results");
    expect(ctx.apiCalls[0]?.body).toEqual({
      callId: live.log.bodies[0]?.callId,
      results: [{ id: "t1", content: "42" }],
    });

    live.push({ type: "text", text: "done" });
    live.push({ type: "done", truncated: false });
    live.close();
    await expect(promise).resolves.toMatchObject({ text: "done" });

    // once the call is over, late results are simply dropped
    await expect(
      handle(call(["a1", []], "a3", "toolResults"), ctx),
    ).resolves.toEqual({ ok: false });
  });

  it("cancelCall aborts the backend request", async () => {
    const live = liveFetch();
    const ctx = context();
    const promise = handle(call(["hi"]), ctx);
    await live.opened;
    live.push({ type: "start", modelTierApplied: "default" });
    await handle(call(["a1"], "a2", "cancelCall"), ctx);
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
  });

  it("cancelCall stops a call still held for the consent dialog", async () => {
    fakeStorage();
    const log = stubFetch(ANSWER);
    let release!: (granted: boolean) => void;
    const ctx = context({
      consent: vi.fn(() => new Promise<boolean>((resolve) => (release = resolve))),
    });
    const promise = handle(call(["hi"]), ctx).catch((err: unknown) => err);
    await vi.waitFor(() => expect(ctx.acked).toEqual(["a1"]));
    await handle(call(["a1"], "a2", "cancelCall"), ctx);
    release(true);
    await expect(promise).resolves.toMatchObject({ code: "cancelled" });
    // Nothing was spent: the backend was never asked.
    expect(log.count).toBe(0);
  });

  it("cancelCall stops a call still waiting for a slot", async () => {
    const live = liveFetch();
    const ctx = context();
    const running = [0, 1, 2].map((i) =>
      handle(call([`r${i}`], `r${i}`), ctx).catch((err: unknown) => err),
    );
    await vi.waitFor(() => expect(live.log.count).toBe(3));
    const queued = handle(call(["q"], "q1"), ctx).catch((err: unknown) => err);
    await vi.waitFor(() => expect(ctx.acked).toContain("q1"));
    await handle(call(["q1"], "c1", "cancelCall"), ctx);
    await expect(queued).resolves.toMatchObject({ code: "cancelled" });
    expect(live.log.count).toBe(3);

    live.stop();
    dispose(ctx);
    await Promise.all(running);
  });

  it("a remounted view abandons every call it held", async () => {
    const live = liveFetch();
    const ctx = context();
    const promise = handle(call(["hi"]), ctx);
    await live.opened;
    dispose(ctx);
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("concurrency", () => {
  beforeEach(() => fakeStorage({ [consentKey(ARTIFACT)]: "granted" }));

  it("runs a few at a time, queues the next few, and refuses a flood", async () => {
    const live = liveFetch();
    const ctx = context();
    const calls: Array<Promise<unknown>> = [];
    for (let i = 0; i < 8; i++) {
      calls.push(handle(call([`q${i}`], `a${i}`), ctx).catch((err: unknown) => err));
    }
    await live.opened;
    await vi.waitFor(() => expect(live.log.count).toBe(3));
    // three run, five wait, and the ninth is a flood
    const flooded = await handle(call(["q9"], "a9"), ctx).catch((err: unknown) => err);
    expect(flooded).toMatchObject({ code: "rate_limited" });
    expect(ctx.acked).toContain("a3");

    // Tearing the view down ends the running calls; the queued ones then find
    // a backend that is gone. Either way every promise settles.
    live.stop();
    dispose(ctx);
    const settled = await Promise.all(calls);
    expect(settled.every((s) => typeof (s as { code?: string }).code === "string")).toBe(true);
  });
});
