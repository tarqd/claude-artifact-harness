/**
 * The frame side of `sample`: validation with the documented messages, the
 * call lifecycle over a fake `RpcHost`, tool rounds, and the tolerant JSON
 * read. Nothing here touches a browser — the `RpcHost` seam stands in for
 * `parent.postMessage`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP_BUDGETS } from "../../src/protocol/messages.ts";
import type { RpcEvent, RpcHost } from "../../src/frame/rpc.ts";
import type { FrameContext } from "../../src/frame/types.ts";
import {
  buildLimits,
  createSample,
  parseImageConfig,
  parseToolConfig,
  sniffImage,
  targetSize,
  toolResultContent,
  validateCall,
  validateInput,
  validateTools,
  type SampleNamespace,
} from "../../src/capabilities/sample/frame.ts";
import { parseLooseJson } from "../../src/capabilities/sample/protocol.ts";

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

function context(config: unknown = { images: {}, tools: {} }): FrameContext {
  return {
    shellOrigin: "http://shell.test",
    capabilities: { sample: { config } },
    capBudgets: CAP_BUDGETS,
    changes: new Set(),
    flags: new Set(),
    hooks: {},
    mount: () => undefined,
    pipe: () => ({
      // Exactly what the preamble does: a synchronous throw is a rejection.
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
  sample: SampleNamespace;
  host: ReturnType<typeof fakeHost>;
  /** The `sample` request the frame posted (after its microtask). */
  request(): Sent | undefined;
  calls(method: string): Sent[];
}

