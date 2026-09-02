/**
 * The db backend over real sockets: the call endpoint, per-viewer privacy,
 * and the realtime lane one viewer's write reaches another viewer on.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "../../src/server/index.ts";

let server: RunningServer;
let dataDir: string;

const HTML = "<!doctype html><html><head><title>db</title></head><body>db</body></html>";

/** One browser: it keeps its viewer cookie, so two clients are two viewers. */
class Client {
  cookie = "";

  async post(path: string, body: unknown): Promise<{ status: number; body: any }> {
    const response = await fetch(`${server.shellOrigin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";")[0] ?? "";
      if (pair.startsWith("av=")) this.cookie = pair;
    }
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  call(id: string, body: Record<string, unknown>) {
    return this.post(`/api/frame/db/${id}/call`, body);
  }

  /** The viewer id inside the signed cookie, as the store sees it. */
  get viewerId(): string {
    return decodeURIComponent(this.cookie.slice(3)).split(".")[0] as string;
  }
}

async function createArtifact(capabilities: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ html: HTML, capabilities }),
  });
  const body = (await response.json()) as { id: string };
  return body.id;
}

/** Longer than the lane's PUSH_COALESCE_MS, so an armed push has landed. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/** A lane client that queues what the server pushes. */
class Lane {
  private readonly queue: any[] = [];
  private waiting: ((value: any) => void) | null = null;
  readonly socket: WebSocket;

  constructor(artifactId: string, cookie: string, origin?: string) {
    this.socket = new WebSocket(
      `ws://127.0.0.1:${server.shellPort}/api/frame/db/ws?artifact=${artifactId}`,
      { headers: { cookie }, ...(origin ? { origin } : {}) },
    );
    this.socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      const resolve = this.waiting;
      this.waiting = null;
      if (resolve) resolve(message);
      else this.queue.push(message);
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.on("open", () => resolve());
      this.socket.on("error", reject);
    });
  }

  next(): Promise<any> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "db-server-"));
  server = await startServer({
    shellPort: 0,
    framePort: 0,
    dataDir,
    openAdminApi: true,
    versionPollMs: 0,
  });
});

