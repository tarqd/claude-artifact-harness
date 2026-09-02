/**
 * The frame side of `downloads`: the wire envelope and its transfer list, the
 * four shapes `data` may take, the `bad_request` rules the contract names as
 * caller bugs, rejects-never-throws, and the 150 s budget that rejects
 * `unavailable` unless the shell acks first.
 *
 * Nothing here touches a browser — the `RpcHost` seam stands in for
 * `parent.postMessage` (see `src/frame/rpc.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP_BUDGETS, RPC_ACK_TIMEOUT_MS } from "../../src/protocol/messages.ts";
import type { RpcEvent, RpcHost } from "../../src/frame/rpc.ts";
import type { FrameContext } from "../../src/frame/types.ts";
import {
  createDownloads,
  SAVE_TIMEOUT_MS,
  toBytes,
  transferListFor,
  type DownloadsNamespace,
} from "../../src/capabilities/downloads/frame.ts";

interface Sent {
  message: Record<string, unknown>;
  targetOrigin: string;
  transfer: unknown[];
}

function fakeHost(): RpcHost & {
  sent: Sent[];
  fail: boolean;
  deliver(data: unknown, from?: { origin?: string; source?: unknown }): void;
} {
  const sent: Sent[] = [];
  const handlers: Array<(ev: RpcEvent) => void> = [];
  const host = {
    sent,
    fail: false,
    post(message: unknown, targetOrigin: string) {
      if (host.fail) throw new Error("could not be cloned");
      sent.push({
        message: message as Record<string, unknown>,
        targetOrigin,
        transfer: transferListFor(message),
      });
    },
    listen(handler: (ev: RpcEvent) => void) {
      handlers.push(handler);
      return () => handlers.splice(handlers.indexOf(handler), 1);
    },
    accepts: (ev: RpcEvent) => ev.origin === "http://shell.test" && ev.source === "parent",
    setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    deliver(data: unknown, from?: { origin?: string; source?: unknown }) {
      const ev: RpcEvent = {
        data,
        origin: from?.origin ?? "http://shell.test",
        source: from && "source" in from ? from.source : "parent",
      };
      for (const handler of [...handlers]) handler(ev);
    },
  };
  return host;
}

function context(): FrameContext {
  return {
    shellOrigin: "http://shell.test",
    capabilities: { downloads: { config: {} } },
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
  downloads: DownloadsNamespace;
  host: ReturnType<typeof fakeHost>;
}

function harness(): Harness {
  const host = fakeHost();
  return { downloads: createDownloads(context(), { host }), host };
}

async function failure(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await promise;
    return { code: "resolved" };
  } catch (err) {
    return err as { code?: string; message?: string };
  }
}

/** Let the async `save` reach `rpc.call` (it awaits `toBytes` first). */
async function settled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function bytesOf(sent: Sent): ArrayBuffer {
  const args = sent.message.args as Array<{ bytes: ArrayBuffer }>;
  return args[0]!.bytes;
}

function textOf(sent: Sent): string {
  return new TextDecoder().decode(new Uint8Array(bytesOf(sent)));
}

describe("the wire envelope", () => {
  it("posts [{filename, bytes}] with the buffer in the transfer list", async () => {
    const { downloads, host } = harness();
    const pending = downloads.save({ filename: "report.csv", data: "a,b\n1,2" });
    await settled();

    expect(host.sent).toHaveLength(1);
    const sent = host.sent[0]!;
    expect(sent.targetOrigin).toBe("http://shell.test");
    expect(sent.message.__frame_cap).toBe(true);
    expect(sent.message.cap).toBe("downloads");
    expect(sent.message.id).toBe("d1"); // the `downloads` id prefix
    expect(sent.message.method).toBe("save");
    const args = sent.message.args as Array<Record<string, unknown>>;
    expect(Object.keys(args[0]!).sort()).toEqual(["bytes", "filename"]);
    expect(args[0]!.filename).toBe("report.csv");
    expect(args[0]!.bytes).toBeInstanceOf(ArrayBuffer);
    // The bytes travel by transfer, not by copy.
    expect(sent.transfer).toEqual([args[0]!.bytes]);

    host.deliver({ __frame_cap_r: true, id: "d1", result: { status: "saved" } });
    await expect(pending).resolves.toEqual({ status: "saved" });
  });

  it("sends the filename as written: sanitizing is the shell's job", async () => {
    const { downloads, host } = harness();
    void downloads.save({ filename: "../../etc/Report Q3.CSV", data: "x" });
    await settled();
    const args = host.sent[0]!.message.args as Array<Record<string, unknown>>;
    expect(args[0]!.filename).toBe("../../etc/Report Q3.CSV");
  });

  it("mounts one namespace whose only member is save", () => {
    const { downloads } = harness();
    expect(Object.keys(downloads)).toEqual(["save"]);
    expect(typeof downloads.save).toBe("function");
  });
});

