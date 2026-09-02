/**
 * The broker's wire mapping and its subscription bookkeeping, against a fake
 * backend. No browser here, so the realtime lane is absent and every
 * delivery takes the refresh path - which is exactly the fallback the
 * contract requires to behave identically.
 */
import { describe, expect, it } from "vitest";
import { applyLocalWrite, dispose, handle } from "../../src/capabilities/db/broker.ts";
import type { BrokerCall, BrokerContext } from "../../src/shell/types.ts";

interface Harness {
  ctx: BrokerContext;
  events: Array<Record<string, unknown>>;
  posted: Array<Record<string, unknown>>;
  docs: Map<string, Record<string, unknown>>;
  fail: { code: string; message: string } | null;
  writeFail: { code: string; message: string } | null;
}

function harness(): Harness {
  const events: Array<Record<string, unknown>> = [];
  const posted: Array<Record<string, unknown>> = [];
  const docs = new Map<string, Record<string, unknown>>();
  const state: {
    fail: { code: string; message: string } | null;
    writeFail: { code: string; message: string } | null;
  } = { fail: null, writeFail: null };

  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posted.push({ path, ...body });
    if (state.fail) throw state.fail;
    if (state.writeFail && ["set", "update", "delete"].includes(String(body.verb))) {
      throw state.writeFail;
    }
    if (path.endsWith("/subscribe")) {
      return { grant: "grant-1", spec: body.spec, expiresIn: 600 } as T;
    }
    switch (body.verb) {
      case "get": {
        const data = docs.get(String(body.path));
        const id = String(body.path).split("/").pop();
        return (data ? { id, exists: true, data } : { id, exists: false }) as T;
      }
      case "set":
        docs.set(String(body.path), body.body as Record<string, unknown>);
        return { ok: true } as T;
      case "delete":
        docs.delete(String(body.path));
        return { ok: true } as T;
      case "acquire":
        return { acquired: true, version: 1, expiresAt: "2026-01-01T00:00:00.000Z", holder: "h" } as T;
      case "query": {
        const spec = body.spec as { collection: string };
        const rows = [...docs.entries()]
          .filter(([key]) => key.startsWith(`${spec.collection}/`))
          .filter(([key]) => key.split("/").length === spec.collection.split("/").length + 1)
          .map(([key, data]) => ({ id: key.split("/").pop(), data }))
          .sort((a, b) => (a.id! < b.id! ? -1 : 1));
        return { docs: rows } as T;
      }
      default:
        throw { code: "invalid_argument", message: `unknown verb ${String(body.verb)}` };
    }
  };

  const ctx = {
    boot: { artifactId: "abc" },
    version: "v1",
    viewer: { id: "u_1", level: "interact", canEdit: false, isOwner: false },
    flags: new Set<string>(),
    toFrame: (message: unknown) => {
      const envelope = message as { __frame_db_ev?: boolean; ev?: Record<string, unknown> };
      if (envelope.__frame_db_ev && envelope.ev) events.push(envelope.ev);
    },
    ack: () => undefined,
    progress: () => undefined,
    reloadView: () => undefined,
    setVersion: () => undefined,
    consent: async () => true,
    api,
  } as unknown as BrokerContext;

  return {
    ctx,
    events,
    posted,
    docs,
    get fail() { return state.fail; },
    set fail(v) { state.fail = v; },
    get writeFail() { return state.writeFail; },
    set writeFail(v) { state.writeFail = v; },
  } as Harness;
}