afterAll(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the call endpoint", () => {
  it("writes, reads and queries as the cookie's viewer", async () => {
    const id = await createArtifact({ db: {} });
    const viewer = new Client();

    expect((await viewer.call(id, { verb: "set", path: "tasks/t1", body: { title: "one" } })).status).toBe(200);
    const read = await viewer.call(id, { verb: "get", path: "tasks/t1" });
    expect(read.body).toEqual({ id: "t1", exists: true, data: { title: "one" } });

    const missing = await viewer.call(id, { verb: "get", path: "tasks/none" });
    expect(missing.body).toEqual({ id: "none", exists: false });

    await viewer.call(id, { verb: "set", path: "tasks/t2", body: { title: "two", n: 2 } });
    const query = await viewer.call(id, {
      verb: "query",
      spec: { collection: "tasks", orderBy: { f: "title", dir: "desc" }, limit: 1 },
    });
    expect(query.body.docs).toEqual([{ id: "t2", data: { title: "two", n: 2 } }]);
  });

  it("refuses bad paths, bad bodies and unknown verbs with invalid_argument", async () => {
    const id = await createArtifact({ db: {} });
    const viewer = new Client();
    for (const call of [
      { verb: "set", path: "tasks", body: {} },
      { verb: "set", path: "tasks/t1", body: [1, 2] },
      { verb: "get", path: "tasks/../secrets/x" },
      { verb: "update", path: "tasks/ghost", body: { a: 1 } },
      { verb: "explode", path: "tasks/t1" },
    ]) {
      const result = await viewer.call(id, call);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe("invalid_argument");
    }
  });

  it("refuses an artifact that does not declare db", async () => {
    const id = await createArtifact({ artifact: {} });
    const result = await new Client().call(id, { verb: "get", path: "tasks/t1" });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("revoked");
  });

  it("keeps data/users private per viewer and resolves `me`", async () => {
    const id = await createArtifact({ db: {} });
    const alice = new Client();
    const bob = new Client();
    await alice.call(id, { verb: "set", path: "data/users/me/profile", body: { note: "alpha" } });
    await bob.call(id, { verb: "set", path: "data/users/me/profile", body: { note: "bravo" } });

    // `me` is each viewer's own subtree: same path string, two documents.
    expect((await alice.call(id, { verb: "get", path: "data/users/me/profile" })).body.data).toEqual({
      note: "alpha",
    });
    expect((await bob.call(id, { verb: "get", path: "data/users/me/profile" })).body.data).toEqual({
      note: "bravo",
    });

    // A sibling's subtree reads as a document that does not exist...
    const peek = await bob.call(id, { verb: "get", path: `data/users/${alice.viewerId}/profile` });
    expect(peek.body).toEqual({ id: "profile", exists: false });
    // ...and a write into it is invalid_argument, never a permission code.
    const poke = await bob.call(id, {
      verb: "set",
      path: `data/users/${alice.viewerId}/profile`,
      body: { note: "intruder" },
    });
    expect(poke.body.code).toBe("invalid_argument");
    expect((await alice.call(id, { verb: "get", path: "data/users/me/profile" })).body.data).toEqual({
      note: "alpha",
    });

    // A query over a sibling's collection sees nothing.
    const query = await bob.call(id, {
      verb: "query",
      spec: { collection: `data/users/${alice.viewerId}` },
    });
    expect(query.body.docs).toEqual([]);
  });

  it("honours declared levels", async () => {
    const id = await createArtifact({
      db: { config: { rules: [{ path: "", read: "view", write: "admin" }] } },
    });
    const viewer = new Client();
    const refused = await viewer.call(id, { verb: "set", path: "tasks/t1", body: { a: 1 } });
    expect(refused.body.code).toBe("invalid_argument");
    expect(refused.body.message).toMatch(/admin sharing level/);
    // Reading is still allowed at `view`.
    expect((await viewer.call(id, { verb: "get", path: "tasks/t1" })).body.exists).toBe(false);
  });

  it("clamps a lease ttl and refuses a second holder", async () => {
    const id = await createArtifact({ db: {} });
    const viewer = new Client();
    const first = await viewer.call(id, {
      verb: "acquire",
      path: "locks/turn",
      options: { holder: "tab-1", ttlMs: 10 },
    });
    expect(first.body.acquired).toBe(true);
    expect(Date.parse(first.body.expiresAt) - Date.now()).toBeGreaterThan(500);
    const second = await viewer.call(id, {
      verb: "acquire",
      path: "locks/turn",
      options: { holder: "tab-2" },
    });
    expect(second.body).toEqual({ acquired: false, expiresAt: expect.any(String) });
  });
});

