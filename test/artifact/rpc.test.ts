import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRpc, type RpcEvent, type RpcHost } from "../../src/frame/rpc.ts";
import { RPC_ACK_TIMEOUT_MS, RPC_DEFAULT_TIMEOUT_MS } from "../../src/protocol/messages.ts";

interface Sent {
  message: unknown;
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
      sent.push({ message, targetOrigin });
    },
    listen(handler) {
      handlers.push(handler);
      return () => handlers.splice(handlers.indexOf(handler), 1);
    },
    accepts(ev) {
      return ev.origin === "http://shell.test" && ev.source === "parent";
    },
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

describe("frame rpc client", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends a well-formed envelope with a per-capability id", () => {
    const host = fakeHost();
    const rpc = createRpc({ cap: "artifact", shellOrigin: "http://shell.test", host });
    void rpc.call("publish", ["<!doctype html>"]);
    void rpc.call("publish", ["<!doctype html>"]);
    expect(host.sent[0]).toEqual({
      targetOrigin: "http://shell.test",
      message: {
        __frame_cap: true,
        cap: "artifact",
        id: "s1",
        method: "publish",
        args: ["<!doctype html>"],
      },
    });
    expect((host.sent[1]!.message as { id: string }).id).toBe("s2");
  });

  it("resolves on __frame_cap_r and rejects on its error", async () => {
    const host = fakeHost();
    const rpc = createRpc({ cap: "artifact", shellOrigin: "http://shell.test", host });
    const ok = rpc.call("publish", ["x"]);
    host.deliver({ __frame_cap_r: true, id: "s1", result: { version: "v2" } });
    await expect(ok).resolves.toEqual({ version: "v2" });

    const bad = rpc.call("publish", ["x"]);
    host.deliver({
      __frame_cap_r: true,
      id: "s2",
      error: { code: "conflict", message: "newer", live: "v9" },
    });
    await expect(bad).rejects.toMatchObject({ code: "conflict", live: "v9" });
  });

  it("ignores replies that are not from the shell window and origin", async () => {
    const host = fakeHost();
    const rpc = createRpc({ cap: "artifact", shellOrigin: "http://shell.test", host });
    const call = rpc.call("publish", ["x"]);
    host.deliver({ __frame_cap_r: true, id: "s1", result: "spoofed" }, { origin: "http://evil.test" });
    host.deliver({ __frame_cap_r: true, id: "s1", result: "spoofed" }, { source: "other" });
    vi.advanceTimersByTime(RPC_DEFAULT_TIMEOUT_MS);
    await expect(call).rejects.toMatchObject({
      code: "upstream_error",
      message: "no reply from shell",
    });
  });

  it("times out after 130 s with upstream_error", async () => {
    const host = fakeHost();
    const rpc = createRpc({ cap: "artifact", shellOrigin: "http://shell.test", host });
    const call = rpc.call("publish", ["x"]);
    vi.advanceTimersByTime(RPC_DEFAULT_TIMEOUT_MS - 1);
    vi.advanceTimersByTime(1);
    await expect(call).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("an ack extends the budget to 900 s", async () => {
    const host = fakeHost();
    const rpc = createRpc({ cap: "artifact", shellOrigin: "http://shell.test", host });
    const call = rpc.call("publish", ["x"]);
    host.deliver({ __frame_cap_ack: true, id: "s1" });
    vi.advanceTimersByTime(RPC_DEFAULT_TIMEOUT_MS + 1000);
    host.deliver({ __frame_cap_r: true, id: "s1", result: { version: "v3" } });
    await expect(call).resolves.toEqual({ version: "v3" });

    const second = rpc.call("publish", ["y"]);
    host.deliver({ __frame_cap_ack: true, id: "s2" });
    vi.advanceTimersByTime(RPC_ACK_TIMEOUT_MS + 1);
    await expect(second).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("forwards progress payloads to the caller", async () => {
    const host = fakeHost();
    const rpc = createRpc({ cap: "sample", shellOrigin: "http://shell.test", host });
    const seen: unknown[] = [];
    const call = rpc.call("sample", ["hi"], { onProgress: (p) => seen.push(p) });
    host.deliver({ __frame_cap_p: true, id: "a1", p: { type: "text", text: "he" } });
    host.deliver({ __frame_cap_p: true, id: "a1", p: { type: "text", text: "llo" } });
    host.deliver({ __frame_cap_r: true, id: "a1", result: { text: "hello" } });
    await expect(call).resolves.toEqual({ text: "hello" });
    expect(seen).toEqual([
      { type: "text", text: "he" },
      { type: "text", text: "llo" },
    ]);
  });

  it("takes its id prefix from the capability, aliases included", () => {
    const host = fakeHost();
    const rpc = createRpc({ cap: "self", shellOrigin: "http://shell.test", host });
    void rpc.call("publish", ["x"]);
    expect((host.sent[0]!.message as { id: string }).id).toBe("s1");
  });

  it("lets a capability choose what a timeout settles as", async () => {
    const host = fakeHost();
    const rpc = createRpc({
      cap: "user",
      shellOrigin: "http://shell.test",
      host,
      timeoutMs: 20_000,
      onTimeout: () => ({ resolve: null }),
    });
    const call = rpc.call("profile", []);
    vi.advanceTimersByTime(20_000);
    await expect(call).resolves.toBeNull();
  });

  it("rejects invalid_content when the arguments cannot be cloned", async () => {
    const host = fakeHost({ throwOnPost: true });
    const rpc = createRpc({ cap: "artifact", shellOrigin: "http://shell.test", host });
    await expect(rpc.call("publish", [() => 1])).rejects.toMatchObject({
      code: "invalid_content",
      message: "arguments must be cloneable",
    });
  });
});