function harness(config?: unknown, options: { throwOnPost?: boolean } = {}): Harness {
  const host = fakeHost(options);
  const sample = createSample(context(config), { host });
  const calls = (method: string): Sent[] =>
    host.sent.filter((s) => s.message.method === method);
  return { sample, host, request: () => calls("sample")[0], calls };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function failure(promise: Promise<unknown>): Promise<{ code?: string; message?: string; text?: string }> {
  try {
    await promise;
    return { code: "resolved" };
  } catch (err) {
    return err as { code?: string; message?: string; text?: string };
  }
}

/* -------------------------------- config --------------------------------- */

describe("config", () => {
  it("defaults, clamps and refuses image config", () => {
    expect(parseImageConfig(undefined)).toBeNull();
    expect(parseImageConfig([])).toBeNull();
    expect(parseImageConfig({ mediaTypes: ["image/heic"] })).toBeNull();
    expect(parseImageConfig({})).toEqual({
      maxCount: 4,
      maxBytes: 2_000_000,
      maxTotalBytes: 5_000_000,
      maxEdgePx: 1568,
      patchPx: 28,
      maxPatches: 1568,
      mediaTypes: ["image/jpeg", "image/png"],
    });
    // out of range and non-integer values fall back to the default
    expect(parseImageConfig({ maxCount: 99 })?.maxCount).toBe(4);
    expect(parseImageConfig({ maxCount: 2.5 })?.maxCount).toBe(4);
    expect(parseImageConfig({ maxCount: 9 })?.maxCount).toBe(9);
  });

  it("defaults and clamps tool config", () => {
    expect(parseToolConfig(null)).toBeNull();
    expect(parseToolConfig({})).toEqual({ maxCount: 16 });
    expect(parseToolConfig({ maxCount: 300 })).toEqual({ maxCount: 16 });
    expect(parseToolConfig({ maxCount: 3 })).toEqual({ maxCount: 3 });
  });

  it("reports limits that describe the INPUT types, not the encodings", () => {
    expect(buildLimits(null, null)).toEqual({ maxPromptBytes: 65_536 });
    const limits = buildLimits(parseImageConfig({ mediaTypes: ["image/png"] }), { maxCount: 7 });
    expect(limits.images).toEqual({
      maxCount: 4,
      maxInputBytes: 20_000_000,
      mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    });
    expect(limits.tools).toEqual({ maxCount: 7 });
  });

  it("resolves limits() without a message to the shell", async () => {
    const h = harness({ tools: { maxCount: 2 } });
    await expect(h.sample.limits()).resolves.toEqual({
      maxPromptBytes: 65_536,
      tools: { maxCount: 2 },
    });
    expect(h.host.sent).toEqual([]);
  });

  it("hands out a fresh snapshot, so a page cannot corrupt the next call", async () => {
    const h = harness({ images: {}, tools: { maxCount: 2 } });
    const first = await h.sample.limits();
    const second = await h.sample.limits();
    expect(first).not.toBe(second);
    expect(first.images).not.toBe(second.images);
    first.maxPromptBytes = 1;
    first.images!.mediaTypes.length = 0;
    await expect(h.sample.limits()).resolves.toEqual(second);
  });
});

/* ------------------------------- validation ------------------------------ */

describe("input validation", () => {
  it("takes a prompt string or a turn list and refuses the rest", () => {
    expect(validateInput("hello")).toBe("hello");
    expect(validateInput([{ role: "user", content: "hi", extra: 1 }])).toEqual([
      { role: "user", content: "hi" },
    ]);
    const cases: Array<[unknown, string, string]> = [
      ["   ", "invalid_request", "the prompt must be a non-empty string"],
      ["x".repeat(65_537), "prompt_too_large", "the prompt exceeds the 64 KiB limit"],
      [[], "invalid_request", "the turn list is empty"],
      [[{ role: "system", content: "x" }], "invalid_request", 'turn role must be "user" or "assistant"'],
      [[{ role: "user", content: " " }], "invalid_request", "each turn needs non-blank text content"],
      [
        [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
        ],
        "invalid_request",
        "the turn list must start and end with a user turn",
      ],
      [{ prompt: "hi" }, "invalid_request", "pass the prompt as the first argument: sample(prompt, options)"],
      [7, "invalid_request", "input must be a prompt string or a list of {role, content} turns"],
    ];
    for (const [input, code, message] of cases) {
      expect(() => validateInput(input)).toThrowError();
      try {
        validateInput(input);
      } catch (err) {
        expect(err).toMatchObject({ code, message });
      }
    }
  });

  it("counts turn content in UTF-8 bytes", () => {
    const turns = [{ role: "user", content: "é".repeat(33_000) }];
    expect(() => validateInput(turns)).toThrowError();
    try {
      validateInput(turns);
    } catch (err) {
      expect(err).toMatchObject({ code: "prompt_too_large", message: "the turns exceed the 64 KiB limit" });
    }
  });
});

describe("option validation", () => {
  const images = parseImageConfig({});
  const tools = parseToolConfig({});
  const check = (options: unknown, config = { images, tools }) => {
    try {
      validateCall("hi", options, null, config.images, config.tools);
      return { code: "resolved", message: "" };
    } catch (err) {
      return err as { code: string; message: string };
    }
  };

  it("names the mistake when options is not a plain object", () => {
    expect(check(() => undefined).message).toBe(
      "options must be a plain object - for streaming pass {onText: fn}",
    );
    expect(check("quick").message).toBe(
      "options must be a plain object - for a model tier pass {modelTier}; the prompt is the first argument",
    );
    const controller = new AbortController();
    expect(check(controller).message).toBe(
      "options must be a plain object - to cancel pass {signal: ctl.signal}",
    );
    expect(check(controller.signal).message).toBe(
      "options must be a plain object - to cancel pass {signal}",
    );
    expect(check([1]).message).toBe("options must be a plain object - for images pass {images}");
  });

  it("checks onText, signal, modelTier and cache", () => {
    expect(check({ onText: 3 }).message).toBe("onText must be a function");
    expect(check({ signal: new AbortController() }).message).toBe(
      "signal: pass ctl.signal, not the controller",
    );
    expect(check({ signal: 7 }).message).toBe("signal must be an AbortSignal");
    expect(check({ modelTier: "fast" }).message).toBe("modelTier must be default, complex, or quick");
    expect(check({ cache: 5 }).message).toBe("cache must be true, false, or {gcTime?, refresh?}");
    expect(check({ cache: { gcTime: 0 } }).message).toBe(
      "cache.gcTime must be a number of milliseconds above zero (cache: false disables caching)",
    );
    expect(check({ cache: { refresh: "yes" } }).message).toBe("cache.refresh must be true or false");
    expect(check({ modelTier: "quick", cache: { gcTime: 10 } }).code).toBe("resolved");
  });

  it("caps gcTime at 24 h and keeps cache: false", () => {
    const spec = validateCall("hi", { cache: { gcTime: 1e12 } }, null, images, tools);
    expect(spec.cache).toEqual({ gcTime: 86_400_000 });
    expect(validateCall("hi", { cache: false }, null, images, tools).cache).toBe(false);
  });

  it("refuses images and tools this view cannot serve", () => {
    const blob = new Blob(["x"], { type: "image/png" });
    expect(check({ images: blob }, { images: null, tools }).code).toBe("images_unavailable");
    expect(check({ images: [blob, blob, blob, blob, blob] }).code).toBe("image_rejected");
    expect(check({ images: ["not a blob"] }).message).toBe(
      "images must be a Blob or File, or a list of them",
    );
    const tool = { name: "t", description: "d", execute: () => 1 };
    expect(check({ tools: [tool] }, { images, tools: null }).code).toBe("tools_unavailable");
    expect(check({ tools: [tool], cache: true }).message).toBe(
      "calls with tools are never cached - remove cache",
    );
    // a Blob, a Set of Blobs and an empty list are all accepted
    expect(check({ images: blob }).code).toBe("resolved");
    expect(check({ images: new Set([blob]) }).code).toBe("resolved");
    expect(check({ images: [] }).code).toBe("resolved");
  });
});

describe("tool validation", () => {
  const cfg = parseToolConfig({ maxCount: 2 });
  const message = (tools: unknown): string => {
    try {
      validateTools(tools, cfg);
      return "resolved";
    } catch (err) {
      return (err as { message: string }).message;
    }
  };

  it("names the entry and the rule", () => {
    expect(message({ a: 1 })).toBe(
      "tools must be an array of {name, description, inputSchema?, execute} - not an object keyed by name",
    );
    expect(message([1, 2, 3])).toBe("at most 2 tools per call (got 3)");
    expect(message([{ name: "a!", description: "d", execute: () => 1 }])).toBe(
      "tools[0] (a!): name is 1-128 of A-Z a-z 0-9 _ -",
    );
    expect(
      message([
        { name: "a", description: "d", execute: () => 1 },
        { name: "a", description: "d", execute: () => 1 },
      ]),
    ).toBe("tools[1] (a): duplicate name");
    expect(message([{ name: "a", description: " ", execute: () => 1 }])).toBe(
      "tools[0] (a): description is required - say what the tool does and returns",
    );
    expect(message([{ name: "a", description: "d" }])).toBe("tools[0] (a): execute must be a function");
    expect(message([{ name: "a", description: "d", input_schema: {}, execute: () => 1 }])).toBe(
      'tools[0] (a): "input_schema" - did you mean "inputSchema"?',
    );
    expect(
      message([{ name: "a", description: "d", inputSchema: { type: "array" }, execute: () => 1 }]),
    ).toBe('tools[0] (a): inputSchema needs type: "object" at its root');
    expect(
      message([
        {
          name: "a",
          description: "d",
          inputSchema: { type: "object", properties: { "bad name": {} } },
          execute: () => 1,
        },
      ]),
    ).toBe('tools[0] (a): property "bad name" - names are 1-64 of A-Z a-z 0-9 _ . -');
  });

  it("defaults a missing schema and keeps only the wire fields", () => {
    const [tool] = validateTools([{ name: "a", description: "d", execute: () => 1 }], cfg);
    expect(tool?.inputSchema).toEqual({ type: "object", properties: {} });
  });
});

/* --------------------------------- images -------------------------------- */

describe("image header sniffing", () => {
  it("reads PNG, GIF, JPEG and WebP dimensions", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    png.set([0x49, 0x48, 0x44, 0x52], 12);
    png.set([0, 0, 2, 0], 16);
    png.set([0, 0, 1, 0], 20);
    expect(sniffImage(png)).toEqual({ type: "image/png", width: 512, height: 256 });

    const gif = new Uint8Array(10);
    gif.set([...new TextEncoder().encode("GIF89a")]);
    gif.set([0x40, 0x01, 0x20, 0x00], 6);
    expect(sniffImage(gif)).toEqual({ type: "image/gif", width: 320, height: 32 });

    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00,
      0x02, 0x00, 0x03,
    ]);
    expect(sniffImage(jpeg)).toEqual({ type: "image/jpeg", width: 512, height: 256 });

    const webp = new Uint8Array(30);
    webp.set([...new TextEncoder().encode("RIFF")]);
    webp.set([...new TextEncoder().encode("WEBP")], 8);
    webp.set([...new TextEncoder().encode("VP8 ")], 12);
    webp.set([0x20, 0x00], 26);
    webp.set([0x10, 0x00], 28);
    expect(sniffImage(webp)).toEqual({ type: "image/webp", width: 32, height: 16 });

    expect(sniffImage(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "unreadable",
    );
  });
});

