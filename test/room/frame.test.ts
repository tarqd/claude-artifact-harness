/**
 * The frame module's observable behaviour: the handshake, the presence
 * model and its coalescing, the per-frame `onPeers` batching, the emit token
 * bucket, and the terminal state — all under a fake clock, so the timings
 * the contract promises are actually asserted rather than waited out.
 */
import { describe, expect, it } from "vitest";
import { readLimits, type Peer, type PeersChange } from "../../src/capabilities/room/frame.ts";
import { connectedRoom, newRoom, tick } from "./harness.ts";

const ME = "mypeer0000000001";

function reason(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return `${e.code}: ${e.message}`;
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (err) {
    return reason(err);
  }
}

describe("limits", () => {
  it("defaults and clamps", () => {
    expect(readLimits(undefined)).toEqual({
      maxBytes: 4096,
      presenceHz: 30,
      keepaliveMs: 20_000,
      silenceMs: 150_000,
      maxPeers: 256,
    });
    const clamped = readLimits({ limits: { maxBytes: 10, presenceHz: 1000, maxPeers: 8 } });
    expect(clamped.maxBytes).toBe(1024);
    expect(clamped.presenceHz).toBe(120);
    expect(clamped.maxPeers).toBe(8);
    expect(readLimits({ limits: { keepaliveMs: "soon" } }).keepaliveMs).toBe(20_000);
  });
});

describe("the handshake", () => {
  it("posts hello at install and stays disconnected until answered", () => {
    const { env, room } = newRoom();
    const hello = env.last("hello");
    expect(hello?.method).toBe("hello");
    expect(hello?.args).toEqual([]);
    expect(room.connected()).toBe(false);
    expect(room.peers()).toEqual([]);
  });

  it("adopts the peer id, shows self and re-asserts presence when connected", async () => {
    const { env, room } = await connectedRoom();
    expect(room.connected()).toBe(true);
    const self = room.peers()[0]!;
    expect(self.peer).toBe(ME);
    expect(self.isMe).toBe(true);
    expect(self.sameTab).toBe(true);
    expect(self.by).toBeNull();
    expect(self.kind).toBe("viewer");
    expect(self.presence).toEqual({});
    // `up` re-asserts this document: the whole object goes out at once.
    expect(env.calls("presence").map((c) => c.args)).toEqual([[{}]]);
  });

  it("turns a terminal hello into `not_granted` on every listener", async () => {
    const { env, room } = newRoom();
    const seen: string[] = [];
    room.onPeers(() => undefined, (e) => seen.push(e.code));
    room.on("reaction", () => undefined, (e) => seen.push(e.code));
    room.onConnection(() => undefined, (e) => seen.push(e.code));
    env.reply(env.last("hello")!.id, { terminal: { code: "not_granted" } });
    await tick();
    expect(seen).toEqual(["not_granted", "not_granted", "not_granted"]);
    expect(room.connected()).toBe(false);
    expect(await rejection(room.emit("reaction"))).toBe(
      "not_granted: The room channel is no longer available to this view.",
    );
  });

  it("retries hello only when the transport says it came back", async () => {
    const { env } = newRoom();
    expect(env.calls("hello")).toHaveLength(1);
    env.fail(env.last("hello")!.id, { code: "upstream_error", message: "nope" });
    await tick();
    expect(env.calls("hello")).toHaveLength(1);

    env.fail(env.last("hello")!.id, { code: "upstream_error", message: "nope" });
    await tick();
    // A `conn up` while the retry decision is pending is what buys a retry.
    env.roomEvent({ arm: "conn", up: true });
    await tick();
    expect(env.calls("hello")).toHaveLength(2);
  });
});

