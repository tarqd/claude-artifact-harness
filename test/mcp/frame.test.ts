/**
 * The frame-side namespace through an `RpcHost` double: the wire envelope
 * for every method, argument validation, the reply budget, cancellation,
 * result post-processing, the watch lifecycle and the `__frame_mcp_watch`
 * push (reference/contract/0.2.32/mcp.d.ts, docs/surface-area.md §5.8).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcEvent, RpcHost } from "../../src/frame/rpc.ts";
import type { FrameContext } from "../../src/frame/types.ts";
import { CAP_BUDGETS } from "../../src/protocol/messages.ts";
import {
  createMcp,
  type McpNamespace,
  type WatchEvent,
} from "../../src/capabilities/mcp/frame.ts";
import { MAX_WATCHES } from "../../src/capabilities/mcp/protocol.ts";

interface Sent {
  message: Record<string, unknown>;
  targetOrigin: string;
}

function fakeHost(options: { throwOnPost?: boolean } = {}): RpcHost & {
  sent: Sent[];
  deliver(data: unknown, from?: { origin?: string; source?: unknown }): void;
} {
  const sent: Sent[] = [];
  const handlers: Array<(ev: RpcEvent) => void> = [];
  return {
    sent,
    post(message, targetOrigin) {
      if (options.throwOnPost) throw new DOMException("could not be cloned", "DataCloneError");
      sent.push({ message: message as Record<string, unknown>, targetOrigin });
    },
    listen(handler) {
      handlers.push(handler);
      return () => handlers.splice(handlers.indexOf(handler), 1);
    },
    accepts: (ev) => ev.origin === "http://shell.test" && ev.source === "parent",
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    deliver(data, from) {
      const ev: RpcEvent = {
        data,
        origin: from?.origin ?? "http://shell.test",
        source: from && "source" in from ? from.source : "parent",
      };
      for (const handler of [...handlers]) handler(ev);
    },
  };
}

const MANIFEST = { servers: [{ server: "Fake Tools", tools: ["echo", "write"] }] };

function context(config: unknown = MANIFEST): FrameContext {
  return {
    shellOrigin: "http://shell.test",
    capabilities: { mcp: { config } },
    capBudgets: CAP_BUDGETS,
    changes: new Set(),
    flags: new Set(),
    hooks: {},
    mount: () => undefined,
    pipe: () => ({
      wrap<A extends unknown[], R>(_method: string, fn: (...args: A) => R | Promise<R>) {
        return (...args: A): Promise<R> => {
          try {
            return Promise.resolve(fn(...args));
          } catch (err) {
            return Promise.reject(err);
          }
        };
      },
    }),
  };
}

interface Harness {
  mcp: McpNamespace;
  host: ReturnType<typeof fakeHost>;
  pageHide: () => void;
  reported: unknown[];
  calls(method: string): Sent[];
  last(method: string): Sent;
  reply(id: string, result: unknown): void;
  fail(id: string, error: unknown): void;
  push(watchId: string, ev: unknown): void;
}

function harness(options: { throwOnPost?: boolean } = {}): Harness {
  const host = fakeHost(options);
  let pageHide: () => void = () => undefined;
  const reported: unknown[] = [];
  const mcp = createMcp(context(), {
    host,
    onPageHide: (fn) => {
      pageHide = fn;
    },
    random: () => "abcdef",
    reportError: (err) => reported.push(err),
  });
  const calls = (method: string): Sent[] => host.sent.filter((s) => s.message.method === method);
  return {
    mcp,
    host,
    pageHide: () => pageHide(),
    reported,
    calls,
    last: (method) => calls(method).at(-1)!,
    reply: (id, result) => host.deliver({ __frame_cap_r: true, id, result }),
    fail: (id, error) => host.deliver({ __frame_cap_r: true, id, error }),
    push: (watchId, ev) => host.deliver({ __frame_mcp_watch: true, watchId, ev }),
  };
}

async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

const TEXT_RESULT = { content: [{ type: "text", text: '{"a":1}' }] };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("namespace", () => {
  it("is frozen and carries the four methods", () => {
    const { mcp } = harness();
    expect(Object.isFrozen(mcp)).toBe(true);
    expect(Object.keys(mcp).sort()).toEqual(["callTool", "invalidate", "listTools", "watchTool"]);
  });
});

describe("listTools", () => {
  it("posts the envelope with the c prefix and maps the reply", async () => {
    const h = harness();
    const pending = h.mcp.listTools();
    const sent = h.last("listTools");
    expect(sent.targetOrigin).toBe("http://shell.test");
    expect(sent.message).toEqual({ __frame_cap: true, cap: "mcp", id: "c1", method: "listTools", args: [] });
    h.reply("c1", [
      { server: "Fake Tools", authStatus: "not_required", tools: [{ name: "echo", description: "e", annotations: { readOnlyHint: true } }] },
      { server: "Needs Auth", authStatus: "token_invalid", tools: [] },
      { server: "Odd", authStatus: "something", tools: [] },
    ]);
    await expect(pending).resolves.toEqual({
      servers: [
        { server: "Fake Tools", authStatus: "connected", tools: [{ name: "echo", description: "e", annotations: { readOnlyHint: true } }] },
        { server: "Needs Auth", authStatus: "needs_reauth", tools: [] },
        { server: "Odd", authStatus: "unknown", tools: [] },
      ],
    });
  });

  it("uses the listTools budget and times out as upstream_error", async () => {
    const h = harness();
    const pending = h.mcp.listTools();
    const settled = rejection(pending);
    vi.advanceTimersByTime(CAP_BUDGETS.mcp.listTools + 2_000);
    await expect(settled).resolves.toEqual({ code: "upstream_error", message: "no reply from shell" });
  });
});

describe("callTool", () => {
  it("rejects caller bugs with bad_request before posting", async () => {
    const h = harness();
    const cases: Array<[unknown[], string]> = [
      [[7, "echo"], "server"],
      [["Fake Tools", ""], "tool"],
      [["Fake Tools", "echo", new Map()], "plain JSON"],
      [["Fake Tools", "echo", new Date()], "plain JSON"],
      [["Fake Tools", "echo", {}, "opts"], "options"],
      [["Fake Tools", "echo", {}, { cache: "yes" }], "cache"],
      [["Fake Tools", "echo", {}, { signal: {} }], "signal"],
    ];
    for (const [args, fragment] of cases) {
      const err = (await rejection(
        (h.mcp.callTool as (...a: unknown[]) => Promise<unknown>)(...args),
      )) as { code: string; message: string };
      expect(err.code).toBe("bad_request");
      expect(err.message).toContain(fragment);
    }
    expect(h.host.sent).toEqual([]);
  });

  it("posts [server, tool, input, options] without the signal, and derives payload", async () => {
    const h = harness();
    const controller = new AbortController();
    const pending = h.mcp.callTool("Fake Tools", "echo", { b: 1 }, { cache: { staleTime: 5 }, signal: controller.signal });
    const sent = h.last("callTool");
    expect(sent.message.id).toBe("c1");
    expect(sent.message.args).toEqual(["Fake Tools", "echo", { b: 1 }, { cache: { staleTime: 5 } }]);
    h.reply("c1", { ...TEXT_RESULT, cache: { storedAt: 5, revalidating: false } });
    await expect(pending).resolves.toEqual({
      content: TEXT_RESULT.content,
      payload: { a: 1 },
      cache: { storedAt: 5, revalidating: false },
    });
  });

  it("sends {} for an omitted input and prefers structuredContent", async () => {
    const h = harness();
    const pending = h.mcp.callTool("Fake Tools", "echo");
    expect(h.last("callTool").message.args).toEqual(["Fake Tools", "echo", {}, {}]);
    h.reply("c1", { content: [{ type: "text", text: "x" }], structuredContent: { s: 1 } });
    await expect(pending).resolves.toEqual({
      content: [{ type: "text", text: "x" }],
      structuredContent: { s: 1 },
      payload: { s: 1 },
    });
  });

  it("turns an isError result into a tool_error rejection carrying the result", async () => {
    const h = harness();
    const pending = h.mcp.callTool("Fake Tools", "echo");
    h.reply("c1", { content: [{ type: "text", text: "it broke" }], isError: true });
    await expect(rejection(pending)).resolves.toEqual({
      code: "tool_error",
      message: "it broke",
      result: { content: [{ type: "text", text: "it broke" }], payload: "it broke" },
    });
  });

  it("keeps known error codes with their extras and folds unknown ones", async () => {
    const h = harness();
    const first = h.mcp.callTool("Fake Tools", "echo");
    h.fail("c1", { code: "server_unavailable", message: "down", retryable: true, retryAfterMs: 90_000, server: "Fake Tools" });
    await expect(rejection(first)).resolves.toEqual({
      code: "server_unavailable",
      message: "down",
      retryable: true,
      retryAfterMs: 60_000,
      server: "Fake Tools",
    });
    const second = h.mcp.callTool("Fake Tools", "echo");
    h.fail("c2", { code: "weird_new_code", message: "m" });
    await expect(rejection(second)).resolves.toEqual({ code: "upstream_error", message: "m" });
  });

  it("aborts: posts cancelCall with the call's id and rejects cancelled", async () => {
    const h = harness();
    const controller = new AbortController();
    const pending = h.mcp.callTool("Fake Tools", "echo", {}, { signal: controller.signal });
    const settled = rejection(pending);
    controller.abort();
    await expect(settled).resolves.toMatchObject({ code: "cancelled" });
    expect(h.last("cancelCall").message.args).toEqual(["c1"]);
    // A late reply for the cancelled id is ignored.
    h.reply("c1", TEXT_RESULT);
  });

  it("never posts for a signal that already fired", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(rejection(h.mcp.callTool("Fake Tools", "echo", {}, { signal: controller.signal }))).resolves.toMatchObject({
      code: "cancelled",
    });
    expect(h.host.sent).toEqual([]);
  });

  it("times out after the callTool budget, or 900 s once acked", async () => {
    const h = harness();
    const first = rejection(h.mcp.callTool("Fake Tools", "echo"));
    vi.advanceTimersByTime(CAP_BUDGETS.mcp.callTool + 2_000);
    await expect(first).resolves.toEqual({ code: "upstream_error", message: "no reply from shell" });

    const second = h.mcp.callTool("Fake Tools", "echo");
    h.host.deliver({ __frame_cap_ack: true, id: "c2" });
    vi.advanceTimersByTime(CAP_BUDGETS.mcp.callTool + 2_000);
    h.reply("c2", TEXT_RESULT);
    await expect(second).resolves.toMatchObject({ payload: { a: 1 } });
  });

  it("rejects bad_request when the arguments cannot be cloned", async () => {
    const h = harness({ throwOnPost: true });
    await expect(rejection(h.mcp.callTool("Fake Tools", "echo"))).resolves.toMatchObject({ code: "bad_request" });
  });

  it("ignores replies from anywhere but the shell", async () => {
    const h = harness();
    const pending = h.mcp.callTool("Fake Tools", "echo");
    h.host.deliver({ __frame_cap_r: true, id: "c1", result: TEXT_RESULT }, { origin: "http://evil.test" });
    h.host.deliver({ __frame_cap_r: true, id: "c1", result: TEXT_RESULT }, { source: "other" });
    h.reply("c1", { content: [{ type: "text", text: "real" }] });
    await expect(pending).resolves.toMatchObject({ payload: "real" });
  });
});

describe("watchTool", () => {
  function events(): { list: WatchEvent[]; handler: (ev: WatchEvent) => void } {
    const list: WatchEvent[] = [];
    return { list, handler: (ev) => list.push(ev) };
  }

  it("throws a TypeError synchronously for a missing handler, and nothing else", () => {
    const { mcp } = harness();
    expect(() => (mcp.watchTool as (...a: unknown[]) => unknown)("Fake Tools", "echo", null)).toThrow(TypeError);
  });

  it("registers with a w<rand>-<n> id and routes data pushes to the handler", async () => {
    const h = harness();
    const { list, handler } = events();
    const stop = h.mcp.watchTool("Fake Tools", "echo", null, handler, { cache: { staleTime: 10 }, refetchInterval: 1_000 });
    expect(typeof stop).toBe("function");
    const sent = h.last("watchTool");
    expect(sent.message.args).toEqual(["Fake Tools", "echo", {}, { watchId: "wabcdef-1", cache: { staleTime: 10 }, refetchInterval: 30_000 }]);
    h.reply(sent.message.id as string, { ok: true });
    h.push("wabcdef-1", { type: "data", result: { ...TEXT_RESULT, cache: { storedAt: 3, revalidating: true } }, server: "Fake Tools" });
    h.push("wabcdef-1", { type: "error", error: { code: "server_unavailable", message: "down", retryable: true } });
    h.push("wabcdef-1", { type: "data", result: { content: [{ type: "text", text: "bad" }], isError: true }, server: "Fake Tools" });
    h.push("someone-else", { type: "data", result: TEXT_RESULT, server: "Fake Tools" });
    await tick();
    expect(list).toEqual([
      { type: "data", result: { content: TEXT_RESULT.content, payload: { a: 1 }, cache: { storedAt: 3, revalidating: true } } },
      { type: "error", error: { code: "server_unavailable", message: "down", retryable: true } },
      { type: "error", error: { code: "tool_error", message: "bad", result: { content: [{ type: "text", text: "bad" }], payload: "bad" } } },
    ]);
  });

  it("delivers validation failures as an error event after a microtask, without posting", async () => {
    const h = harness();
    const { list, handler } = events();
    const stop = h.mcp.watchTool("Fake Tools", "echo", new Map(), handler);
    expect(list).toEqual([]);
    await tick();
    expect(list).toEqual([{ type: "error", error: { code: "bad_request", message: expect.stringContaining("plain JSON") } }]);
    expect(h.host.sent).toEqual([]);
    stop();
    expect(h.host.sent).toEqual([]);
  });

  it("delivers a registration rejection as an error event and stops listening", async () => {
    const h = harness();
    const { list, handler } = events();
    h.mcp.watchTool("Fake Tools", "write", null, handler);
    const sent = h.last("watchTool");
    h.fail(sent.message.id as string, { code: "bad_request", message: "reads only" });
    await tick();
    expect(list).toEqual([{ type: "error", error: { code: "bad_request", message: "reads only" } }]);
    h.push("wabcdef-1", { type: "data", result: TEXT_RESULT, server: "Fake Tools" });
    await tick();
    expect(list).toHaveLength(1);
  });

  it("unsubscribes synchronously and idempotently, posting unwatchTool once", async () => {
    const h = harness();
    const { list, handler } = events();
    const stop = h.mcp.watchTool("Fake Tools", "echo", null, handler);
    h.reply(h.last("watchTool").message.id as string, { ok: true });
    stop();
    stop();
    expect(h.calls("unwatchTool")).toHaveLength(1);
    expect(h.last("unwatchTool").message.args).toEqual(["wabcdef-1"]);
    h.push("wabcdef-1", { type: "data", result: TEXT_RESULT, server: "Fake Tools" });
    await tick();
    expect(list).toEqual([]);
  });

  it("caps the view at 64 watches", async () => {
    const h = harness();
    const stops: Array<() => void> = [];
    for (let i = 0; i < MAX_WATCHES; i++) stops.push(h.mcp.watchTool("Fake Tools", "echo", { i }, () => undefined));
    const { list, handler } = events();
    h.mcp.watchTool("Fake Tools", "echo", { i: 99 }, handler);
    await tick();
    expect(list).toEqual([{ type: "error", error: { code: "bad_request", message: expect.stringContaining("64") } }]);
    expect(h.calls("watchTool")).toHaveLength(MAX_WATCHES);
    stops[0]!();
    const { list: again, handler: again2 } = events();
    h.mcp.watchTool("Fake Tools", "echo", { i: 100 }, again2);
    await tick();
    expect(again).toEqual([]);
    expect(h.calls("watchTool")).toHaveLength(MAX_WATCHES + 1);
  });

  it("reports a throwing handler and keeps delivering", async () => {
    const h = harness();
    let seen = 0;
    h.mcp.watchTool("Fake Tools", "echo", null, () => {
      seen++;
      throw new Error("page bug");
    });
    h.push("wabcdef-1", { type: "data", result: TEXT_RESULT, server: "Fake Tools" });
    h.push("wabcdef-1", { type: "data", result: TEXT_RESULT, server: "Fake Tools" });
    expect(seen).toBe(2);
    expect(h.reported).toHaveLength(2);
  });

  it("releases every watch on pagehide", () => {
    const h = harness();
    h.mcp.watchTool("Fake Tools", "echo", null, () => undefined);
    h.mcp.watchTool("Fake Tools", "echo", { x: 1 }, () => undefined);
    h.pageHide();
    expect(h.calls("unwatchTool").map((s) => s.message.args)).toEqual([["wabcdef-1"], ["wabcdef-2"]]);
  });
});

describe("invalidate", () => {
  it("posts only the arguments given and resolves undefined", async () => {
    const h = harness();
    const all = h.mcp.invalidate();
    expect(h.last("invalidate").message.args).toEqual([]);
    h.reply("c1", null);
    await expect(all).resolves.toBeUndefined();

    void h.mcp.invalidate("Fake Tools");
    expect(h.last("invalidate").message.args).toEqual(["Fake Tools"]);
    void h.mcp.invalidate("Fake Tools", "echo");
    expect(h.last("invalidate").message.args).toEqual(["Fake Tools", "echo"]);
    void h.mcp.invalidate("Fake Tools", "echo", null);
    expect(h.last("invalidate").message.args).toEqual(["Fake Tools", "echo", null]);
  });

  it("needs server and tool before an input", async () => {
    const h = harness();
    await expect(rejection(h.mcp.invalidate(undefined, "echo"))).resolves.toMatchObject({ code: "bad_request" });
    await expect(rejection(h.mcp.invalidate("Fake Tools", undefined, {}))).resolves.toMatchObject({ code: "bad_request" });
    await expect(rejection(h.mcp.invalidate("Fake Tools", "echo", new Set()))).resolves.toMatchObject({ code: "bad_request" });
    expect(h.host.sent).toEqual([]);
  });
});
