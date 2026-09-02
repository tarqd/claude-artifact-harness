/**
 * The db backend over real sockets: the call endpoint, per-viewer privacy,
 * and the realtime lane one viewer's write reaches another viewer on.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  it("refuses a body over the cap before it is parsed, and never writes it", async () => {
    const id = await createArtifact({ db: {} });
    const viewer = new Client();
    const oversized = await viewer.call(id, {
      verb: "set",
      path: "tasks/big",
      body: { blob: "x".repeat(600 * 1024) },
    });
    expect(oversized.status).toBe(413);
    expect(oversized.body.code).toBe("too_large");
    // The handler never ran: nothing was written.
    const read = await viewer.call(id, { verb: "get", path: "tasks/big" });
    expect(read.body).toEqual({ id: "big", exists: false });
  });

  it("refuses a where value over the serialized size bound", async () => {
    const id = await createArtifact({ db: {} });
    const viewer = new Client();
    const result = await viewer.call(id, {
      verb: "query",
      spec: { collection: "tasks", where: [{ f: "title", op: "==", v: "x".repeat(5000) }] },
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("invalid_argument");
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

describe("the realtime lane", () => {
  it("delivers rows on subscribe and on another viewer's write", async () => {
    const id = await createArtifact({ db: {} });
    const alice = new Client();
    const bob = new Client();
    await alice.call(id, { verb: "set", path: "tasks/t1", body: { title: "one" } });
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
