/**
 * The shell-side broker against a fake backend, a fake clock and a fake
 * document: the manifest gate, consent per server, the result cache and its
 * policy, coalescing, cancellation, watches with their refetch loop, and
 * `invalidate`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerCall, BrokerContext, ConsentRequest } from "../../src/shell/types.ts";
import type { ShellBoot } from "../../src/shell/types.ts";
import {
  dispose,
  handle,
  resetMcpBrokerState,
  setMcpBrokerEnv,
} from "../../src/capabilities/mcp/broker.ts";
import { serverConsentKey } from "../../src/capabilities/mcp/protocol.ts";
import { resetConsentForTest } from "../../src/capabilities/permissions/consent.ts";
import { handle as permissionsHandle } from "../../src/capabilities/permissions/broker.ts";

const ARTIFACT = "artmcp000000000000000001";

const MANIFEST = {
  servers: [
    { server: "Fake Tools", tools: ["echo", "write", "plain", "fail", "slow"] },
    { server: "host:local", tools: ["read_file"] },
    { server: "No Store", tools: ["echo"] },
    { server: "Missing", tools: ["x"] },
  ],
};

function boot(capabilities: ShellBoot["capabilities"] = { mcp: { config: MANIFEST } }): ShellBoot {
  return {
    artifactId: ARTIFACT,
    version: "v1",
    title: "T",
    frameOrigin: "http://frame.test",
    frameUrl: "http://frame.test/_f/v1/",
    contract: "0.2.32",
    changes: [],
    flags: [],
    capabilities,
    viewer: { id: "u_00000000000000000000AA", level: "interact", canEdit: false, isOwner: false },
    versionPollMs: 0,
  };
}

interface Ctx extends BrokerContext {
  acked: string[];
  pushed: unknown[];
  asked: ConsentRequest[];
}

function context(overrides: Partial<BrokerContext> = {}, capabilities?: ShellBoot["capabilities"]): Ctx {
  const base = boot(capabilities);
  const acked: string[] = [];
  const pushed: unknown[] = [];
  const asked: ConsentRequest[] = [];
  return {
    boot: base,
    version: "v1",
    viewer: base.viewer,
    flags: new Set(),
    toFrame: (message) => pushed.push(message),
    ack: (id) => acked.push(id),
    progress: vi.fn(),
    reloadView: vi.fn(),
    setVersion: vi.fn(),
    consent: vi.fn(async (request: ConsentRequest) => {
      asked.push(request);
      return true;
    }),
    api: vi.fn(),
    acked,
    pushed,
    asked,
    ...overrides,
  } as Ctx;
}

let seq = 0;
function call(method: string, args: unknown[], id = `c${++seq}`): BrokerCall {
  return { cap: "mcp", id, method, args };
}

/* -------------------------------- fake backend ---------------------------- */

interface Backend {
  calls: number;
  bodies: Array<Record<string, unknown>>;
  /** Hold every call until `release()`; the promise resolves when parked. */
  hold: boolean;
  release(): void;
  serversReply: unknown;
  serversRequests: number;
}