function call(method: string, ...args: unknown[]): BrokerCall {
  return { cap: "db", id: `b${method}`, method, args };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("verbs", () => {
  it("maps each method onto the documented call body", async () => {
    const h = harness();
    await handle(call("set", { path: "tasks/t1" }, { title: "one" }), h.ctx);
    await handle(call("get", { path: "tasks/t1" }), h.ctx);
    await handle(call("delete", { path: "tasks/t1" }), h.ctx);
    await handle(call("query", { collection: "tasks", limit: 5 }), h.ctx);
    expect(h.posted.map((p) => p.verb)).toEqual(["set", "get", "delete", "query"]);
    expect(h.posted[0]).toMatchObject({ path: "tasks/t1", body: { title: "one" } });
    expect(h.posted[3]).toMatchObject({ spec: { collection: "tasks", limit: 5 } });
    dispose(h.ctx);
  });

  it("resolves a write with nothing and an acquire with its result", async () => {
    const h = harness();
    expect(await handle(call("set", { path: "tasks/t1" }, { a: 1 }), h.ctx)).toBeUndefined();
    expect(await handle(call("acquire", { path: "locks/l" }, { holder: "h" }), h.ctx)).toEqual({
      acquired: true,
      version: 1,
      expiresAt: "2026-01-01T00:00:00.000Z",
      holder: "h",
    });
    dispose(h.ctx);
  });

  it("refuses a path-less call and an unknown method", async () => {
    const h = harness();
    await expect(handle(call("get", "tasks/t1"), h.ctx)).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(handle(call("teleport", {}), h.ctx)).rejects.toMatchObject({
      code: "capability_removed",
    });
    dispose(h.ctx);
  });
});

describe("subscriptions", () => {
  it("delivers a first snapshot, then the ops for each change", async () => {
    const h = harness();
    await handle(call("set", { path: "tasks/t1" }, { title: "one" }), h.ctx);
    await handle(call("subscribe", "s1", { collection: "tasks" }), h.ctx);

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toEqual({
      type: "snapshot",
      subId: "s1",
      // No lane in this environment: the refresh path marks its deliveries.
      fromCache: true,
      hasPendingWrites: false,
      ops: [{ type: "added", id: "t1", data: { title: "one" }, oldIndex: -1, newIndex: 0 }],
    });

    // A write lands twice: the page's own row at once, marked pending, then
    // the server's confirmation clearing the flag (db.d.ts latency
    // compensation - "your own writes appear immediately").
    await handle(call("set", { path: "tasks/t2" }, { title: "two" }), h.ctx);
    await settle();
    expect(h.events).toHaveLength(3);
    expect(h.events[1]).toMatchObject({
      hasPendingWrites: true,
      ops: [{ type: "added", id: "t2", data: { title: "two" }, oldIndex: -1, newIndex: 1 }],
    });
    expect(h.events[2]).toMatchObject({ hasPendingWrites: false, ops: [] });

    await handle(call("delete", { path: "tasks/t1" }), h.ctx);
    await settle();
    expect(h.events[3]).toMatchObject({
      hasPendingWrites: true,
      ops: [{ type: "removed", id: "t1", oldIndex: 0, newIndex: -1 }],
    });
    expect(h.events[4]).toMatchObject({ hasPendingWrites: false, ops: [] });
    expect(h.events).toHaveLength(5);
    dispose(h.ctx);
  });

  it("rolls an optimistic row back when the server refuses the write", async () => {
    const h = harness();
    await handle(call("subscribe", "s1", { collection: "tasks" }), h.ctx);
    h.writeFail = { code: "invalid_argument", message: "rules say no" };

    await expect(
      handle(call("set", { path: "tasks/t1" }, { title: "one" }), h.ctx),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await settle();

    expect(h.events[1]).toMatchObject({
      hasPendingWrites: true,
      ops: [{ type: "added", id: "t1", data: { title: "one" }, oldIndex: -1, newIndex: 0 }],
    });
    // The confirming refresh runs whether or not the write was accepted.
    expect(h.events[2]).toMatchObject({
      hasPendingWrites: false,
      ops: [{ type: "removed", id: "t1", oldIndex: 0, newIndex: -1 }],
    });
    dispose(h.ctx);
  });

  it("says nothing when a write changed nothing this subscription sees", async () => {
    const h = harness();
    await handle(call("subscribe", "s1", { collection: "tasks" }), h.ctx);
    expect(h.events).toHaveLength(1);
    await handle(call("set", { path: "other/o1" }, { a: 1 }), h.ctx);
    await settle();
    expect(h.events).toHaveLength(1);
    dispose(h.ctx);
  });

  it("stops delivering after unsubscribe", async () => {
    const h = harness();
    await handle(call("subscribe", "s1", { collection: "tasks" }), h.ctx);
    await handle(call("unsubscribe", "s1"), h.ctx);
    await handle(call("set", { path: "tasks/t9" }, { a: 1 }), h.ctx);
    await settle();
    expect(h.events).toHaveLength(1);
    dispose(h.ctx);
  });

  it("passes a subscribe refusal back to the caller", async () => {
    const h = harness();
    h.fail = { code: "invalid_argument", message: "bad spec" };
    await expect(handle(call("subscribe", "s1", { collection: "a/b" }), h.ctx)).rejects.toMatchObject(
      { code: "invalid_argument" },
    );
    expect(h.events).toEqual([]);
    dispose(h.ctx);
  });

  it("refuses a subscription without an id", async () => {
    const h = harness();
    await expect(handle(call("subscribe", 7, { collection: "tasks" }), h.ctx)).rejects.toMatchObject({
      code: "invalid_argument",
    });
    dispose(h.ctx);
  });
});

describe("revocation", () => {
  it("pushes one revoked event and refuses every later call", async () => {
    const h = harness();
    h.fail = { code: "revoked", message: "gone" };
    await expect(handle(call("get", { path: "tasks/t1" }), h.ctx)).rejects.toMatchObject({
      code: "revoked",
    });
    expect(h.events).toEqual([{ type: "revoked" }]);

    h.fail = null;
    await expect(handle(call("get", { path: "tasks/t1" }), h.ctx)).rejects.toMatchObject({
      code: "revoked",
    });
    // At most one delivery per view.
    expect(h.events).toEqual([{ type: "revoked" }]);
    dispose(h.ctx);
  });
});

describe("latency compensation", () => {
  const rows = [
    { id: "a", data: { n: 1 } },
    { id: "b", data: { n: 2 } },
  ];

  it("places the page's own write where the server would", () => {
    // A document subscription: only its own path moves it.
    expect(
      applyLocalWrite(rows, { path: "tasks/a" }, { verb: "delete", path: "tasks/a" }, "u_1"),
    ).toEqual([]);
    expect(
      applyLocalWrite(rows, { path: "tasks/a" }, { verb: "delete", path: "tasks/b" }, "u_1"),
    ).toBeNull();

    // A collection subscription: ordered by id, like the store.
    expect(
      applyLocalWrite(
        rows,
        { collection: "tasks" },
        { verb: "set", path: "tasks/ab", body: { n: 3 } },
        "u_1",
      ),
    ).toEqual([
      { id: "a", data: { n: 1 } },
      { id: "ab", data: { n: 3 } },
      { id: "b", data: { n: 2 } },
    ]);

    // Another collection is not this subscription's business.
    expect(
      applyLocalWrite(rows, { collection: "notes" }, { verb: "delete", path: "tasks/a" }, "u_1"),
    ).toBeNull();
  });

  it("honours the subscription's filters, order and limit", () => {
    const spec = {
      collection: "tasks",
      where: [{ f: "done", op: "==", v: true }],
      orderBy: { f: "n", dir: "desc" },
      limit: 2,
    };
    const done = [
      { id: "a", data: { n: 1, done: true } },
      { id: "b", data: { n: 2, done: true } },
    ];
    // A row the filter rejects never enters the mirror.
    expect(
      applyLocalWrite(done, spec, { verb: "set", path: "tasks/c", body: { n: 9 } }, "u_1"),
    ).toEqual([
      { id: "b", data: { n: 2, done: true } },
      { id: "a", data: { n: 1, done: true } },
    ]);
    // One it accepts is ordered and windowed exactly as the server would.
    expect(
      applyLocalWrite(
        done,
        spec,
        { verb: "set", path: "tasks/c", body: { n: 9, done: true } },
        "u_1",
      ),
    ).toEqual([
      { id: "c", data: { n: 9, done: true } },
      { id: "b", data: { n: 2, done: true } },
    ]);
  });

  it("merges an update, and refuses to invent one", () => {
    const held = [{ id: "a", data: { profile: { name: "x", tz: "UTC" } } }];
    expect(
      applyLocalWrite(
        held,
        { path: "tasks/a" },
        { verb: "update", path: "tasks/a", body: { profile: { name: "y" } } },
        "u_1",
      ),
    ).toEqual([{ id: "a", data: { profile: { name: "y", tz: "UTC" } } }]);
    // Nothing to merge into, and a body the server would refuse: wait instead.
    expect(
      applyLocalWrite([], { path: "tasks/a" }, { verb: "update", path: "tasks/a", body: {} }, "u_1"),
    ).toBeNull();
    expect(
      applyLocalWrite(rows, { path: "tasks/a" }, { verb: "set", path: "tasks/a", body: 7 }, "u_1"),
    ).toBeNull();
  });

  it("matches a private path in both forms: `me` and the resolved viewer id", () => {
    // The subscription's spec comes back from the server already resolved.
    expect(
      applyLocalWrite(
        [],
        { collection: "data/users/u_1/notes" },
        { verb: "set", path: "data/users/me/notes/n1", body: { t: "hi" } },
        "u_1",
      ),
    ).toEqual([{ id: "n1", data: { t: "hi" } }]);
    expect(
      applyLocalWrite(
        [],
        { collection: "data/users/u_2/notes" },
        { verb: "set", path: "data/users/me/notes/n1", body: { t: "hi" } },
        "u_1",
      ),
    ).toBeNull();
  });
});
