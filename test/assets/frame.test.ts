/**
 * The frame side of `assets`: the wire envelope, the validation the page sees
 * as `invalid_request` / `unsupported_type` / `too_large`, the 16-page bound on
 * `list()`, and rejects-never-throws.
 *
 * Nothing here touches a browser — the `RpcHost` seam stands in for
 * `parent.postMessage` (see `src/frame/rpc.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP_BUDGETS } from "../../src/protocol/messages.ts";
import type { RpcEvent, RpcHost } from "../../src/frame/rpc.ts";
import type { FrameContext } from "../../src/frame/types.ts";
import {
  createAssets,
  validateUpload,
  type AssetsNamespace,
} from "../../src/capabilities/assets/frame.ts";
import {
  ASSETS_TIMEOUT_MS,
  MAX_SVG_BYTES,
  type AssetPage,
} from "../../src/capabilities/assets/protocol.ts";

const ORIGIN = "http://shell.test";

interface Envelope {
  __frame_cap: true;
  cap: string;
  id: string;
  method: string;
  args: unknown[];
}

type Responder = (call: Envelope) => { result: unknown } | { error: unknown } | null;

interface FakeHost extends RpcHost {
  sent: Envelope[];
  respond: Responder | null;
  deliver(data: unknown, from?: { origin?: string; source?: unknown }): void;
}

function fakeHost(): FakeHost {
  const sent: Envelope[] = [];
  const handlers: Array<(ev: RpcEvent) => void> = [];
  const host: FakeHost = {
    sent,
    respond: null,
    post(message: unknown) {
      const call = message as Envelope;
      sent.push(call);
      const responder = host.respond;
      if (!responder) return;
      queueMicrotask(() => {
        const answer = responder(call);
        if (!answer) return;
        host.deliver({ __frame_cap_r: true, id: call.id, ...answer });
      });
    },
    listen(handler: (ev: RpcEvent) => void) {
      handlers.push(handler);
      return () => handlers.splice(handlers.indexOf(handler), 1);
    },
    accepts: (ev: RpcEvent) => ev.origin === ORIGIN && ev.source === "parent",
    setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    deliver(data: unknown, from?: { origin?: string; source?: unknown }) {
      const ev: RpcEvent = {
        data,
        origin: from?.origin ?? ORIGIN,
        source: from && "source" in from ? from.source : "parent",
      };
      for (const handler of [...handlers]) handler(ev);
    },
  };
  return host;
}

function context(): FrameContext {
  return {
    shellOrigin: ORIGIN,
    capabilities: { assets: { config: {} } },
    capBudgets: CAP_BUDGETS,
    changes: new Set(),
    flags: new Set(),
    hooks: {},
    mount: () => undefined,
    // Exactly what the preamble does: a synchronous throw is a rejection.
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

function harness(): { assets: AssetsNamespace; host: FakeHost } {
  const host = fakeHost();
  return { assets: createAssets(context(), { host }), host };
}

/** The rejection value a call settles with, as the page would see it. */
async function rejection(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await promise;
    throw new Error("expected a rejection");
  } catch (err) {
    return err as { code?: string; message?: string };
  }
}

const png = (bytes = 8): Blob => new Blob([new Uint8Array(bytes)], { type: "image/png" });

describe("validateUpload", () => {
  it("puts the Blob and its bare type on the wire", () => {
    const blob = new Blob(["x"], { type: "image/png; charset=binary" });
    expect(validateUpload(blob, undefined)).toEqual([blob, "image/png"]);
  });

  it("lets an explicit {type} win over the Blob's own", () => {
    const blob = new Blob(["a,b\n"], { type: "application/octet-stream" });
    expect(validateUpload(blob, { type: "text/csv" })[1]).toBe("text/csv");
  });

  it("names the caller bugs", () => {
    expect(() => validateUpload("not a blob", undefined)).toThrow();
    try {
      validateUpload("not a blob", undefined);
    } catch (err) {
      expect((err as { code: string }).code).toBe("invalid_request");
    }
    try {
      validateUpload(png(), { type: 7 });
    } catch (err) {
      expect((err as { code: string }).code).toBe("invalid_request");
    }
    try {
      validateUpload(new Blob([], { type: "image/png" }), undefined);
    } catch (err) {
      expect((err as { code: string }).code).toBe("invalid_request");
    }
    try {
      validateUpload(new Blob(["x"]), undefined); // no type anywhere
    } catch (err) {
      expect((err as { code: string }).code).toBe("invalid_request");
    }
  });
});