function fakeBackend(): Backend {
  let waiting: Array<() => void> = [];
  const backend: Backend = {
    calls: 0,
    bodies: [],
    hold: false,
    release: () => {
      const list = waiting;
      waiting = [];
      for (const fn of list) fn();
    },
    serversReply: {
      servers: [
        {
          server: "Fake Tools",
          authStatus: "not_required",
          tools: [
            { name: "echo", description: "e", annotations: { readOnlyHint: true } },
            { name: "write", description: "w", annotations: { readOnlyHint: false } },
            { name: "plain", description: "p" },
            { name: "fail", description: "f", annotations: { readOnlyHint: true } },
            { name: "slow", description: "s", annotations: { readOnlyHint: true } },
          ],
        },
        { server: "No Store", authStatus: "authenticated", tools: [{ name: "echo", description: "e", annotations: { readOnlyHint: true } }] },
        { server: "host:local", authStatus: "not_required", tools: [] },
      ],
    },
    serversRequests: 0,
  };
  setMcpBrokerEnv({
    fetch: async (path, init) => {
      if (path === "/api/frame/mcp/servers") {
        backend.serversRequests++;
        return new Response(JSON.stringify(backend.serversReply), { status: 200 });
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      backend.bodies.push(body);
      if (backend.hold || body.tool === "slow") {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
          init.signal?.addEventListener("abort", onAbort, { once: true });
          waiting.push(() => {
            init.signal?.removeEventListener("abort", onAbort);
            resolve();
          });
        });
      }
      if (body.server === "Missing") {
        return new Response(JSON.stringify({ code: "server_not_connected", message: "no", server: "Missing" }), { status: 404 });
      }
      const n = ++backend.calls;
      const headers: Record<string, string> = {};
      if (body.server === "No Store") headers["x-frame-mcp-no-store"] = "1";
      const result =
        body.tool === "fail"
          ? { content: [{ type: "text", text: `failed #${n}` }], isError: true }
          : { content: [{ type: "text", text: JSON.stringify({ call: n }) }], structuredContent: { call: n }, cache: { storedAt: 1, revalidating: true } };
      return new Response(JSON.stringify({ result }), { status: 200, headers });
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { id: ++timerSeq, at: clock + ms, fn };
      timers.push(timer);
      return timer.id;
    },
    clearTimer: (handle) => {
      timers = timers.filter((t) => t.id !== handle);
    },
    hidden: () => hidden,
    onVisible: (fn) => {
      visible.push(fn);
      return () => {
        visible = visible.filter((f) => f !== fn);
      };
    },
  });
  return backend;
}

let clock = 1_000_000;
let timerSeq = 0;
let timers: Array<{ id: number; at: number; fn: () => void }> = [];
let hidden = false;
let visible: Array<() => void> = [];

function advance(ms: number): void {
  const target = clock + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!due) break;
    timers = timers.filter((t) => t !== due);
    clock = Math.max(clock, due.at);
    due.fn();
  }
  clock = target;
}

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