describe("presence", () => {
  it("applies locally at once and sends the whole merged object, coalesced", async () => {
    const { env, room } = await connectedRoom();
    env.posted.length = 0;

    void room.presence({ cursor: { x: 1, y: 2 } });
    void room.presence({ cursor: { x: 3, y: 4 } });
    void room.presence({ who: "ada" });
    await tick();

    // Local first: no round trip for your own cursor.
    expect(room.peers()[0]!.presence).toEqual({ cursor: { x: 3, y: 4 }, who: "ada" });
    expect(env.calls("presence")).toHaveLength(0);

    env.advance(34);
    expect(env.calls("presence").map((c) => c.args)).toEqual([
      [{ cursor: { x: 3, y: 4 }, who: "ada" }],
    ]);
  });

  it("keeps a keepalive going and re-arms it on every send", async () => {
    const { env, room } = await connectedRoom();
    env.posted.length = 0;
    env.advance(20_000);
    expect(env.calls("presence")).toHaveLength(1);

    void room.presence({ a: 1 });
    await tick();
    env.advance(34);
    expect(env.calls("presence")).toHaveLength(2);
    env.advance(19_000);
    expect(env.calls("presence")).toHaveLength(2); // the send re-armed it
    env.advance(1100);
    expect(env.calls("presence")).toHaveLength(3);
  });

  it("rejects an over-large merge without applying it", async () => {
    const { room } = await connectedRoom();
    void room.presence({ who: "ada" });
    await tick();
    expect(await rejection(room.presence({ big: "x".repeat(5000) }))).toContain(
      "your merged presence object serializes over 4096 bytes",
    );
    expect(room.peers()[0]!.presence).toEqual({ who: "ada" });
  });

  it("honours a configured byte cap", async () => {
    const { room } = await connectedRoom({ limits: { maxBytes: 1024 } });
    expect(await rejection(room.presence({ big: "x".repeat(2000) }))).toContain(
      "serializes over 1024 bytes",
    );
  });
});

describe("the peer map", () => {
  it("adds an inbound peer, keeps identity when nothing changed, and sweeps silence", async () => {
    const { env, room } = await connectedRoom();
    env.roomEvent({ arm: "presence", peer: "other0000000001", p: { who: "grace" } });
    const first = room.peers().find((p) => p.peer === "other0000000001")!;
    expect(first.presence).toEqual({ who: "grace" });
    expect(first.isMe).toBe(false);
    expect(first.sameTab).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.presence)).toBe(true);

    // A keepalive carrying the same object must not bump `updatedAt`.
    env.advance(1000);
    env.roomEvent({ arm: "presence", peer: "other0000000001", p: { who: "grace" } });
    expect(room.peers().find((p) => p.peer === "other0000000001")).toBe(first);

    env.roomEvent({ arm: "presence", peer: "other0000000001", p: { who: "grace", at: 1 } });
    const second = room.peers().find((p) => p.peer === "other0000000001")!;
    expect(second).not.toBe(first);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);

    // Unseen for `silenceMs`, swept within one 15 s sweep period.
    env.advance(150_000 + 15_000);
    expect(room.peers().map((p) => p.peer)).toEqual([ME]);
  });

  it("refuses inbound presence over the cap, whatever the lane let through", async () => {
    const { env, room } = await connectedRoom();
    // Nothing the frame sends can be this big; a lane client is not the frame.
    env.roomEvent({
      arm: "presence",
      peer: "other0000000001",
      p: { big: "x".repeat(5000) },
    });
    expect(room.peers().map((p) => p.peer)).toEqual([ME]);
    env.roomEvent({ arm: "presence", peer: "other0000000001", p: { who: "grace" } });
    expect(room.peers()).toHaveLength(2);
  });

  it("forgets a peer it only ever heard an event from", async () => {
    const { env, room } = await connectedRoom();
    room.on("reaction", () => undefined);
    env.roomEvent({ arm: "event", peer: "ghost00000000001", topic: "reaction", d: 1 });
    // An emit-only sender is never a peer...
    expect(room.peers().map((p) => p.peer)).toEqual([ME]);
    // ...and the silence sweep drops the id it remembered rather than
    // walking it forever.
    env.roomEvent({ arm: "gone", peer: "ghost00000000001" });
    env.advance(150_000 + 15_000);
    expect(room.peers().map((p) => p.peer)).toEqual([ME]);
  });

  it("answers a newcomer with its own presence, jittered", async () => {
    const { env, room } = await connectedRoom();
    void room.presence({ who: "ada" });
    await tick();
    env.advance(34);
    env.posted.length = 0;

    env.roomEvent({ arm: "presence", peer: "other0000000001", p: {} });
    expect(env.calls("presence")).toHaveLength(0);
    env.advance(500);
    expect(env.calls("presence").map((c) => c.args)).toEqual([[{ who: "ada" }]]);
    expect(room.peers()).toHaveLength(2);
  });

  it("drops its own echo and honours `gone`", async () => {
    const { env, room } = await connectedRoom();
    env.roomEvent({ arm: "presence", peer: ME, p: { spoofed: true }, isMe: true, sameTab: true });
    expect(room.peers()[0]!.presence).toEqual({});

    env.roomEvent({ arm: "presence", peer: "other0000000001", p: {} });
    expect(room.peers()).toHaveLength(2);
    env.roomEvent({ arm: "gone", peer: "other0000000001" });
    expect(room.peers().map((p) => p.peer)).toEqual([ME]);
  });

  it("caps the map at maxPeers", async () => {
    const { env, room } = await connectedRoom({ limits: { maxPeers: 3 } });
    for (let i = 0; i < 5; i++) {
      env.roomEvent({ arm: "presence", peer: `peer000000000${i}`, p: { i } });
    }
    expect(room.peers()).toHaveLength(3);
  });
});