describe("upload", () => {
  it("sends `[blob, type]` under the `e` id prefix and resolves the record", async () => {
    const { assets, host } = harness();
    const blob = png();
    host.respond = (call) => ({
      result: {
        id: "0".repeat(32),
        url: `/_blob/${"0".repeat(32)}`,
        type: call.args[1],
        size: 8,
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    });

    const record = await assets.upload(blob);
    expect(host.sent[0]).toMatchObject({
      __frame_cap: true,
      cap: "assets",
      id: "e1",
      method: "upload",
      args: [blob, "image/png"],
    });
    expect(record.url).toBe(`/_blob/${"0".repeat(32)}`);
  });

  it("rejects an unsupported type without a round trip", async () => {
    const { assets, host } = harness();
    const blob = new Blob(["MZ"], { type: "application/x-msdownload" });
    expect((await rejection(assets.upload(blob))).code).toBe("unsupported_type");
    expect(host.sent).toEqual([]);
  });

  it("rejects an oversized SVG without a round trip", async () => {
    const { assets, host } = harness();
    const blob = new Blob([new Uint8Array(MAX_SVG_BYTES + 1)], { type: "image/svg+xml" });
    expect((await rejection(assets.upload(blob))).code).toBe("too_large");
    expect(host.sent).toEqual([]);
  });

  it("never throws synchronously, whatever the page passes", () => {
    const { assets } = harness();
    const promise = (assets as unknown as { upload(v: unknown): Promise<unknown> }).upload(7);
    expect(promise).toBeInstanceOf(Promise);
    return expect(promise).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("list", () => {
  const record = (n: number) => ({
    id: String(n).padStart(32, "0"),
    url: `/_blob/${String(n).padStart(32, "0")}`,
    type: "image/png",
    size: 10,
    createdAt: `2026-09-01T00:00:0${n % 10}.000Z`,
  });

  it("follows `next` cursors and reports the last usage", async () => {
    const { assets, host } = harness();
    const pages: AssetPage[] = [
      { assets: [record(1), record(2)], usage: { count: 3, bytes: 30 }, next: "c1" },
      { assets: [record(3)], usage: { count: 3, bytes: 30 } },
    ];
    let page = 0;
    host.respond = () => ({ result: pages[page++] });

    const result = await assets.list();
    expect(result.assets.map((a) => a.id)).toEqual([record(1).id, record(2).id, record(3).id]);
    expect(result.usage).toEqual({ count: 3, bytes: 30 });
    expect(host.sent.map((call) => call.args)).toEqual([[], ["c1"]]);
  });

  it("stops after 16 pages even when the backend keeps offering more", async () => {
    const { assets, host } = harness();
    let n = 0;
    host.respond = () => {
      n += 1;
      return { result: { assets: [record(n)], usage: { count: 99, bytes: 1 }, next: `c${n}` } };
    };

    const result = await assets.list();
    expect(host.sent).toHaveLength(16);
    expect(result.assets).toHaveLength(16);
  });

  it("stops when a cursor repeats rather than paging forever", async () => {
    const { assets, host } = harness();
    host.respond = () => ({
      result: { assets: [record(1)], usage: { count: 1, bytes: 10 }, next: "same" },
    });
    const result = await assets.list();
    expect(host.sent).toHaveLength(2);
    expect(result.assets).toHaveLength(2);
  });

  it("survives a reply that is not the shape it asked for", async () => {
    const { assets, host } = harness();
    host.respond = () => ({ result: "nonsense" });
    await expect(assets.list()).resolves.toEqual({ assets: [], usage: { count: 0, bytes: 0 } });
  });
});

describe("delete", () => {
  const id = "0123456789abcdef0123456789abcdef";

  it("sends the bare id whichever form the page passed", async () => {
    const { assets, host } = harness();
    host.respond = (call) => ({ result: { id: call.args[0], deleted: true } });
    await assets.delete(`/_blob/${id}`);
    await assets.delete(id);
    expect(host.sent.map((call) => call.args)).toEqual([[id], [id]]);
  });

  it("refuses a reference it cannot parse without a round trip", async () => {
    const { assets, host } = harness();
    expect((await rejection(assets.delete("/_blob/../secret"))).code).toBe("invalid_request");
    expect(host.sent).toEqual([]);
  });
});

describe("what reaches the page", () => {
  it("passes the four documented codes through and folds everything else into upstream_error", async () => {
    const { assets, host } = harness();
    host.respond = () => ({ error: { code: "too_large", message: "server said so" } });
    expect((await rejection(assets.upload(png()))).code).toBe("too_large");

    host.respond = () => ({ error: { code: "not_writer", message: "no writing here" } });
    const folded = await rejection(assets.upload(png()));
    expect(folded.code).toBe("upstream_error");
    expect(folded.message).toBe("no writing here");
  });

  it("lets a lifecycle code through unchanged", async () => {
    const { assets, host } = harness();
    host.respond = () => ({
      error: { code: "capability_disabled", message: "not available in this view" },
    });
    expect((await rejection(assets.list())).code).toBe("capability_disabled");
  });
});

describe("the reply budget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is 130 s and rejects upstream_error", async () => {
    const { assets } = harness();
    const pending = rejection(assets.upload(png()));
    await vi.advanceTimersByTimeAsync(ASSETS_TIMEOUT_MS - 1);
    await vi.advanceTimersByTimeAsync(2);
    const err = await pending;
    expect(err.code).toBe("upstream_error");
    expect(err.message).toBe("no reply from shell");
  });
});