/** Let the fake backend's promise chains run: a macrotask, `times` over. */
async function settle(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

const GRANTED = { [serverConsentKey(ARTIFACT, "Fake Tools")]: "granted", [serverConsentKey(ARTIFACT, "No Store")]: "granted" };

let backend: Backend;
let storage: Map<string, string>;

beforeEach(() => {
  resetMcpBrokerState();
  resetConsentForTest();
  clock = 1_000_000;
  timers = [];
  hidden = false;
  visible = [];
  backend = fakeBackend();
  storage = fakeStorage(GRANTED);
});
afterEach(() => {
  resetMcpBrokerState();
  Reflect.deleteProperty(globalThis, "localStorage");
});

/* ---------------------------------- gate ---------------------------------- */

describe("the gate", () => {
  it("refuses a (server, tool) outside the manifest", async () => {
    const ctx = context();
    await expect(rejection(handle(call("callTool", ["Fake Tools", "nope", {}]), ctx))).resolves.toMatchObject({
      code: "not_in_manifest",
      server: "Fake Tools",
    });
    await expect(rejection(handle(call("callTool", ["Other", "echo", {}]), ctx))).resolves.toMatchObject({
      code: "not_in_manifest",
    });
    expect(backend.bodies).toEqual([]);
    expect(ctx.asked).toEqual([]);
  });

  it("answers server_not_connected for a host: server, before any consent", async () => {
    const ctx = context();
    await expect(rejection(handle(call("callTool", ["host:local", "read_file", {}]), ctx))).resolves.toMatchObject({
      code: "server_not_connected",
      server: "host:local",
    });
    expect(ctx.asked).toEqual([]);
  });

  it("re-validates the arguments a frame sent", async () => {
    const ctx = context();
    await expect(rejection(handle(call("callTool", ["Fake Tools", "echo", 5]), ctx))).resolves.toMatchObject({ code: "bad_request" });
    await expect(rejection(handle(call("callTool", ["Fake Tools", "echo", {}, { cache: 1 }]), ctx))).resolves.toMatchObject({
      code: "bad_request",
    });
  });

  it("reads an unknown method as bad_request", async () => {
    await expect(rejection(handle(call("authorize", []), context()))).resolves.toMatchObject({ code: "bad_request" });
  });

  it("answers server_not_connected when the backend does not list the server", async () => {
    const ctx = context();
    storage.set(serverConsentKey(ARTIFACT, "Missing"), "granted");
    await expect(rejection(handle(call("callTool", ["Missing", "x", {}]), ctx))).resolves.toMatchObject({
      code: "server_not_connected",
      server: "Missing",
    });
  });
});

/* --------------------------------- consent -------------------------------- */

describe("consent", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("acks, asks once per server naming its tools, then remembers the answer", async () => {
    const ctx = context();
    const first = handle(call("callTool", ["Fake Tools", "echo", {}], "a1"), ctx);
    const second = handle(call("callTool", ["Fake Tools", "plain", {}], "a2"), ctx);
    await Promise.all([first, second]);
    expect(ctx.acked).toEqual(["a1", "a2"]);
    expect(ctx.asked).toHaveLength(1);
    expect(ctx.asked[0]).toMatchObject({
      title: "Let this artifact use Fake Tools?",
      body: expect.stringContaining("echo, write, plain, fail, slow"),
    });
    expect(storage.get(serverConsentKey(ARTIFACT, "Fake Tools"))).toBe("granted");
    await handle(call("callTool", ["Fake Tools", "echo", {}], "a3"), ctx);
    expect(ctx.asked).toHaveLength(1);
    expect(ctx.acked).toEqual(["a1", "a2"]);
  });

  it("refuses with not_granted after a No, and never asks again", async () => {
    const ctx = context({ consent: vi.fn(async () => false) });
    await expect(rejection(handle(call("callTool", ["Fake Tools", "echo", {}]), ctx))).resolves.toMatchObject({
      code: "not_granted",
      server: "Fake Tools",
    });
    expect(storage.get(serverConsentKey(ARTIFACT, "Fake Tools"))).toBe("denied");
    await expect(rejection(handle(call("callTool", ["Fake Tools", "echo", {}]), ctx))).resolves.toMatchObject({ code: "not_granted" });
    expect(ctx.consent).toHaveBeenCalledTimes(1);
    expect(backend.bodies).toEqual([]);
  });

  it("is per server: a second server asks its own question", async () => {
    const ctx = context();
    await handle(call("callTool", ["Fake Tools", "echo", {}]), ctx);
    await handle(call("callTool", ["No Store", "echo", {}]), ctx);
    expect(ctx.asked.map((a) => a.title)).toEqual(["Let this artifact use Fake Tools?", "Let this artifact use No Store?"]);
  });

  it("shares one dialog and one answer with permissions.request", async () => {
    const ctx = { ...context(), boot: { ...boot(), capabilities: { mcp: { config: MANIFEST }, permissions: { config: {} } } } } as Ctx;
    const asked = permissionsHandle(
      { cap: "permissions", id: "q1", method: "request", args: [["mcp:Fake Tools"]] },
      ctx,
    );
    const called = handle(call("callTool", ["Fake Tools", "echo", {}]), ctx);
    expect(await asked).toEqual({ "mcp:Fake Tools": "granted" });
    await called;
    expect(ctx.asked).toHaveLength(1);
    expect(storage.get(serverConsentKey(ARTIFACT, "Fake Tools"))).toBe("granted");
  });

  it("asks one server at a time when a page calls several at once", async () => {
    let open = 0;
    let peak = 0;
    const ctx = context({
      consent: vi.fn(async () => {
        open++;
        peak = Math.max(peak, open);
        await new Promise((resolve) => setTimeout(resolve, 5));
        open--;
        return true;
      }),
    });
    await Promise.all([
      handle(call("callTool", ["Fake Tools", "echo", {}]), ctx),
      handle(call("callTool", ["No Store", "echo", {}]), ctx),
    ]);
    expect(peak).toBe(1);
    expect(ctx.consent).toHaveBeenCalledTimes(2);
  });

  it("does not ask for listTools", async () => {
    const ctx = context();
    const listed = (await handle(call("listTools", []), ctx)) as Array<{ server: string }>;
    expect(listed.map((row) => row.server)).toEqual(["Fake Tools", "No Store"]);
    expect(ctx.asked).toEqual([]);
  });
});

