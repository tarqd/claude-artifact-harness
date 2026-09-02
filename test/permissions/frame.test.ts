/**
 * The frame side of `permissions`: the wire envelope, the two shapes the
 * namespace can take (brokered and locally "unavailable"), rejects-never-
 * throws, and the ack that turns the 130 s reply budget into 900 s.
 *
 * Nothing here touches a browser — the `RpcHost` seam stands in for
 * `parent.postMessage`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP_BUDGETS, RPC_ACK_TIMEOUT_MS, RPC_DEFAULT_TIMEOUT_MS } from "../../src/protocol/messages.ts";
import type { RpcEvent, RpcHost } from "../../src/frame/rpc.ts";
import type { FrameContext } from "../../src/frame/types.ts";
import {
  createPermissions,
  type PermissionsNamespace,
} from "../../src/capabilities/permissions/frame.ts";

interface Sent {
  message: Record<string, unknown>;
  targetOrigin: string;
}

function fakeHost(): RpcHost & {
  sent: Sent[];
  deliver(data: unknown, from?: { origin?: string; source?: unknown }): void;
} {
  const sent: Sent[] = [];
  const handlers: Array<(ev: RpcEvent) => void> = [];
  return {
    sent,
    post(message, targetOrigin) {
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

function context(capabilities: Record<string, { config?: unknown }>): FrameContext {
  return {
    shellOrigin: "http://shell.test",
    capabilities,
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
  permissions: PermissionsNamespace;
  host: ReturnType<typeof fakeHost>;
}

/** A view with something to govern: the namespace talks to the shell. */
function brokered(
  capabilities: Record<string, { config?: unknown }> = {
    permissions: { config: {} },
    sample: { config: {} },
    downloads: { config: {} },
  },
): Harness {
  const host = fakeHost();
  return { permissions: createPermissions(context(capabilities), { host }), host };
}

/** A view with nothing to govern: the namespace answers locally. */
function local(): Harness {
  const host = fakeHost();
  const ctx = context({ permissions: { config: {} }, user: { config: {} } });
  return { permissions: createPermissions(ctx, { host }), host };
}

async function failure(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await promise;
    return { code: "resolved" };
  } catch (err) {
    return err as { code?: string; message?: string };
  }
}

describe("the wire envelope", () => {
  it("asks the shell for the whole map with no argument", async () => {
    const { permissions, host } = brokered();
    const pending = permissions.state();
    expect(host.sent[0]).toEqual({
      targetOrigin: "http://shell.test",
      message: { __frame_cap: true, cap: "permissions", id: "p1", method: "state", args: [] },
    });
    host.deliver({
      __frame_cap_r: true,
      id: "p1",
      result: { sample: "prompt", downloads: "granted" },
    });
    await expect(pending).resolves.toEqual({ sample: "prompt", downloads: "granted" });
  });

  it("asks for one name, and answers with just its state", async () => {
    const { permissions, host } = brokered();
    const pending = permissions.state("sample");
    expect(host.sent[0]!.message).toMatchObject({ method: "state", args: ["sample"] });
    host.deliver({ __frame_cap_r: true, id: "p1", result: "prompt" });
    await expect(pending).resolves.toBe("prompt");
  });

  it("sends request() names as one array argument, deduplicated", async () => {
    const { permissions, host } = brokered();
    const pending = permissions.request(["sample", "sample", "db"]);
    expect(host.sent[0]!.message).toMatchObject({
      cap: "permissions",
      id: "p1",
      method: "request",
      args: [["sample", "db"]],
    });
    host.deliver({
      __frame_cap_r: true,
      id: "p1",
      result: { sample: "granted", db: "unavailable" },
    });
    await expect(pending).resolves.toEqual({ sample: "granted", db: "unavailable" });
  });

  it("sends no argument for request() with no names", async () => {
    const { permissions, host } = brokered();
    void permissions.request();
    expect(host.sent[0]!.message).toMatchObject({ method: "request", args: [] });
  });

  it("carries a rejection from the shell through unchanged", async () => {
    const { permissions, host } = brokered();
    const pending = permissions.state("sample");
    host.deliver({
      __frame_cap_r: true,
      id: "p1",
      error: { code: "capability_disabled", message: "gone" },
    });
    expect(await failure(pending)).toMatchObject({ code: "capability_disabled", message: "gone" });
  });

  it("reads anything that is not one of the four states as unavailable", async () => {
    const { permissions, host } = brokered();
    const one = permissions.state("sample");
    host.deliver({ __frame_cap_r: true, id: "p1", result: "maybe" });
    await expect(one).resolves.toBe("unavailable");

    const map = permissions.state();
    host.deliver({ __frame_cap_r: true, id: "p2", result: { db: 7, sample: "granted" } });
    await expect(map).resolves.toEqual({ db: "unavailable", sample: "granted" });

    const junk = permissions.state();
    host.deliver({ __frame_cap_r: true, id: "p3", result: "nonsense" });
    await expect(junk).resolves.toEqual({});
  });
});