describe("a rule declaration that does not compile", () => {
  /** The declaration from the finding: a locked-down root plus one typo. */
  const oneTypo = {
    rules: [
      { path: "", read: "view", write: "owner" },
      { path: "bad path!", read: "view" },
    ],
  };

  async function create(capabilities: Record<string, unknown>) {
    const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html: HTML, capabilities }),
    });
    return { status: response.status, body: (await response.json()) as any };
  }

  it("is refused at POST /api/artifacts, naming the rule", async () => {
    const refused = await create({ db: { config: oneTypo } });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("invalid_content");
    expect(refused.body.message).toMatch(/db: rule 1: "bad path!" is not a rule path/);

    // A `rules` that is present but is not a list of rules is refused too:
    // double-encoding leaves a JSON string there, which used to read as "no
    // declaration" and run the permissive defaults.
    for (const rules of ['[{"path":"","read":"view","write":"owner"}]', { 0: { path: "" } }]) {
      const encoded = await create({ db: { config: { rules } } });
      expect(encoded.status).toBe(400);
      expect(encoded.body.message).toMatch(/db: rules must be an array of rule objects/);
    }
    const noLevel = await create({ db: { config: { rules: [{ path: "", raed: "owner" }] } } });
    expect(noLevel.status).toBe(400);
    expect(noLevel.body.message).toMatch(/db: rule 0: a rule must set read, write, or both/);

    // A declared-but-configless db is untouched by any of this.
    const plain = await create({ db: {} });
    expect(plain.status).toBe(200);
    const anyone = new Client();
    expect(
      (await anyone.call(plain.body.id, { verb: "set", path: "t/1", body: { a: 1 } })).status,
    ).toBe(200);

    // The same declaration without the typo is still published and still runs.
    const accepted = await create({
      db: { config: { rules: [{ path: "", read: "view", write: "owner" }] } },
    });
    expect(accepted.status).toBe(200);
    const viewer = new Client();
    const write = await viewer.call(accepted.body.id, {
      verb: "set",
      path: "t/1",
      body: { a: 1 },
    });
    expect(write.status).toBe(400);
    expect(write.body.message).toMatch(/owner sharing level/);
    expect((await viewer.call(accepted.body.id, { verb: "get", path: "t/1" })).body.exists).toBe(
      false,
    );
  });

  it("refuses a misspelled rules key, but not a bag the spine owns", async () => {
    // `rulez` is a whole declaration with one keystroke wrong. It used to
    // read as "nothing declared", so the store the author locked to `owner`
    // published clean and took anonymous writes.
    const misspelled = await create({ db: { rulez: [{ path: "", write: "owner" }] } });
    expect(misspelled.status).toBe(400);
    expect(misspelled.body.message).toMatch(/db: unknown db config key "rulez"/);

    // A declaration with no config, and one carrying only spine keys, both
    // still publish and still run the defaults.
    for (const capabilities of [{ db: {} }, { db: { optional: true } }]) {
      const plain = await create(capabilities);
      expect(plain.status).toBe(200);
      const anyone = new Client();
      expect(
        (await anyone.call(plain.body.id, { verb: "set", path: "t/1", body: { a: 1 } })).status,
      ).toBe(200);
    }
  });

  it("publishes a {self} rule that sets no level", async () => {
    // "This prefix is private per viewer, levels unchanged" - the shape the
    // platform's own `data/users/{self}` is written in.
    const created = await create({ db: { rules: [{ path: "votes/{self}" }] } });
    expect(created.status).toBe(200);
    const id = created.body.id as string;
    const alice = new Client();
    const bob = new Client();
    // Shared paths are still on the defaults, and the first call is what
    // hands each client its viewer cookie.
    expect((await alice.call(id, { verb: "set", path: "t/1", body: { a: 1 } })).status).toBe(200);
    expect((await bob.call(id, { verb: "get", path: "t/1" })).body.exists).toBe(true);

    expect((await alice.call(id, { verb: "set", path: "votes/me", body: { a: 1 } })).status).toBe(
      200,
    );
    expect((await alice.call(id, { verb: "get", path: `votes/${alice.viewerId}` })).body.data)
      .toEqual({ a: 1 });
    // ...and each viewer's subtree under it is private.
    expect((await bob.call(id, { verb: "get", path: `votes/${alice.viewerId}` })).body.exists)
      .toBe(false);
  });

  it("closes the store when one is already stored, and warns once", async () => {
    // Published before the check existed (or written straight to disk): the
    // view must close, not fall back to the permissive defaults.
    const owner = "u_" + "c".repeat(22);
    const meta = await server.context.store.createArtifact({
      html: HTML,
      capabilities: { db: { config: oneTypo } },
      owner,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const viewer = new Client();
      const write = await viewer.call(meta.id, { verb: "set", path: "t/1", body: { a: 1 } });
      expect(write.status).toBe(400);
      expect(write.body.code).toBe("invalid_argument");
      expect((await viewer.call(meta.id, { verb: "get", path: "t/1" })).body).toEqual({
        id: "1",
        exists: false,
      });
      expect((await viewer.call(meta.id, { verb: "query", spec: { collection: "t" } })).body.docs)
        .toEqual([]);

      // One warning for this artifact, however many calls land on it.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(meta.id);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/is not a rule path/);
    } finally {
      warn.mockRestore();
    }

    // The owner still reaches the store, so a bad declaration is repairable.
    const sealed = encodeURIComponent(server.context.auth.seal(owner));
    const asOwner = (body: unknown) =>
      fetch(`${server.shellOrigin}/api/frame/db/${meta.id}/call`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `av=${sealed}; ao=${sealed}` },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
    expect((await asOwner({ verb: "set", path: "t/1", body: { a: 1 } })).status).toBe(200);
    expect((await asOwner({ verb: "get", path: "t/1" })).body.data).toEqual({ a: 1 });
  });

  it("closes a stored declaration whose rules are not a list either", async () => {
    // The reviewer's repro: `rules` double-encoded to a JSON string. It read
    // as "no declaration", so an anonymous `set` on a store the author had
    // locked to `owner` came back 200.
    const meta = await server.context.store.createArtifact({
      html: HTML,
      capabilities: { db: { config: { rules: '[{"path":"","read":"view","write":"owner"}]' } } },
      owner: "u_" + "d".repeat(22),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const viewer = new Client();
      const write = await viewer.call(meta.id, { verb: "set", path: "t/1", body: { a: 1 } });
      expect(write.status).toBe(400);
      expect(write.body.code).toBe("invalid_argument");
      expect((await viewer.call(meta.id, { verb: "get", path: "t/1" })).body.exists).toBe(false);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/rules must be an array of rule objects/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the realtime lane", () => {
  it("delivers rows on subscribe and on another viewer's write", async () => {
    const id = await createArtifact({ db: {} });
    const alice = new Client();
    const bob = new Client();
    await alice.call(id, { verb: "set", path: "tasks/t1", body: { title: "one" } });
    // A write arms a PUSH_COALESCE_MS timer whether or not anything is
    // subscribed yet; let this one fire before the subscription exists, or
    // it delivers the seed snapshot a second time and the next assertion
    // reads that repeat as the answer to alice's next write.
    await settle();
    // Give bob a cookie before the lane handshake needs it.
    await bob.call(id, { verb: "get", path: "tasks/t1" });

    const granted = await bob.post(`/api/frame/db/${id}/subscribe`, {
      subId: "s1",
      spec: { collection: "tasks", orderBy: { f: "title" } },
    });
    expect(granted.status).toBe(200);
    expect(typeof granted.body.grant).toBe("string");

    const lane = new Lane(id, bob.cookie);
    await lane.open();
    lane.send({ kind: "sub", subId: "s1", grant: granted.body.grant });

    const first = await lane.next();
    expect(first).toEqual({
      kind: "rows",
      subId: "s1",
      docs: [{ id: "t1", data: { title: "one" } }],
    });

    await alice.call(id, { verb: "set", path: "tasks/t2", body: { title: "two" } });
    const second = await lane.next();
    expect(second.kind).toBe("rows");
    expect(second.docs.map((d: { id: string }) => d.id)).toEqual(["t1", "t2"]);

    await alice.call(id, { verb: "delete", path: "tasks/t1" });
    const third = await lane.next();
    expect(third.docs.map((d: { id: string }) => d.id)).toEqual(["t2"]);

    lane.close();
  });

  it("subscribes to one document and follows it", async () => {
    const id = await createArtifact({ db: {} });
    const viewer = new Client();
    await viewer.call(id, { verb: "get", path: "notes/n1" });
    const granted = await viewer.post(`/api/frame/db/${id}/subscribe`, {
      subId: "d1",
      spec: { path: "notes/n1" },
    });
    const lane = new Lane(id, viewer.cookie);
    await lane.open();
    lane.send({ kind: "sub", subId: "d1", grant: granted.body.grant });
    expect(await lane.next()).toEqual({ kind: "rows", subId: "d1", docs: [] });

    await viewer.call(id, { verb: "set", path: "notes/n1", body: { text: "hi" } });
    expect(await lane.next()).toEqual({
      kind: "rows",
      subId: "d1",
      docs: [{ id: "n1", data: { text: "hi" } }],
    });
    lane.close();
  });

  it("refuses another viewer's grant", async () => {
    const id = await createArtifact({ db: {} });
    const alice = new Client();
    const bob = new Client();
    await alice.call(id, { verb: "get", path: "tasks/t1" });
    await bob.call(id, { verb: "get", path: "tasks/t1" });
    const granted = await alice.post(`/api/frame/db/${id}/subscribe`, {
      subId: "s1",
      spec: { collection: "tasks" },
    });

    const lane = new Lane(id, bob.cookie);
    await lane.open();
    lane.send({ kind: "sub", subId: "s1", grant: granted.body.grant });
    expect(await lane.next()).toEqual({
      kind: "error",
      subId: "s1",
      code: "invalid_argument",
      message: expect.any(String),
    });
    lane.close();
  });

  it("binds a grant to the subscription id it was minted for", async () => {
    const id = await createArtifact({ db: {} });
    const viewer = new Client();
    await viewer.call(id, { verb: "get", path: "tasks/t1" });
    const granted = await viewer.post(`/api/frame/db/${id}/subscribe`, {
      subId: "s1",
      spec: { collection: "tasks" },
    });

    const lane = new Lane(id, viewer.cookie);
    await lane.open();
    // One grant, a second subscription id: replaying it buys nothing.
    lane.send({ kind: "sub", subId: "s2", grant: granted.body.grant });
    expect(await lane.next()).toMatchObject({ subId: "s2", kind: "error", code: "invalid_argument" });
    lane.send({ kind: "sub", subId: "s1", grant: granted.body.grant });
    expect((await lane.next()).kind).toBe("rows");
    lane.close();
  });

  it("needs a subscription id to mint a grant at all", async () => {
    const id = await createArtifact({ db: {} });
    const refused = await new Client().post(`/api/frame/db/${id}/subscribe`, {
      spec: { collection: "tasks" },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("invalid_argument");
  });

  it("refuses a lane opened from the frame origin", async () => {
    const id = await createArtifact({ db: {} });
    const viewer = new Client();
    await viewer.call(id, { verb: "get", path: "tasks/t1" });
    const lane = new Lane(id, viewer.cookie, server.frameOriginFor(id));
    await expect(lane.open()).rejects.toThrow();
  });

  it("stops the subscription when the artifact stops declaring db", async () => {
    const id = await createArtifact({ db: {} });
    const viewer = new Client();
    await viewer.call(id, { verb: "set", path: "tasks/t1", body: { title: "one" } });
    const granted = await viewer.post(`/api/frame/db/${id}/subscribe`, {
      subId: "s1",
      spec: { collection: "tasks" },
    });
    const lane = new Lane(id, viewer.cookie);
    await lane.open();
    lane.send({ kind: "sub", subId: "s1", grant: granted.body.grant });
    expect((await lane.next()).kind).toBe("rows");

    // The artifact is republished without the capability.
    const meta = await server.context.store.readMeta(id);
    await writeFile(
      join(dataDir, "artifacts", id, "meta.json"),
      JSON.stringify({ ...meta, capabilities: {} }),
    );

    // Calls refuse, and the next thing the lane does reports the withdrawal.
    expect((await viewer.call(id, { verb: "get", path: "tasks/t1" })).body.code).toBe("revoked");
    lane.send({ kind: "sub", subId: "s1", grant: granted.body.grant });
    expect(await lane.next()).toEqual({ kind: "revoked" });
    lane.close();
  });
});