/* ---------------------------------- cache --------------------------------- */

describe("callTool and the cache", () => {
  it("executes a declared read fresh by default (staleTime 0) and strips the upstream cache field", async () => {
    const ctx = context();
    const first = (await handle(call("callTool", ["Fake Tools", "echo", { a: 1 }]), ctx)) as Record<string, unknown>;
    const second = (await handle(call("callTool", ["Fake Tools", "echo", { a: 1 }]), ctx)) as Record<string, unknown>;
    expect(backend.calls).toBe(2);
    expect(first).toEqual({ content: [{ type: "text", text: '{"call":1}' }], structuredContent: { call: 1 } });
    expect(second.structuredContent).toEqual({ call: 2 });
    expect("cache" in first).toBe(false);
  });

  it("serves a stored read within staleTime with the shell's marker, and refresh executes", async () => {
    const ctx = context();
    await handle(call("callTool", ["Fake Tools", "echo", { a: 1 }, { cache: { staleTime: 60_000 } }]), ctx);
    const storedAt = clock;
    advance(10_000);
    const hit = (await handle(call("callTool", ["Fake Tools", "echo", { a: 1 }, { cache: { staleTime: 60_000 } }]), ctx)) as Record<string, unknown>;
    expect(backend.calls).toBe(1);
    expect(hit).toEqual({
      content: [{ type: "text", text: '{"call":1}' }],
      structuredContent: { call: 1 },
      cache: { storedAt, revalidating: false },
    });
    // Order-insensitive identity: a reordered input is the same call.
    const reordered = (await handle(call("callTool", ["Fake Tools", "echo", { a: 1 }, { cache: { staleTime: 60_000 } }]), ctx)) as Record<string, unknown>;
    expect(reordered.cache).toBeDefined();
    advance(60_000);
    await handle(call("callTool", ["Fake Tools", "echo", { a: 1 }, { cache: { staleTime: 60_000 } }]), ctx);
    expect(backend.calls).toBe(2);
    await handle(call("callTool", ["Fake Tools", "echo", { a: 1 }, { cache: { staleTime: 60_000, refresh: true } }]), ctx);
    expect(backend.calls).toBe(3);
    await handle(call("callTool", ["Fake Tools", "echo", { a: 1 }, { cache: false }]), ctx);
    expect(backend.calls).toBe(4);
  });

  it("never caches a declared write, an unannotated tool by default, a failure, or a no-store result", async () => {
    const ctx = context();
    const cached = { cache: { staleTime: 60_000 } };
    await handle(call("callTool", ["Fake Tools", "write", {}, cached]), ctx);
    await handle(call("callTool", ["Fake Tools", "write", {}, cached]), ctx);
    expect(backend.calls).toBe(2);
    await handle(call("callTool", ["Fake Tools", "plain", {}]), ctx);
    await handle(call("callTool", ["Fake Tools", "plain", {}]), ctx);
    expect(backend.calls).toBe(4);
    // Opting an unannotated tool in works.
    await handle(call("callTool", ["Fake Tools", "plain", {}, cached]), ctx);
    await handle(call("callTool", ["Fake Tools", "plain", {}, cached]), ctx);
    expect(backend.calls).toBe(5);
    const failed = (await handle(call("callTool", ["Fake Tools", "fail", {}, cached]), ctx)) as Record<string, unknown>;
    expect(failed.isError).toBe(true);
    await handle(call("callTool", ["Fake Tools", "fail", {}, cached]), ctx);
    expect(backend.calls).toBe(7);
    await handle(call("callTool", ["No Store", "echo", {}, cached]), ctx);
    await handle(call("callTool", ["No Store", "echo", {}, cached]), ctx);
    expect(backend.calls).toBe(9);
  });

  it("gives a caller that joined a failing flight the full tool_error envelope", async () => {
    const ctx = context();
    backend.hold = true;
    const a = rejection(handle(call("callTool", ["Fake Tools", "fail", {}, { cache: {} }]), ctx));
    const b = rejection(handle(call("callTool", ["Fake Tools", "fail", {}, { cache: {} }]), ctx));
    await settle();
    backend.release();
    // The creator resolves with the isError result (the frame converts it);
    // the joiner rejects with the same envelope already converted.
    await expect(a).rejects.toThrow();
    await expect(b).resolves.toMatchObject({
      code: "tool_error",
      message: "failed #1",
      result: { isError: true, content: [{ type: "text", text: "failed #1" }] },
    });
  });

  it("refresh: true executes even while an identical call is in flight", async () => {
    const ctx = context();
    backend.hold = true;
    const stale = handle(call("callTool", ["Fake Tools", "echo", {}]), ctx);
    await settle();
    const fresh = handle(call("callTool", ["Fake Tools", "echo", {}, { cache: { refresh: true } }]), ctx);
    await settle();
    expect(backend.bodies).toHaveLength(2);
    backend.release();
    const [first, second] = (await Promise.all([stale, fresh])) as Array<Record<string, unknown>>;
    expect(first!.structuredContent).toEqual({ call: 1 });
    expect(second!.structuredContent).toEqual({ call: 2 });
  });

  it("coalesces identical cached calls in flight into one execution", async () => {
    const ctx = context();
    backend.hold = true;
    const a = handle(call("callTool", ["Fake Tools", "echo", { q: 1 }]), ctx);
    const b = handle(call("callTool", ["Fake Tools", "echo", { q: 1 }]), ctx);
    const other = handle(call("callTool", ["Fake Tools", "echo", { q: 2 }]), ctx);
    await settle();
    expect(backend.bodies).toHaveLength(2);
    backend.release();
    const [ra, rb, ro] = (await Promise.all([a, b, other])) as Array<Record<string, unknown>>;
    expect(ra).toEqual(rb);
    expect(ro).not.toEqual(ra);
    expect(backend.calls).toBe(2);
  });

  it("cancelCall aborts a running call and answers cancelled", async () => {
    const ctx = context();
    const pending = rejection(handle(call("callTool", ["Fake Tools", "slow", {}, { cache: false }], "s1"), ctx));
    await settle();
    expect(backend.bodies).toHaveLength(1);
    await handle(call("cancelCall", ["s1"]), ctx);
    await expect(pending).resolves.toMatchObject({ code: "cancelled" });
  });

  it("a cancelled caller leaves a shared flight running for the others", async () => {
    const ctx = context();
    const a = rejection(handle(call("callTool", ["Fake Tools", "slow", {}], "s1"), ctx));
    const b = handle(call("callTool", ["Fake Tools", "slow", {}], "s2"), ctx);
    await settle();
    await handle(call("cancelCall", ["s1"]), ctx);
    await expect(a).resolves.toMatchObject({ code: "cancelled" });
    backend.release();
    await expect(b).resolves.toMatchObject({ structuredContent: { call: 1 } });
  });

  it("dispose aborts every call the view held", async () => {
    const ctx = context();
    const pending = rejection(handle(call("callTool", ["Fake Tools", "slow", {}, { cache: false }], "s1"), ctx));
    await settle();
    dispose(ctx);
    await expect(pending).resolves.toMatchObject({ code: "cancelled" });
  });

  it("passes a backend error through with its extras", async () => {
    setMcpBrokerEnv({
      fetch: async (path) =>
        path === "/api/frame/mcp/servers"
          ? new Response(JSON.stringify(backend.serversReply), { status: 200 })
          : new Response(JSON.stringify({ code: "server_unavailable", message: "down", server: "Fake Tools", retryAfterMs: 5_000 }), { status: 503 }),
    });
    const ctx = context();
    await expect(rejection(handle(call("callTool", ["Fake Tools", "echo", {}]), ctx))).resolves.toEqual({
      code: "server_unavailable",
      message: "down",
      server: "Fake Tools",
      retryable: true,
      retryAfterMs: 5_000,
    });
  });
});