describe("the four shapes of data", () => {
  it("encodes a string as UTF-8", async () => {
    const { downloads, host } = harness();
    void downloads.save({ filename: "notes.txt", data: "héllo ☃" });
    await settled();
    expect(textOf(host.sent[0]!)).toBe("héllo ☃");
    expect(bytesOf(host.sent[0]!).byteLength).toBe(
      new TextEncoder().encode("héllo ☃").byteLength,
    );
  });

  it("transfers an ArrayBuffer: the caller's copy is detached afterwards", async () => {
    const { downloads, host } = harness();
    const buffer = new TextEncoder().encode("payload").buffer as ArrayBuffer;
    void downloads.save({ filename: "a.txt", data: buffer });
    await settled();
    expect(textOf(host.sent[0]!)).toBe("payload");
    expect(buffer.byteLength).toBe(0);
    expect((buffer as { detached?: boolean }).detached).toBe(true);
  });

  it("copies an ArrayBufferView, offset and all, and leaves the caller's buffer alone", async () => {
    const { downloads, host } = harness();
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const view = backing.subarray(2, 5);
    void downloads.save({ filename: "a.png", data: view });
    await settled();
    expect([...new Uint8Array(bytesOf(host.sent[0]!))]).toEqual([2, 3, 4]);
    expect(backing.byteLength).toBe(6); // not transferred
  });

  it("copies a Blob and ignores its own type", async () => {
    const { downloads, host } = harness();
    const blob = new Blob(["chart"], { type: "application/x-nonsense" });
    void downloads.save({ filename: "chart.png", data: blob });
    await settled();
    expect(textOf(host.sent[0]!)).toBe("chart");
    const args = host.sent[0]!.message.args as Array<Record<string, unknown>>;
    expect(args[0]).not.toHaveProperty("type");
  });
});

describe("bad_request: the caller bugs the contract names", () => {
  it.each([
    ["no request at all", undefined],
    ["a null request", null],
    ["an array", []],
  ])("rejects %s", async (_label, request) => {
    const { downloads, host } = harness();
    const error = await failure(downloads.save(request as never));
    expect(error.code).toBe("bad_request");
    expect(host.sent).toHaveLength(0);
  });

  it("rejects a non-string filename", async () => {
    const { downloads } = harness();
    const error = await failure(downloads.save({ filename: 7 as never, data: "x" }));
    expect(error).toEqual({ code: "bad_request", message: "filename must be a string" });
  });

  it("rejects a filename longer than 512 characters", async () => {
    const { downloads, host } = harness();
    // 512 exactly is fine: it reaches the shell, which decides the rest.
    void downloads.save({ filename: `${"a".repeat(508)}.txt`, data: "x" });
    await settled();
    expect(host.sent).toHaveLength(1);

    const error = await failure(downloads.save({ filename: `${"a".repeat(509)}.txt`, data: "x" }));
    expect(host.sent).toHaveLength(1);
    expect(error).toEqual({
      code: "bad_request",
      message: "filename must be at most 512 characters",
    });
  });

  it.each([
    ["an empty string", ""],
    ["an empty ArrayBuffer", new ArrayBuffer(0)],
    ["an empty view", new Uint8Array(0)],
    ["a number", 7],
    ["null", null],
    ["undefined", undefined],
    ["a plain object", { bytes: [1, 2] }],
  ])("rejects %s as data", async (_label, data) => {
    const { downloads, host } = harness();
    const error = await failure(downloads.save({ filename: "a.txt", data: data as never }));
    expect(error.code).toBe("bad_request");
    expect(host.sent).toHaveLength(0);
  });

  it("rejects an empty Blob", async () => {
    const { downloads } = harness();
    const error = await failure(downloads.save({ filename: "a.txt", data: new Blob([]) }));
    expect(error).toEqual({ code: "bad_request", message: "data is empty" });
  });

  it("rejects a buffer somebody else already transferred", async () => {
    const { downloads } = harness();
    const buffer = new ArrayBuffer(8);
    structuredClone(buffer, { transfer: [buffer] });
    const error = await failure(downloads.save({ filename: "a.txt", data: buffer }));
    expect(error.code).toBe("bad_request");
    expect(error.message).toContain("detached");
  });

  it("turns an uncloneable argument into bad_request, not the RPC's own code", async () => {
    const { downloads, host } = harness();
    host.fail = true;
    const error = await failure(downloads.save({ filename: "a.txt", data: "x" }));
    expect(error.code).toBe("bad_request");
  });

  it("never throws synchronously, whatever it is handed", () => {
    const { downloads } = harness();
    const promise = downloads.save(undefined as never);
    expect(promise).toBeInstanceOf(Promise);
    void promise.catch(() => undefined);
  });
});

