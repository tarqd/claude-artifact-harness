/**
 * The backend: one in-memory room per artifact over a real websocket lane on
 * a real (ephemeral-port) server. Two lane clients stand in for two open
 * documents, so presence, event echo, the topic backstop and departure are
 * asserted on the wire rather than in a mock.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer, type RunningServer } from "../../src/server/index.ts";
import { mintPeerId } from "../../src/capabilities/room/protocol.ts";

const OWNER_TOKEN = "room-unit-owner";
let server: RunningServer;
let dataDir: string;

async function createArtifact(capabilities: unknown): Promise<string> {
  const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify({ html: "<p>room</p>", capabilities }),
  });
  const body = (await response.json()) as { id: string };
  return body.id;
}

/** A lane client: one open document of an artifact, as the shell would open it. */
interface LaneOptions {
  owner?: boolean;
  /** `null` sends no `Origin` header at all. */
  origin?: string | null;
  /** Present this peer id instead of a freshly minted one. */
  peer?: string;
  /** Open the lane against the frame listener instead of the shell's. */
  port?: number;
}

class Lane {
  readonly peer: string;
  readonly received: Array<Record<string, unknown>> = [];
  private readonly socket: WebSocket;

  constructor(artifactId: string, viewerId: string | null, options: LaneOptions = {}) {
    this.peer = options.peer ?? mintPeerId();
    const origin = options.origin === undefined ? server.shellOrigin : options.origin;
    const base = new URL(server.shellOrigin);
    base.protocol = "ws:";
    if (options.port !== undefined) base.port = String(options.port);
    const headers: Record<string, string> = {};
    if (origin !== null) headers.origin = origin;
    if (viewerId !== null) {
      const sealed = encodeURIComponent(server.context.auth.seal(viewerId));
      // The owner cookie is bound to the owner token in force, so it is
      // minted the way `Auth.login` mints it, not from the viewer id alone.
      const owner = encodeURIComponent(server.context.auth.sealOwnerCookie(viewerId) ?? "");
      // Names as well as values come from the accessors: they change with the
      // scheme (`__Host-` under https), so hardcoding them would send cookies
      // the lane no longer reads the moment this suite is pointed at tls.
      const viewerName = server.context.auth.viewerCookieName();
      const ownerName = server.context.auth.ownerCookieName();
      headers.cookie = options.owner
        ? `${viewerName}=${sealed}; ${ownerName}=${owner}`
        : `${viewerName}=${sealed}`;
    }
    this.socket = new WebSocket(
      `${base.origin}/api/frame/room/ws?artifact=${artifactId}&peer=${this.peer}`,
      { headers },
    );
    this.socket.on("message", (raw) => {
      this.received.push(JSON.parse(String(raw)) as Record<string, unknown>);
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState === WebSocket.OPEN) return resolve();
      this.socket.once("open", () => resolve());
      this.socket.once("error", reject);
      this.socket.once("close", () => reject(new Error("the lane was refused")));
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }

  /** Resolves once the server has closed this lane. */
  closed(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) return resolve();
      this.socket.once("close", () => resolve());
    });
  }

  of(kind: string): Array<Record<string, unknown>> {
    return this.received.filter((m) => m.kind === kind);
  }

  /** Wait until `predicate` holds, or fail the test with what did arrive. */
  async until(predicate: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`${what}; saw ${JSON.stringify(this.received)}`);
  }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "room-unit-"));
  server = await startServer({ shellPort: 0, framePort: 0, dataDir, ownerToken: OWNER_TOKEN });
});