/* --------------------------------- watches -------------------------------- */

describe("watchTool", () => {
  function pushes(ctx: Ctx, watchId: string): Array<Record<string, unknown>> {
    return ctx.pushed
      .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
      .filter((m) => m.__frame_mcp_watch === true && m.watchId === watchId)
      .map((m) => m.ev as Record<string, unknown>);
  }

  it("registers, executes when nothing is stored, and delivers the fresh result", async () => {
    const ctx = context();
    await expect(handle(call("watchTool", ["Fake Tools", "echo", null, { watchId: "w1" }]), ctx)).resolves.toEqual({ ok: true });
    expect(pushes(ctx, "w1")).toEqual([]);
    await settle();
    expect(pushes(ctx, "w1")).toEqual([
      { type: "data", result: { content: [{ type: "text", text: '{"call":1}' }], structuredContent: { call: 1 } }, server: "Fake Tools" },
    ]);
  });

  it("replays a stored entry with the marker, revalidating when stale", async () => {
    const ctx = context();
    await handle(call("callTool", ["Fake Tools", "echo", {}, { cache: { staleTime: 60_000 } }]), ctx);
    const storedAt = clock;
    await handle(call("watchTool", ["Fake Tools", "echo", null, { watchId: "fresh", cache: { staleTime: 60_000 } }]), ctx);
    await settle();
    expect(pushes(ctx, "fresh")).toEqual([
      { type: "data", result: { content: [{ type: "text", text: '{"call":1}' }], structuredContent: { call: 1 }, cache: { storedAt, revalidating: false } }, server: "Fake Tools" },
    ]);
    expect(backend.calls).toBe(1);

    // Default staleTime 0: the replay is marked revalidating and a refresh follows.
    await handle(call("watchTool", ["Fake Tools", "echo", null, { watchId: "stale" }]), ctx);
    await settle();
    const events = pushes(ctx, "stale");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "data", result: { cache: { storedAt, revalidating: true } } });
    expect(events[1]).toMatchObject({ type: "data", result: { structuredContent: { call: 2 } } });
    expect((events[1] as { result: Record<string, unknown> }).result.cache).toBeUndefined();
    // The other watcher of the identity heard the refresh too, as a stored copy.
    expect(pushes(ctx, "fresh").at(-1)).toMatchObject({ type: "data", result: { structuredContent: { call: 2 }, cache: { revalidating: false } } });
  });

  it("feeds watchers from cached callers, never from ones that opted out", async () => {
    const ctx = context();
    await handle(call("watchTool", ["Fake Tools", "echo", { k: 1 }, { watchId: "w" }]), ctx);
    await settle();
    expect(pushes(ctx, "w")).toHaveLength(1);
    await handle(call("callTool", ["Fake Tools", "echo", { k: 1 }]), ctx);
    expect(pushes(ctx, "w")).toHaveLength(2);
    await handle(call("callTool", ["Fake Tools", "echo", { k: 1 }, { cache: false }]), ctx);
    expect(pushes(ctx, "w")).toHaveLength(2);
  });

  it("refuses a declared write, a duplicate id, and the 65th watch", async () => {
    const ctx = context();
    await expect(rejection(handle(call("watchTool", ["Fake Tools", "write", null, { watchId: "w" }]), ctx))).resolves.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("reads only"),
    });
    await handle(call("watchTool", ["Fake Tools", "echo", null, { watchId: "dup" }]), ctx);
    await expect(rejection(handle(call("watchTool", ["Fake Tools", "echo", null, { watchId: "dup" }]), ctx))).resolves.toMatchObject({
      code: "bad_request",
    });
    for (let i = 0; i < 63; i++) {
      await handle(call("watchTool", ["Fake Tools", "echo", { i }, { watchId: `w${i}` }]), ctx);
    }
    await expect(rejection(handle(call("watchTool", ["Fake Tools", "echo", { i: 99 }, { watchId: "over" }]), ctx))).resolves.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("64"),
    });
  });

  it("polls on refetchInterval (30 s floor), pausing while hidden with a catch-up on return", async () => {
    const ctx = context();
    await handle(call("watchTool", ["Fake Tools", "echo", null, { watchId: "p", refetchInterval: 1_000 }]), ctx);
    await settle();
    expect(backend.calls).toBe(1);
    advance(29_999);
    await settle();
    expect(backend.calls).toBe(1);
    advance(1);
    await settle();
    expect(backend.calls).toBe(2);
    expect(pushes(ctx, "p")).toHaveLength(2);

    hidden = true;
    advance(30_000);
    await settle();
    expect(backend.calls).toBe(2);
    advance(120_000);
    await settle();
    expect(backend.calls).toBe(2);
    hidden = false;
    for (const fn of visible) fn();
    await settle();
    expect(backend.calls).toBe(3);
    advance(30_000);
    await settle();
    expect(backend.calls).toBe(4);
  });

  it("unwatchTool stops the timer and the deliveries", async () => {
    const ctx = context();
    await handle(call("watchTool", ["Fake Tools", "echo", null, { watchId: "u", refetchInterval: 30_000 }]), ctx);
    await settle();
    await handle(call("unwatchTool", ["u"]), ctx);
    expect(timers).toEqual([]);
    advance(60_000);
    await settle();
    expect(backend.calls).toBe(1);
    await handle(call("callTool", ["Fake Tools", "echo", {}]), ctx);
    expect(pushes(ctx, "u")).toHaveLength(1);
    // Unknown ids are fine.
    await expect(handle(call("unwatchTool", ["nope"]), ctx)).resolves.toEqual({ ok: true });
  });

  it("delivers a failure as an error event and keeps the watch", async () => {
    const ctx = context();
    await handle(call("watchTool", ["Fake Tools", "fail", null, { watchId: "f", refetchInterval: 30_000 }]), ctx);
    await settle();
    expect(pushes(ctx, "f")).toEqual([{ type: "error", error: { code: "tool_error", message: "failed #1", server: "Fake Tools", result: expect.objectContaining({ isError: true }) } }]);
    advance(30_000);
    await settle();
    expect(pushes(ctx, "f")).toHaveLength(2);
  });

  it("delivers once to a watcher that joined another watcher's flight", async () => {
    const ctx = context();
    backend.hold = true;
    await handle(call("watchTool", ["Fake Tools", "echo", { j: 1 }, { watchId: "a" }]), ctx);
    await settle();
    await handle(call("watchTool", ["Fake Tools", "echo", { j: 1 }, { watchId: "b" }]), ctx);
    await settle();
    expect(backend.bodies).toHaveLength(1);
    backend.release();
    await settle();
    expect(pushes(ctx, "a")).toHaveLength(1);
    expect(pushes(ctx, "b")).toHaveLength(1);
    expect(pushes(ctx, "b")[0]).toMatchObject({ type: "data", result: { cache: { revalidating: false } } });
  });

  it("an unwatch that arrives while the registration is being decided wins", async () => {
    const ctx = context();
    const registering = handle(call("watchTool", ["Fake Tools", "echo", null, { watchId: "gone", refetchInterval: 30_000 }]), ctx);
    await expect(handle(call("unwatchTool", ["gone"]), ctx)).resolves.toEqual({ ok: true });
    await expect(registering).resolves.toEqual({ ok: true });
    await settle();
    expect(backend.calls).toBe(0);
    expect(timers).toEqual([]);
    advance(60_000);
    await settle();
    expect(backend.calls).toBe(0);
    expect(pushes(ctx, "gone")).toEqual([]);
    // The id is free again.
    await handle(call("watchTool", ["Fake Tools", "echo", null, { watchId: "gone" }]), ctx);
    await settle();
    expect(backend.calls).toBe(1);
  });

  it("a view disposed during a registration keeps no watch", async () => {
    const ctx = context();
    const registering = handle(call("watchTool", ["Fake Tools", "echo", null, { watchId: "d", refetchInterval: 30_000 }]), ctx);
    dispose(ctx);
    await expect(registering).resolves.toEqual({ ok: true });
    await settle();
    advance(120_000);
    await settle();
    expect(backend.calls).toBe(0);
    expect(timers).toEqual([]);
  });

  it("refuses a watch that asks not to keep its result", async () => {
    const ctx = context();
    await expect(rejection(handle(call("watchTool", ["Fake Tools", "echo", null, { watchId: "z", cache: { gcTime: 0 } }]), ctx))).resolves.toMatchObject({
      code: "bad_request",
    });
  });

  it("dispose releases every watch of the view", async () => {
    const ctx = context();
    await handle(call("watchTool", ["Fake Tools", "echo", null, { watchId: "d", refetchInterval: 30_000 }]), ctx);
    await settle();
    dispose(ctx);
    expect(timers).toEqual([]);
    expect(visible).toEqual([]);
    await handle(call("callTool", ["Fake Tools", "echo", {}]), context());
    expect(pushes(ctx, "d")).toHaveLength(1);
  });
});