describe("downscale target", () => {
  const cfg = { maxEdgePx: 1568, patchPx: 28, maxPatches: 1568 };
  it("leaves a small image alone and lands a big one near 1.2 MP", () => {
    expect(targetSize(800, 600, cfg)).toEqual({ width: 800, height: 600 });
    const big = targetSize(4000, 3000, cfg);
    expect(big.width).toBeLessThanOrEqual(1568);
    expect(big.width * big.height).toBeLessThan(1_300_000);
    expect(big.width * big.height).toBeGreaterThan(1_000_000);
    const wide = targetSize(9000, 300, cfg);
    expect(Math.max(wide.width, wide.height)).toBeLessThanOrEqual(1568);
  });
});

/* ------------------------------ tool results ----------------------------- */

describe("tool result encoding", () => {
  it("passes strings, JSON-encodes data and explains what cannot be sent", () => {
    expect(toolResultContent("ok")).toEqual({ content: "ok" });
    expect(toolResultContent(undefined)).toEqual({ content: "(no return value)" });
    expect(toolResultContent({ a: [1, 2] })).toEqual({ content: '{"a":[1,2]}' });
    expect(toolResultContent("x".repeat(40_000))).toMatchObject({ isError: true });
    class Widget {}
    expect(toolResultContent({ w: new Widget() })).toEqual({
      content:
        "Error: the result contains a Widget, which has no JSON form - return plain data (picked fields, .textContent, Array.from(...))",
      isError: true,
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toolResultContent(cyclic).isError).toBe(true);
  });
});

/* ------------------------------- the lifecycle --------------------------- */

describe("call lifecycle", () => {
  it("posts one well-formed envelope and streams onText with whole text plus delta", async () => {
    const h = harness();
    const updates: Array<{ text: string; delta: string }> = [];
    const promise = h.sample("Say hi", {
      onText: (u: { text: string; delta: string }) => updates.push(u),
      modelTier: "quick",
    });
    await tick();
    expect(h.request()?.targetOrigin).toBe("http://shell.test");
    expect(h.request()?.message).toEqual({
      __frame_cap: true,
      cap: "sample",
      id: "a1",
      method: "sample",
      args: ["Say hi", "quick"],
    });

    h.host.deliver({ __frame_cap_p: true, id: "a1", p: { type: "text", text: "he" } });
    h.host.deliver({ __frame_cap_p: true, id: "a1", p: { type: "text", text: "llo" } });
    h.host.deliver({
      __frame_cap_r: true,
      id: "a1",
      result: { text: "hello there", truncated: false, modelTierApplied: "quick" },
    });
    await expect(promise).resolves.toEqual({
      text: "hello there",
      truncated: false,
      modelTierApplied: "quick",
    });
    expect(updates).toEqual([
      { text: "he", delta: "he" },
      { text: "hello", delta: "llo" },
      { text: "hello there", delta: " there" },
    ]);
  });

  it("carries images, cache, format and tools in the third argument", async () => {
    const h = harness();
    void h.sample.json("q", { cache: { gcTime: 1000 } });
    await tick();
    expect(h.request()?.message.args).toEqual(["q", undefined, { cache: { gcTime: 1000 }, format: "json" }]);
  });

  it("ignores messages from anywhere but the shell", async () => {
    const h = harness();
    const promise = h.sample("hi");
    await tick();
    h.host.deliver({ __frame_cap_r: true, id: "a1", result: { text: "x" } }, { origin: "http://evil.test" });
    h.host.deliver({ __frame_cap_r: true, id: "a1", result: { text: "x" } }, { source: "other" });
    let settled = false;
    void promise.then(() => (settled = true), () => (settled = true));
    await tick();
    expect(settled).toBe(false);
    h.host.deliver({ __frame_cap_r: true, id: "a1", result: { text: "x", truncated: false, modelTierApplied: "default" } });
    await expect(promise).resolves.toMatchObject({ text: "x" });
  });

  it("refuses a reply that disagrees with the streamed text", async () => {
    const h = harness();
    const promise = h.sample("hi");
    await tick();
    h.host.deliver({ __frame_cap_p: true, id: "a1", p: { type: "text", text: "abc" } });
    h.host.deliver({ __frame_cap_r: true, id: "a1", result: { text: "xyz", truncated: false } });
    expect(await failure(promise)).toMatchObject({
      code: "upstream_error",
      message: "the reply disagrees with the text sent",
      text: "abc",
    });
  });

  it("refuses a reply that is not a result object", async () => {
    const h = harness();
    const promise = h.sample("hi");
    await tick();
    h.host.deliver({ __frame_cap_r: true, id: "a1", result: { truncated: false } });
    expect(await failure(promise)).toMatchObject({
      code: "upstream_error",
      message: "the viewer app's reply is not one this page runtime reads - reload the view",
    });
  });

  it("passes a shell error through and appends the partial, except on refused", async () => {
    const h = harness();
    const first = h.sample("hi");
    await tick();
    h.host.deliver({ __frame_cap_p: true, id: "a1", p: { type: "text", text: "partial" } });
    h.host.deliver({
      __frame_cap_r: true,
      id: "a1",
      error: { code: "rate_limited", message: "slow down" },
    });
    expect(await failure(first)).toEqual({
      code: "rate_limited",
      message: "slow down",
      text: "partial",
    });

    const second = h.sample("hi again");
    await tick();
    h.host.deliver({ __frame_cap_p: true, id: "a2", p: { type: "text", text: "withdrawn" } });
    h.host.deliver({ __frame_cap_r: true, id: "a2", error: { code: "refused", message: "no" } });
    expect(await failure(second)).toEqual({ code: "refused", message: "no" });
  });

  it("rejects cancelled and posts cancelCall when the signal aborts", async () => {
    const h = harness();
    const controller = new AbortController();
    const promise = h.sample("hi", { signal: controller.signal });
    await tick();
    h.host.deliver({ __frame_cap_p: true, id: "a1", p: { type: "text", text: "so far" } });
    controller.abort();
    expect(await failure(promise)).toMatchObject({
      code: "cancelled",
      message: "the call was cancelled",
      text: "so far",
    });
    expect(h.calls("cancelCall")[0]?.message).toEqual({
      __frame_cap: true,
      cap: "sample",
      id: "a2",
      method: "cancelCall",
      args: ["a1"],
    });
  });

  it("rejects a pre-aborted signal without sending anything", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await failure(h.sample("hi", { signal: controller.signal }))).toEqual({
      code: "cancelled",
      message: "the call was cancelled",
    });
    await tick();
    expect(h.host.sent).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("rejects invalid_request when the arguments cannot be cloned", async () => {
    const h = harness(undefined, { throwOnPost: true });
    expect(await failure(h.sample("hi"))).toMatchObject({
      code: "invalid_request",
      message: "arguments must be cloneable",
    });
  });
});

describe("timeouts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("gives up after the shell budget and cancels the call", async () => {
    const h = harness();
    // The handler is attached before time moves, so the rejection is never
    // unhandled while the fake clock runs.
    const outcome = failure(h.sample("hi"));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(331_000);
    expect(h.calls("cancelCall")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await outcome).toMatchObject({
      code: "upstream_error",
      message: "no reply from shell",
    });
    expect(h.calls("cancelCall")).toHaveLength(1);
  });

  it("an ack extends the budget to 15 minutes", async () => {
    const h = harness();
    const outcome = failure(h.sample("hi"));
    await Promise.resolve();
    h.host.deliver({ __frame_cap_ack: true, id: "a1" });
    await vi.advanceTimersByTimeAsync(400_000);
    expect(h.calls("cancelCall")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500_001);
    expect(await outcome).toMatchObject({
      code: "upstream_error",
      message: "the call was held (consent or its turn) and no outcome came",
    });
  });
});