afterAll(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the room lane", () => {
  it("welcomes a peer with the id the shell minted", async () => {
    const id = await createArtifact({ room: { config: {} } });
    const lane = new Lane(id, "u_aaaaaaaaaaaaaaaaaaaaaa");
    await lane.open();
    await lane.until(() => lane.of("welcome").length === 1, "no welcome");
    expect(lane.of("welcome")[0]!.peer).toBe(lane.peer);
    lane.close();
  });

  it("tells an artifact that does not declare room it was never granted", async () => {
    const id = await createArtifact({ db: {} });
    const lane = new Lane(id, "u_aaaaaaaaaaaaaaaaaaaaaa");
    await lane.open();
    // The upgrade completes only to deliver the terminal code: the frame's
    // `not_granted` path, not an endless reconnect.
    await lane.until(() => lane.of("revoked").length === 1, "no terminal event");
    expect(lane.of("revoked")[0]).toEqual({ kind: "revoked", code: "not_granted" });
    await lane.closed();
  });

  it("refuses an upgrade from another origin, or with none at all", async () => {
    const id = await createArtifact({ room: { config: {} } });
    const foreign = new Lane(id, "u_aaaaaaaaaaaaaaaaaaaaaa", { origin: "http://evil.test" });
    await expect(foreign.open()).rejects.toThrow();
    const bare = new Lane(id, "u_aaaaaaaaaaaaaaaaaaaaaa", { origin: null });
    await expect(bare.open()).rejects.toThrow();
  });

  it("refuses an upgrade that carries no viewer cookie", async () => {
    const id = await createArtifact({ room: { config: {} } });
    const lane = new Lane(id, null);
    await expect(lane.open()).rejects.toThrow();
  });

  it("refuses the lane on the frame listener, cookie and origin or not", async () => {
    const id = await createArtifact({ room: { config: {} } });
    const lane = new Lane(id, "u_aaaaaaaaaaaaaaaaaaaaaa", { port: server.framePort });
    await expect(lane.open()).rejects.toThrow();
  });

  it("refuses a peer id another viewer is holding, and keeps the incumbent", async () => {
    const id = await createArtifact({ room: { config: { topics: { reaction: "interact" } } } });
    const victim = new Lane(id, "u_pppppppppppppppppppppp");
    const bystander = new Lane(id, "u_qqqqqqqqqqqqqqqqqqqqqq");
    await Promise.all([victim.open(), bystander.open()]);

    const thief = new Lane(id, "u_rrrrrrrrrrrrrrrrrrrrrr", { peer: victim.peer });
    await expect(thief.open()).rejects.toThrow();

    // The victim is still here and still the only one who can speak as itself.
    victim.send({ kind: "emit", topic: "reaction", d: { mine: true } });
    await bystander.until(() => bystander.of("event").length === 1, "the victim was evicted");
    expect(bystander.of("event")[0]).toMatchObject({ peer: victim.peer, d: { mine: true } });
    expect(bystander.of("gone")).toHaveLength(0);
    victim.close();
    bystander.close();
  });

  it("lets the same viewer reconnect on its own peer id", async () => {
    const id = await createArtifact({ room: { config: {} } });
    const first = new Lane(id, "u_ssssssssssssssssssssss");
    await first.open();
    const again = new Lane(id, "u_ssssssssssssssssssssss", { peer: first.peer });
    await again.open();
    await again.until(() => again.of("welcome").length === 1, "no welcome for the reconnect");
    await first.closed();
    first.close();
    again.close();
  });

  it("refuses a malformed artifact or peer id", async () => {
    const id = await createArtifact({ room: {} });
    const base = server.shellOrigin.replace(/^http/, "ws");
    // A credential and the right origin: only the peer id can be the reason.
    const sealed = encodeURIComponent(server.context.auth.seal("u_aaaaaaaaaaaaaaaaaaaaaa"));
    const bad = new WebSocket(`${base}/api/frame/room/ws?artifact=${id}&peer=NOPE`, {
      headers: { origin: server.shellOrigin, cookie: `av=${sealed}` },
    });
    await expect(
      new Promise((resolve, reject) => {
        bad.once("open", resolve);
        bad.once("error", reject);
        bad.once("close", () => reject(new Error("refused")));
      }),
    ).rejects.toThrow();
  });

  it("broadcasts presence to everyone else, never back to the sender", async () => {
    const id = await createArtifact({ room: { config: {} } });
    const a = new Lane(id, "u_aaaaaaaaaaaaaaaaaaaaaa");
    const b = new Lane(id, "u_bbbbbbbbbbbbbbbbbbbbbb");
    await Promise.all([a.open(), b.open()]);

    a.send({ kind: "presence", p: { who: "ada", cursor: { x: 0.42 } } });
    await b.until(() => b.of("presence").length === 1, "b saw no presence");
    expect(b.of("presence")[0]).toEqual({
      kind: "presence",
      peer: a.peer,
      p: { who: "ada", cursor: { x: 0.42 } },
      isMe: false,
    });
    expect(a.of("presence")).toHaveLength(0);
    a.close();
    b.close();
  });

  it("marks another tab of the same viewer as isMe", async () => {
    const id = await createArtifact({ room: { config: {} } });
    const a = new Lane(id, "u_cccccccccccccccccccccc");
    const b = new Lane(id, "u_cccccccccccccccccccccc");
    await Promise.all([a.open(), b.open()]);
    a.send({ kind: "presence", p: { who: "ada" } });
    await b.until(() => b.of("presence").length === 1, "b saw no presence");
    expect(b.of("presence")[0]!.isMe).toBe(true);
    a.close();
    b.close();
  });

  it("never marks two different viewers as each other", async () => {
    const id = await createArtifact({ room: { config: {} } });
    const a = new Lane(id, "u_oooooooooooooooooooooo");
    const b = new Lane(id, "u_ooooooooooooooooooooop");
    await Promise.all([a.open(), b.open()]);
    a.send({ kind: "presence", p: {} });
    await b.until(() => b.of("presence").length === 1, "b saw no presence");
    expect(b.of("presence")[0]!.isMe).toBe(false);
    a.close();
    b.close();
  });

  it("drops presence and moments over the artifact's own byte cap", async () => {
    const id = await createArtifact({ room: { config: { topics: { reaction: "interact" } } } });
    const a = new Lane(id, "u_tttttttttttttttttttttt");
    const b = new Lane(id, "u_uuuuuuuuuuuuuuuuuuuuuu");
    await Promise.all([a.open(), b.open()]);

    a.send({ kind: "presence", p: { big: "x".repeat(5000) } });
    a.send({ kind: "emit", topic: "reaction", d: { big: "x".repeat(5000) } });
    a.send({ kind: "presence", p: { who: "ada" } });
    await b.until(() => b.of("presence").length === 1, "b saw no presence");
    // Only the small object crossed; the oversized pair never did.
    expect(b.of("presence")[0]!.p).toEqual({ who: "ada" });
    expect(b.of("event")).toHaveLength(0);
    a.close();
    b.close();
  });

  it("echoes an event to the sender with sameTab, and to everyone else without", async () => {
    const id = await createArtifact({ room: { config: { topics: { reaction: "interact" } } } });
    const a = new Lane(id, "u_dddddddddddddddddddddd");
    const b = new Lane(id, "u_eeeeeeeeeeeeeeeeeeeeee");
    await Promise.all([a.open(), b.open()]);

    a.send({ kind: "emit", topic: "reaction", d: { kind: "wave" } });
    await a.until(() => a.of("event").length === 1, "a saw no echo");
    await b.until(() => b.of("event").length === 1, "b saw no event");
    expect(a.of("event")[0]).toEqual({
      kind: "event",
      peer: a.peer,
      topic: "reaction",
      d: { kind: "wave" },
      isMe: true,
      sameTab: true,
    });
    expect(b.of("event")[0]).toMatchObject({ peer: a.peer, isMe: false, sameTab: false });
    a.close();
    b.close();
  });

  it("drops a moment the sender's level does not open, as a backstop", async () => {
    const id = await createArtifact({ room: { config: { topics: { reaction: "interact" } } } });
    const a = new Lane(id, "u_ffffffffffffffffffffff");
    const b = new Lane(id, "u_gggggggggggggggggggggg");
    await Promise.all([a.open(), b.open()]);

    a.send({ kind: "emit", topic: "clear", d: 1 });
    a.send({ kind: "emit", topic: "reaction", d: 2 });
    await b.until(() => b.of("event").length === 1, "b saw no event");
    // Only the permitted moment arrived, and it arrived second.
    expect(b.of("event").map((e) => e.topic)).toEqual(["reaction"]);
    a.close();
    b.close();
  });

  it("tells the room when a document leaves", async () => {
    const id = await createArtifact({ room: { config: {} } });
    const a = new Lane(id, "u_hhhhhhhhhhhhhhhhhhhhhh");
    const b = new Lane(id, "u_iiiiiiiiiiiiiiiiiiiiii");
    await Promise.all([a.open(), b.open()]);
    a.close();
    await b.until(() => b.of("gone").length === 1, "b never heard the departure");
    expect(b.of("gone")[0]!.peer).toBe(a.peer);
    b.close();
  });

  it("answers a ping so a lane can prove it is alive", async () => {
    const id = await createArtifact({ room: { config: {} } });
    const a = new Lane(id, "u_jjjjjjjjjjjjjjjjjjjjjj");
    await a.open();
    a.send({ kind: "ping" });
    await a.until(() => a.of("pong").length === 1, "no pong");
    a.close();
  });

  it("reads the owner cookie, so the lane agrees with the level the shell told the page", async () => {
    const id = await createArtifact({ room: { config: { topics: { reaction: "interact" } } } });
    const owner = new Lane(id, "u_mmmmmmmmmmmmmmmmmmmmmm", { owner: true });
    const guest = new Lane(id, "u_nnnnnnnnnnnnnnnnnnnnnn");
    await Promise.all([owner.open(), guest.open()]);

    owner.send({ kind: "emit", topic: "clear", d: { board: true } });
    await guest.until(() => guest.of("event").length === 1, "the admin moment never arrived");
    expect(guest.of("event")[0]!.topic).toBe("clear");

    // The same topic from a plain viewer is still dropped.
    guest.send({ kind: "emit", topic: "clear", d: 1 });
    guest.send({ kind: "emit", topic: "reaction", d: 2 });
    await owner.until(() => owner.of("event").length === 2, "no echo of the guest's moment");
    expect(owner.of("event").map((e) => e.topic)).toEqual(["clear", "reaction"]);
    owner.close();
    guest.close();
  });

  it("keeps two artifacts' rooms apart", async () => {
    const one = await createArtifact({ room: { config: { topics: { reaction: "interact" } } } });
    const two = await createArtifact({ room: { config: { topics: { reaction: "interact" } } } });
    const a = new Lane(one, "u_kkkkkkkkkkkkkkkkkkkkkk");
    const b = new Lane(two, "u_llllllllllllllllllllll");
    await Promise.all([a.open(), b.open()]);
    a.send({ kind: "presence", p: { who: "ada" } });
    a.send({ kind: "emit", topic: "reaction", d: 1 });
    await a.until(() => a.of("event").length === 1, "a saw no echo");
    expect(b.received.filter((m) => m.kind !== "welcome")).toEqual([]);
    a.close();
    b.close();
  });
});