describe("onPeers", () => {
  it("presents the room so far as joined, then batches per frame", async () => {
    const { env, room } = await connectedRoom();
    const seen: PeersChange[] = [];
    room.onPeers((change) => seen.push(change));
    await tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.joined.map((p) => p.peer)).toEqual([ME]);
    expect(seen[0]!.peers).toBe(room.peers());

    // Three updates by one peer inside one frame are one `updated` entry.
    env.roomEvent({ arm: "presence", peer: "other0000000001", p: { n: 1 } });
    env.roomEvent({ arm: "presence", peer: "other0000000001", p: { n: 2 } });
    env.roomEvent({ arm: "presence", peer: "other0000000001", p: { n: 3 } });
    expect(seen).toHaveLength(1);
    env.frame();
    expect(seen).toHaveLength(2);
    expect(seen[1]!.joined.map((p) => p.peer)).toEqual(["other0000000001"]);
    expect(seen[1]!.updated).toEqual([]);
    expect(seen[1]!.left).toEqual([]);

    env.roomEvent({ arm: "presence", peer: "other0000000001", p: { n: 9 } });
    env.frame();
    expect(seen[2]!.updated.map((p) => p.presence)).toEqual([{ n: 9 }]);
    expect(seen[2]!.joined).toEqual([]);
  });

  it("cancels a join and leave that happen inside one frame", async () => {
    const { env, room } = await connectedRoom();
    const seen: PeersChange[] = [];
    room.onPeers((change) => seen.push(change));
    await tick();
    seen.length = 0;

    env.roomEvent({ arm: "presence", peer: "other0000000001", p: {} });
    env.roomEvent({ arm: "gone", peer: "other0000000001" });
    env.frame();
    expect(seen).toHaveLength(0);
    expect(room.peers().map((p) => p.peer)).toEqual([ME]);
  });

  it("reports a departure with the object the listener last saw", async () => {
    const { env, room } = await connectedRoom();
    const seen: PeersChange[] = [];
    room.onPeers((change) => seen.push(change));
    await tick();
    env.roomEvent({ arm: "presence", peer: "other0000000001", p: { who: "grace" } });
    env.frame();
    const joined = seen.at(-1)!.joined[0]!;

    env.roomEvent({ arm: "gone", peer: "other0000000001" });
    env.frame();
    const left: readonly Peer[] = seen.at(-1)!.left;
    expect(left[0]).toBe(joined);
  });

  it("throws TypeError for a non-function handler", async () => {
    const { room } = await connectedRoom();
    expect(() => room.onPeers(undefined as never)).toThrow(TypeError);
    expect(() => room.on("reaction", undefined as never)).toThrow(TypeError);
    expect(() => room.onConnection(undefined as never)).toThrow(TypeError);
  });

  it("keeps the same frozen snapshot until something changes", async () => {
    const { env, room } = await connectedRoom();
    const first = room.peers();
    expect(room.peers()).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    env.roomEvent({ arm: "presence", peer: "other0000000001", p: {} });
    expect(room.peers()).not.toBe(first);
  });
});

