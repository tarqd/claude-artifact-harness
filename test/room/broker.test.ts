/**
 * The shell broker's wire mapping and the topic ACL. No browser here, so no
 * lane opens: what is asserted is exactly what the broker decides on its own
 * — the peer identity it hands the frame, who may send on which topic, and
 * the v0 answers for the send-to-Claude pair.
 */
import { describe, expect, it } from "vitest";
import { dispose, handle } from "../../src/capabilities/room/broker.ts";
import type { BrokerCall, BrokerContext, ShellBoot } from "../../src/shell/types.ts";

interface Harness {
  ctx: BrokerContext;
  events: Array<Record<string, unknown>>;
}

function harness(options: { level?: string; topics?: Record<string, string> } = {}): Harness {
  const events: Array<Record<string, unknown>> = [];
  const level = options.level ?? "interact";
  const boot: ShellBoot = {
    artifactId: "a".repeat(32),
    version: "v1",
    title: "room",
    frameOrigin: "http://frame.test",
    frameUrl: "http://frame.test/_f/v1/",
    contract: "0.2.32",
    changes: [],
    flags: [],
    capabilities: { room: { config: { topics: options.topics ?? {} } } },
    viewer: { id: "u_test", level, canEdit: level === "admin" || level === "owner", isOwner: false },
    versionPollMs: 0,
  };
  const ctx = {
    boot,
    version: "v1",
    viewer: boot.viewer,
    flags: new Set<string>(),
    toFrame: (message: unknown) => events.push(message as Record<string, unknown>),
    ack: () => undefined,
    progress: () => undefined,
    reloadView: () => undefined,
    setVersion: () => undefined,
    consent: () => Promise.resolve(false),
    api: () => Promise.reject(new Error("no backend in this test")),
  } as unknown as BrokerContext;
  return { ctx, events };
}

function call(method: string, args: unknown[] = []): BrokerCall {
  return { cap: "room", id: "r1", method, args };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return `${e.code}: ${e.message}`;
  }
}

describe("hello", () => {
  it("hands the frame a stable peer id and the current transport state", async () => {
    const { ctx } = harness();
    const first = (await handle(call("hello"), ctx)) as { peer: string; up: boolean };
    expect(first.peer).toMatch(/^[a-z0-9]{16}$/);
    expect(first.up).toBe(false); // no WebSocket in a node test
    const second = (await handle(call("hello"), ctx)) as { peer: string };
    expect(second.peer).toBe(first.peer);
    dispose(ctx);
  });

  it("gives every view its own peer id", async () => {
    const a = harness();
    const b = harness();
    const one = (await handle(call("hello"), a.ctx)) as { peer: string };
    const two = (await handle(call("hello"), b.ctx)) as { peer: string };
    expect(one.peer).not.toBe(two.peer);
    dispose(a.ctx);
    dispose(b.ctx);
  });
});

describe("presence", () => {
  it("accepts an object and refuses anything else", async () => {
    const { ctx } = harness();
    await expect(handle(call("presence", [{ cursor: { x: 1 } }]), ctx)).resolves.toBeUndefined();
    expect(await refusal(handle(call("presence", [[1]]), ctx))).toContain("invalid_argument");
    expect(await refusal(handle(call("presence", ["hi"]), ctx))).toContain("invalid_argument");
    dispose(ctx);
  });
});

describe("the topic ACL", () => {
  it("keeps an undeclared topic admin-only", async () => {
    const { ctx } = harness({ level: "interact" });
    expect(await refusal(handle(call("emit", ["reaction", {}]), ctx))).toBe(
      'not_permitted: this viewer may not send on the topic "reaction"',
    );
    dispose(ctx);
  });

  it("opens a topic declared at the interact level", async () => {
    const { ctx } = harness({ level: "interact", topics: { reaction: "interact" } });
    await expect(handle(call("emit", ["reaction", {}]), ctx)).resolves.toBeUndefined();
    expect(await refusal(handle(call("emit", ["clear", {}]), ctx))).toContain("not_permitted");
    dispose(ctx);
  });

  it("lets an admin viewer send on an admin topic", async () => {
    const { ctx } = harness({ level: "admin", topics: { clear: "admin" } });
    await expect(handle(call("emit", ["clear", {}]), ctx)).resolves.toBeUndefined();
    dispose(ctx);
  });

  it("refuses a view-level viewer even on an interact topic", async () => {
    const { ctx } = harness({ level: "view", topics: { reaction: "interact" } });
    expect(await refusal(handle(call("emit", ["reaction", {}]), ctx))).toContain("not_permitted");
    dispose(ctx);
  });

  it("checks the topic grammar before the ACL", async () => {
    const { ctx } = harness({ level: "owner" });
    expect(await refusal(handle(call("emit", ["Bad:Topic", {}]), ctx))).toContain(
      "emit topic must match",
    );
    dispose(ctx);
  });
});

describe("the send-to-Claude pair in v0", () => {
  it("answers `off` and refuses the send", async () => {
    const { ctx } = harness();
    await expect(handle(call("canSendToClaudeSession"), ctx)).resolves.toBe("off");
    expect(await refusal(handle(call("sendToClaudeSession", [{ a: 1 }, {}]), ctx))).toBe(
      "claude_unavailable: no conversation with Claude is open beside this view",
    );
    dispose(ctx);
  });
});

describe("unknown methods", () => {
  it("are an invalid_argument, not a silent resolve", async () => {
    const { ctx } = harness();
    expect(await refusal(handle(call("teleport"), ctx))).toBe(
      "invalid_argument: room.teleport is not a method",
    );
    dispose(ctx);
  });
});