describe("the shell's answers", () => {
  it("passes a rejection through with its own code", async () => {
    const { downloads, host } = harness();
    const pending = failure(downloads.save({ filename: "a.png", data: "x" }));
    await settled();
    host.deliver({
      __frame_cap_r: true,
      id: "d1",
      error: { code: "declined", message: "the viewer declined the download" },
    });
    expect(await pending).toEqual({
      code: "declined",
      message: "the viewer declined the download",
    });
  });

  it("ignores a reply from anywhere but the shell", async () => {
    const { downloads, host } = harness();
    const pending = failure(downloads.save({ filename: "a.png", data: "x" }));
    await settled();
    host.deliver(
      { __frame_cap_r: true, id: "d1", result: { status: "saved" } },
      { origin: "http://evil.test" },
    );
    host.deliver({ __frame_cap_r: true, id: "d1", error: { code: "declined", message: "no" } });
    expect((await pending).code).toBe("declined");
  });
});

describe("the reply budget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is 150 s and rejects `unavailable`", async () => {
    const { downloads } = harness();
    const pending = failure(downloads.save({ filename: "a.png", data: "x" }));
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS - 1);
    await vi.advanceTimersByTimeAsync(2);
    expect(await pending).toEqual({ code: "unavailable", message: "no reply from shell" });
    expect(SAVE_TIMEOUT_MS).toBe(150_000);
  });

  it("stretches to 900 s once the shell acks the prompt", async () => {
    const { downloads, host } = harness();
    const pending = failure(downloads.save({ filename: "a.png", data: "x" }));
    await vi.advanceTimersByTimeAsync(1);
    host.deliver({ __frame_cap_ack: true, id: "d1" });

    // Long past the 150 s budget, and still waiting on the viewer.
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS * 2);
    host.deliver({ __frame_cap_r: true, id: "d1", result: { status: "saved" } });
    expect(await pending).toEqual({ code: "resolved" });

    const second = failure(downloads.save({ filename: "b.png", data: "x" }));
    await vi.advanceTimersByTimeAsync(1);
    host.deliver({ __frame_cap_ack: true, id: "d2" });
    await vi.advanceTimersByTimeAsync(RPC_ACK_TIMEOUT_MS + 1);
    expect((await second).code).toBe("unavailable");
  });
});

describe("toBytes", () => {
  it("hands back an exactly sized buffer for every shape", async () => {
    await expect(toBytes("abc")).resolves.toHaveProperty("byteLength", 3);
    await expect(toBytes(new Blob(["abcd"]))).resolves.toHaveProperty("byteLength", 4);
    await expect(toBytes(new Uint8Array([1, 2]))).resolves.toHaveProperty("byteLength", 2);
    await expect(toBytes(new ArrayBuffer(5))).resolves.toHaveProperty("byteLength", 5);
  });
});

describe("transferListFor", () => {
  it("finds the bytes of a save envelope and nothing else", () => {
    const bytes = new ArrayBuffer(4);
    expect(
      transferListFor({ __frame_cap: true, cap: "downloads", method: "save", args: [{ bytes }] }),
    ).toEqual([bytes]);
    expect(transferListFor({ args: [{ filename: "a.txt" }] })).toEqual([]);
    expect(transferListFor({ args: "not an array" })).toEqual([]);
    expect(transferListFor(null)).toEqual([]);
  });
});