describe("events", () => {
  it("delivers a frozen message to every listener on that topic", async () => {
    const { env, room } = await connectedRoom();
    const seen: Array<Record<string, unknown>> = [];
    const off = room.on("reaction", (msg) => seen.push(msg as unknown as Record<string, unknown>));
    room.on("other", () => seen.push({ wrong: true }));

    env.roomEvent({
      arm: "event",
      topic: "reaction",
      peer: "other0000000001",
      d: { kind: "wave" },
      isMe: false,
      sameTab: false,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      peer: "other0000000001",
      by: null,
      isMe: false,
      sameTab: false,
      kind: "viewer",
      topic: "reaction",
      data: { kind: "wave" },
    });
    expect(Object.isFrozen(seen[0])).toBe(true);

    off();
    env.roomEvent({ arm: "event", topic: "reaction", peer: "other0000000001", d: 1 });
    expect(seen).toHaveLength(1);
  });

  it("hands the sender its own echo with isMe and sameTab", async () => {
    const { env, room } = await connectedRoom();
    const seen: Array<{ isMe: boolean; sameTab: boolean }> = [];
    room.on("reaction", (msg) => seen.push({ isMe: msg.isMe, sameTab: msg.sameTab }));
    env.roomEvent({
      arm: "event",
      topic: "reaction",
      peer: ME,
      d: 1,
      isMe: true,
      sameTab: true,
    });
    expect(seen).toEqual([{ isMe: true, sameTab: true }]);
  });

  it("reports a malformed topic through onError, once, on a microtask", async () => {
    const { room } = await connectedRoom();
    const seen: string[] = [];
    const off = room.on("Bad:Topic", () => undefined, (e) => seen.push(reason(e)));
    expect(seen).toEqual([]);
    await tick();
    expect(seen).toEqual([
      "invalid_argument: on topic must match ^[a-z][a-z0-9_.-]{0,47}$ (colon-free)",
    ]);
    off();
  });

  it("validates emit and posts it once permitted", async () => {
    const { env, room } = await connectedRoom();
    expect(await rejection(room.emit("Bad:Topic"))).toContain("emit topic must match");
    const pending = room.emit("reaction", { n: 1 });
    const call = env.last("emit")!;
    expect(call.args).toEqual(["reaction", { n: 1 }]);
    env.reply(call.id, undefined);
    await expect(pending).resolves.toBeUndefined();
  });

  it("passes the shell's not_permitted straight through", async () => {
    const { env, room } = await connectedRoom();
    const pending = room.emit("admin.only", {});
    env.fail(env.last("emit")!.id, {
      code: "not_permitted",
      message: 'this viewer may not send on the topic "admin.only"',
    });
    expect(await rejection(pending)).toBe(
      'not_permitted: this viewer may not send on the topic "admin.only"',
    );
  });

  it("drops past the token bucket and reports it once per page load", async () => {
    const { env, room } = await connectedRoom();
    env.posted.length = 0;
    for (let i = 0; i < 90; i++) void room.emit("reaction", { i });
    await tick();
    expect(env.calls("emit")).toHaveLength(80);
    expect(env.reported).toHaveLength(1);
    expect(String(env.reported[0])).toContain("rate limit");

    for (let i = 0; i < 10; i++) void room.emit("reaction", { i });
    await tick();
    expect(env.reported).toHaveLength(1);

    // The bucket refills at 40/s.
    env.advance(1000);
    void room.emit("reaction", {});
    await tick();
    expect(env.calls("emit")).toHaveLength(81);
  });
});