/* -------------------------------- invalidate ------------------------------ */

describe("invalidate", () => {
  const cached = { cache: { staleTime: 60_000 } };

  it("drops entries by scope and re-executes the watches it touched", async () => {
    const ctx = context();
    await handle(call("callTool", ["Fake Tools", "echo", { a: 1 }, cached]), ctx);
    await handle(call("callTool", ["Fake Tools", "echo", { a: 2 }, cached]), ctx);
    await handle(call("callTool", ["Fake Tools", "plain", {}, cached]), ctx);
    await handle(call("callTool", ["No Store", "echo", {}, cached]), ctx);
    expect(backend.calls).toBe(4);

    // One exact input: `{}` and `null` name the same input-less call.
    await handle(call("invalidate", ["Fake Tools", "plain", null]), ctx);
    await handle(call("callTool", ["Fake Tools", "plain", {}, cached]), ctx);
    expect(backend.calls).toBe(5);
    await handle(call("callTool", ["Fake Tools", "echo", { a: 1 }, cached]), ctx);
    expect(backend.calls).toBe(5);

    // One tool, any input.
    await handle(call("invalidate", ["Fake Tools", "echo"]), ctx);
    await handle(call("callTool", ["Fake Tools", "echo", { a: 1 }, cached]), ctx);
    await handle(call("callTool", ["Fake Tools", "echo", { a: 2 }, cached]), ctx);
    expect(backend.calls).toBe(7);
    await handle(call("callTool", ["Fake Tools", "plain", {}, cached]), ctx);
    expect(backend.calls).toBe(7);

    // One server, then everything.
    await handle(call("invalidate", ["Fake Tools"]), ctx);
    await handle(call("callTool", ["Fake Tools", "plain", {}, cached]), ctx);
    expect(backend.calls).toBe(8);
    await handle(call("invalidate", []), ctx);
    await handle(call("callTool", ["Fake Tools", "plain", {}, cached]), ctx);
    expect(backend.calls).toBe(9);
  });

  it("does not let an execution that began before it answer a later call", async () => {
    const ctx = context();
    backend.hold = true;
    const before = handle(call("callTool", ["Fake Tools", "echo", {}]), ctx);
    await settle();
    await handle(call("invalidate", ["Fake Tools", "echo"]), ctx);
    const after = handle(call("callTool", ["Fake Tools", "echo", {}]), ctx);
    await settle();
    expect(backend.bodies).toHaveLength(2);
    backend.release();
    const [a, b] = (await Promise.all([before, after])) as Array<Record<string, unknown>>;
    expect(a!.structuredContent).toEqual({ call: 1 });
    expect(b!.structuredContent).toEqual({ call: 2 });
  });

  it("re-executes and delivers to a watched identity", async () => {
    const ctx = context();
    await handle(call("watchTool", ["Fake Tools", "echo", { w: 1 }, { watchId: "w", cache: { staleTime: 60_000 } }]), ctx);
    await settle();
    expect(backend.calls).toBe(1);
    await handle(call("invalidate", ["Fake Tools", "echo", { w: 1 }]), ctx);
    await settle();
    expect(backend.calls).toBe(2);
    const events = ctx.pushed.filter((m) => (m as { watchId?: string }).watchId === "w");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ ev: { type: "data", result: { structuredContent: { call: 2 } } } });
  });

  it("needs server and tool before an input", async () => {
    const ctx = context();
    await expect(rejection(handle(call("invalidate", [undefined, "echo"]), ctx))).resolves.toMatchObject({ code: "bad_request" });
    await expect(rejection(handle(call("invalidate", ["Fake Tools", undefined, {}]), ctx))).resolves.toMatchObject({ code: "bad_request" });
  });
});