describe("validation rejects, never throws", () => {
  it("refuses a bad name without a round trip", async () => {
    const { permissions, host } = brokered();
    expect(await failure(permissions.state(7 as unknown as string))).toEqual({
      code: "invalid_content",
      message: "a capability name must be a string",
    });
    expect(await failure(permissions.state("x".repeat(513)))).toMatchObject({
      code: "invalid_content",
    });
    expect(await failure(permissions.request("sample" as unknown as string[]))).toMatchObject({
      code: "invalid_content",
    });
    expect(await failure(permissions.request(new Array(33).fill("db")))).toMatchObject({
      code: "invalid_content",
      message: "request takes at most 32 names",
    });
    expect(host.sent).toEqual([]);
  });
});

describe("a view with nothing to govern", () => {
  it("answers locally and never opens a channel to the shell", async () => {
    const { permissions, host } = local();
    await expect(permissions.state()).resolves.toEqual({});
    await expect(permissions.state("sample")).resolves.toBe("unavailable");
    await expect(permissions.request(["sample", "db"])).resolves.toEqual({
      sample: "unavailable",
      db: "unavailable",
    });
    await expect(permissions.request()).resolves.toEqual({});
    expect(host.sent).toEqual([]);
  });

  it("still validates its arguments the same way", async () => {
    const { permissions } = local();
    expect(await failure(permissions.state(7 as unknown as string))).toMatchObject({
      code: "invalid_content",
    });
  });
});

describe("the reply budget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("gives up after 130 s with upstream_error", async () => {
    const { permissions } = brokered();
    const pending = failure(permissions.request(["sample"]));
    await vi.advanceTimersByTimeAsync(RPC_DEFAULT_TIMEOUT_MS - 1);
    await vi.advanceTimersByTimeAsync(2);
    expect(await pending).toEqual({ code: "upstream_error", message: "no reply from shell" });
  });

  it("waits 900 s once the shell acks that a viewer is deciding", async () => {
    const { permissions, host } = brokered();
    const pending = permissions.request(["sample"]);
    host.deliver({ __frame_cap_ack: true, id: "p1" });

    // Well past the un-acked budget, and still waiting on the viewer.
    await vi.advanceTimersByTimeAsync(RPC_DEFAULT_TIMEOUT_MS * 2);
    host.deliver({ __frame_cap_r: true, id: "p1", result: { sample: "granted" } });
    await expect(pending).resolves.toEqual({ sample: "granted" });

    const second = failure(permissions.request(["sample"]));
    host.deliver({ __frame_cap_ack: true, id: "p2" });
    await vi.advanceTimersByTimeAsync(RPC_ACK_TIMEOUT_MS + 1);
    expect(await second).toMatchObject({ code: "upstream_error" });
  });
});