describe("connection", () => {
  it("fires once with the current state, then on every edge", async () => {
    const { env, room } = await connectedRoom();
    const seen: boolean[] = [];
    room.onConnection((up) => seen.push(up));
    await tick();
    expect(seen).toEqual([true]);
    env.roomEvent({ arm: "conn", up: false });
    env.roomEvent({ arm: "conn", up: false });
    env.roomEvent({ arm: "conn", up: true });
    expect(seen).toEqual([true, false, true]);
    expect(room.connected()).toBe(true);
  });
});

describe("the terminal state", () => {
  it("collapses to self, kills every listener and rejects thereafter", async () => {
    const { env, room } = await connectedRoom();
    const errors: string[] = [];
    const peersSeen: PeersChange[] = [];
    room.onPeers((c) => peersSeen.push(c), (e) => errors.push(`peers:${e.code}`));
    room.on("reaction", () => undefined, (e) => errors.push(`on:${e.code}`));
    room.onConnection(() => undefined, (e) => errors.push(`conn:${e.code}`));
    await tick();
    env.roomEvent({ arm: "presence", peer: "other0000000001", p: {} });
    env.frame();

    env.roomEvent({ arm: "revoked" });
    expect(errors).toEqual(["on:revoked", "peers:revoked", "conn:revoked"]);
    expect(room.connected()).toBe(false);
    expect(room.peers().map((p) => p.peer)).toEqual([ME]);
    expect(await rejection(room.presence({ a: 1 }))).toBe(
      "revoked: The room channel is no longer available to this view.",
    );

    // Late registrations get the terminal error on a microtask and nothing else.
    const late: string[] = [];
    room.onPeers(() => late.push("delivered"), (e) => late.push(e.code));
    await tick();
    expect(late).toEqual(["revoked"]);
  });

  it("keeps the send-to-Claude pair working after a terminal error", async () => {
    const { env, room } = await connectedRoom();
    env.roomEvent({ arm: "revoked", code: "capability_disabled" });
    const pending = room.canSendToClaudeSession();
    env.reply(env.last("canSendToClaudeSession")!.id, "off");
    await expect(pending).resolves.toBe("off");
  });
});

describe("the Claude hand-off", () => {
  it("validates before posting and asks for a proven gesture", async () => {
    const { env, room } = await connectedRoom();
    expect(await rejection(room.sendToClaudeSession("nope"))).toContain(
      "takes one plain object the artifact defines",
    );
    expect(env.last("sendToClaudeSession")).toBeUndefined();

    const pending = room.sendToClaudeSession({ label: "Q3", chartId: "c1" }, { deliver: "send" });
    const call = env.last("sendToClaudeSession")!;
    expect(call.activation).toBe(true);
    expect(call.args).toEqual([{ label: "Q3", chartId: "c1" }, { deliver: "send" }]);
    env.reply(call.id, { to: "session" });
    await expect(pending).resolves.toEqual({ to: "session" });
  });

  it("normalises an unknown destination to `pane` and a non-string answer to `off`", async () => {
    const { env, room } = await connectedRoom();
    const sent = room.sendToClaudeSession({ a: 1 });
    env.reply(env.last("sendToClaudeSession")!.id, { to: "elsewhere" });
    await expect(sent).resolves.toEqual({ to: "pane" });

    const can = room.canSendToClaudeSession();
    env.reply(env.last("canSendToClaudeSession")!.id, 7);
    await expect(can).resolves.toBe("off");
  });
});

describe("the visibility flush", () => {
  it("delivers a batch a hidden tab never got an animation frame for", async () => {
    const { env, room } = await connectedRoom();
    const seen: PeersChange[] = [];
    room.onPeers((c) => seen.push(c));
    await tick();
    seen.length = 0;

    env.roomEvent({ arm: "presence", peer: "other0000000001", p: { who: "grace" } });
    expect(seen).toHaveLength(0); // no animation frame while hidden
    env.becameVisible();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.joined.map((p) => p.peer)).toEqual(["other0000000001"]);
  });
});