describe("tool rounds", () => {
  it("runs the page's tools concurrently and posts their results", async () => {
    const h = harness();
    const seen: string[] = [];
    const tools = [
      {
        name: "clock",
        description: "the time",
        execute: async () => {
          seen.push("clock");
          return "12:00";
        },
      },
      {
        name: "bad",
        description: "throws",
        execute: () => {
          throw new Error("nope");
        },
      },
      {
        name: "data",
        description: "returns data",
        execute: () => ({ n: 1 }),
      },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const promise = h.sample("use the tools", { tools });
    await tick();
    expect(h.request()?.message.args).toEqual([
      "use the tools",
      undefined,
      {
        tools: [
          { name: "clock", description: "the time", inputSchema: { type: "object", properties: {} } },
          { name: "bad", description: "throws", inputSchema: { type: "object", properties: {} } },
          { name: "data", description: "returns data", inputSchema: { type: "object", properties: {} } },
        ],
      },
    ]);

    h.host.deliver({
      __frame_cap_p: true,
      id: "a1",
      p: {
        type: "tool_use",
        calls: [
          { id: "t1", name: "clock", input: {} },
          { id: "t2", name: "bad", input: {} },
          { id: "t3", name: "data", input: {} },
          { id: "t4", name: "nope", input: {} },
        ],
      },
    });
    for (let i = 0; i < 8; i++) await tick();

    const results = h.calls("toolResults")[0]?.message;
    expect(results).toMatchObject({ cap: "sample", method: "toolResults" });
    expect((results?.args as unknown[])[0]).toBe("a1");
    expect((results?.args as unknown[])[1]).toEqual([
      { id: "t1", content: "12:00" },
      { id: "t2", content: "Error: nope", isError: true },
      { id: "t3", content: '{"n":1}' },
      {
        id: "t4",
        content: 'Error: no tool named "nope"; available: clock, bad, data',
        isError: true,
      },
    ]);
    expect(seen).toEqual(["clock"]);

    h.host.deliver({ __frame_cap_p: true, id: "a1", p: { type: "text", text: "done" } });
    h.host.deliver({
      __frame_cap_r: true,
      id: "a1",
      result: { text: "done", truncated: false, modelTierApplied: "default" },
    });
    await expect(promise).resolves.toMatchObject({ text: "done" });
    warn.mockRestore();
  });

  it("aborts a tool's context signal when the call settles", async () => {
    const h = harness();
    let toolSignal: AbortSignal | null = null;
    const promise = h.sample("go", {
      tools: [
        {
          name: "slow",
          description: "never finishes",
          execute: (_input: unknown, context: { signal: AbortSignal }) => {
            toolSignal = context.signal;
            return new Promise(() => undefined);
          },
        },
      ],
    });
    await tick();
    h.host.deliver({
      __frame_cap_p: true,
      id: "a1",
      p: { type: "tool_use", calls: [{ id: "t1", name: "slow", input: {} }] },
    });
    await tick();
    h.host.deliver({ __frame_cap_r: true, id: "a1", error: { code: "rate_limited", message: "stop" } });
    await failure(promise);
    expect(toolSignal).not.toBeNull();
    expect((toolSignal as unknown as AbortSignal).aborted).toBe(true);
  });
});

describe("json()", () => {
  const settle = async (result: unknown): Promise<{ value?: unknown; error?: unknown }> => {
    const h = harness();
    const promise = h.sample.json("give me json");
    await tick();
    h.host.deliver({ __frame_cap_r: true, id: "a1", result });
    try {
      return { value: await promise };
    } catch (err) {
      return { error: err };
    }
  };

  it("prefers the shell's value, then reads the text tolerantly", async () => {
    expect(await settle({ text: "{}", truncated: false, value: { a: 1 } })).toEqual({
      value: { a: 1 },
    });
    expect(await settle({ text: '{"a":1}', truncated: false })).toEqual({ value: { a: 1 } });
    expect(
      await settle({ text: 'Sure:\n```json\n{"a":2}\n```', truncated: false }),
    ).toEqual({ value: { a: 2 } });
    expect(await settle({ text: 'here it is [1,2] hope that helps', truncated: false })).toEqual({
      value: [1, 2],
    });
  });

  it("rejects invalid_json with the raw reply", async () => {
    expect((await settle({ text: "no json here", truncated: false })).error).toMatchObject({
      code: "invalid_json",
      message: "the reply held no JSON value",
      text: "no json here",
    });
    expect((await settle({ text: '{"a":', truncated: true })).error).toMatchObject({
      code: "invalid_json",
      message: "the reply was cut short before the JSON was complete",
      text: '{"a":',
    });
  });

  it("reads only one value out of a reply", () => {
    expect(parseLooseJson("{}")).toEqual({ ok: true, value: {} });
    expect(parseLooseJson("```\n[1]\n```")).toEqual({ ok: true, value: [1] });
    expect(parseLooseJson("nothing")).toEqual({ ok: false });
  });
});
