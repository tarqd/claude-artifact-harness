/**
 * The `user` backend over real sockets: the display-name store, the scope
 * gates, and the two privacy boundaries that matter — an artifact resolves
 * only its own peers, and only a writer may enumerate them.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../src/server/index.ts";
import { handle } from "../../src/capabilities/user/broker.ts";
import { MAX_PEERS, UserStore } from "../../src/capabilities/user/store.ts";
import { RateLimiter, scopesOf } from "../../src/capabilities/user/server.ts";
import type { ArtifactMeta } from "../../src/server/store.ts";
import type { BrokerCall, BrokerContext } from "../../src/shell/types.ts";

let server: RunningServer;
let dataDir: string;

const HTML = "<!doctype html><html><head><title>user</title></head><body>hi</body></html>";
const OWNER_TOKEN = "user-server-owner-token";

/** One browser: it keeps its viewer cookie, so two clients are two viewers. */
class Client {
  cookie = "";
  /** Boot asset tokens, per artifact this client has opened. */
  private readonly tokens = new Map<string, string>();

  private absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";")[0] ?? "";
      if (pair.startsWith("av=") || pair.startsWith("ao=")) {
        const name = pair.split("=")[0] as string;
        const kept = this.cookie
          .split("; ")
          .filter((c) => c && !c.startsWith(`${name}=`));
        kept.push(pair);
        this.cookie = kept.join("; ");
      }
    }
  }

  async get(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${server.shellOrigin}${path}`, {
      headers: { ...headers, ...(this.cookie ? { cookie: this.cookie } : {}) },
      redirect: "manual",
    });
    this.absorb(response);
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  }

  async post(
    path: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${server.shellOrigin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: JSON.stringify(payload),
    });
    this.absorb(response);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async login(): Promise<void> {
    await this.get(`/login?token=${OWNER_TOKEN}`);
  }

  async id(): Promise<string> {
    return (await this.get("/api/account")).body.account.id as string;
  }

  /**
   * What a browser does: render the shell page (which mints the viewer cookie
   * and the boot asset token), then let the broker call the account endpoint
   * with that token. Only this makes the viewer a peer of the artifact.
   */
  async open(artifactId: string): Promise<{ status: number; body: any }> {
    const page = await this.get(`/a/${artifactId}`);
    const found = /__frame_t=([A-Za-z0-9_.\-%]+)/.exec(String(page.body));
    if (found) this.tokens.set(artifactId, decodeURIComponent(found[1] as string));
    return this.get(`/api/account?slug=${artifactId}`, this.tokenFor(artifactId));
  }

  /** The header the broker sends; empty when this client never opened it. */
  tokenFor(artifactId: string): Record<string, string> {
    const token = this.tokens.get(artifactId);
    return token ? { "x-artifact-frame-token": token } : {};
  }
}

async function createArtifact(capabilities: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify({ html: HTML, capabilities }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "user-server-"));
  server = await startServer({
    shellPort: 0,
    framePort: 0,
    dataDir,
    ownerToken: OWNER_TOKEN,
  });
});

afterAll(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("scopesOf", () => {
  const meta = (user: unknown): ArtifactMeta =>
    ({ capabilities: { user } }) as unknown as ArtifactMeta;

  it("defaults to the profile scope", () => {
    expect(scopesOf(meta({}))).toEqual(["profile"]);
    expect(scopesOf(meta({ config: {} }))).toEqual(["profile"]);
  });

  it("reads both the declared and the forwarded spelling", () => {
    expect(scopesOf(meta({ config: { scopes: ["profile", "email"] } }))).toEqual([
      "profile",
      "email",
    ]);
    expect(scopesOf(meta({ scopes: ["email"] }))).toEqual(["profile", "email"]);
  });
});

describe("the account endpoint", () => {
  it("mints a viewer and answers with an unnamed profile", async () => {
    const client = new Client();
    const { status, body } = await client.get("/api/account");
    expect(status).toBe(200);
    expect(body.account).toMatchObject({ name: "", avatarUrl: null, email: null });
    expect(body.account.id).toMatch(/^u_[A-Za-z0-9_]{22}$/);
    // The same browser keeps the same identity.
    expect(await client.id()).toBe(body.account.id);
  });

  it("stores a display name for the current viewer only", async () => {
    const ada = new Client();
    const grace = new Client();
    await ada.id(); // a name is written only for a session that already exists
    await grace.id();
    await ada.post("/api/frame/user/profile", { name: "  Ada  Lovelace  " });
    await grace.post("/api/frame/user/profile", { name: "Grace Hopper" });

    expect((await ada.get("/api/account")).body.account.name).toBe("Ada Lovelace");
    expect((await grace.get("/api/account")).body.account.name).toBe("Grace Hopper");
  });

  it("refuses a name that is not a string", async () => {
    const client = new Client();
    await client.id();
    const { status, body } = await client.post("/api/frame/user/profile", { name: 7 });
    expect(status).toBe(400);
    expect(body.code).toBe("invalid_content");
  });

  it("refuses a slug that is not an artifact declaring user", async () => {
    const client = new Client();
    const plain = await createArtifact({ db: {} });
    expect((await client.get(`/api/account?slug=${plain}`)).status).toBe(403);
    expect((await client.get("/api/account?slug=nope")).status).toBe(400);
    expect(
      (await client.get("/api/account?slug=00000000000000000000000000000000")).status,
    ).toBe(404);
  });
});

describe("the directory", () => {
  it("resolves peers of the artifact and nobody else", async () => {
    const id = await createArtifact({ user: { config: { scopes: ["profile"] } } });
    const other = await createArtifact({ user: {} });

    const ada = new Client();
    const adaId = await ada.id();
    await ada.post("/api/frame/user/profile", { name: "Ada" });
    await ada.open(id); // opening the artifact is what makes her a peer

    const grace = new Client();
    const graceId = await grace.id();
    await grace.post("/api/frame/user/profile", { name: "Grace" });
    await grace.open(id);

    const stranger = new Client();
    const strangerId = await stranger.id();
    await stranger.post("/api/frame/user/profile", { name: "Alan" });
    await stranger.open(other); // a peer of the OTHER artifact

    const { status, body } = await grace.post(
      `/api/frame/user/profiles/${id}`,
      { ids: [adaId, strangerId, graceId] },
      grace.tokenFor(id),
    );
    expect(status).toBe(200);
    expect(Object.keys(body.profiles).sort()).toEqual([adaId, graceId].sort());
    expect(body.profiles[adaId]).toEqual({
      id: adaId,
      name: "Ada",
      avatarUrl: null,
      email: null,
    });
    // The stranger is invisible here even though the server knows the name.
    expect(body.profiles[strangerId]).toBeUndefined();
  });

  it("ignores malformed ids instead of failing the call", async () => {
    const id = await createArtifact({ user: {} });
    const client = new Client();
    await client.open(id);
    const { status, body } = await client.post(
      `/api/frame/user/profiles/${id}`,
      { ids: ["nope", 7, null] },
      client.tokenFor(id),
    );
    expect(status).toBe(200);
    expect(body.profiles).toEqual({});
  });

  it("lets a writer search the artifact's peers by name", async () => {
    const id = await createArtifact({ user: {} });
    const owner = new Client();
    await owner.login();
    await owner.post("/api/frame/user/profile", { name: "Ada Lovelace" });
    await owner.open(id);

    const found = await owner.post(`/api/frame/user/search/${id}`, { q: "ada" });
    expect(found.status).toBe(200);
    expect(found.body.profiles.map((p: { name: string }) => p.name)).toEqual(["Ada Lovelace"]);

    const empty = await owner.post(`/api/frame/user/search/${id}`, { q: "zzz" });
    expect(empty.body.profiles).toEqual([]);
    const blank = await owner.post(`/api/frame/user/search/${id}`, { q: "   " });
    expect(blank.body.profiles).toEqual([]);
  });

  it("refuses a search from a reader", async () => {
    const id = await createArtifact({ user: {} });
    const reader = new Client();
    await reader.open(id);
    const { status, body } = await reader.post(`/api/frame/user/search/${id}`, { q: "ada" });
    expect(status).toBe(403);
    expect(body.code).toBe("not_granted");
  });

  it("refuses every endpoint on an artifact that does not declare user", async () => {
    const id = await createArtifact({ db: {} });
    const client = new Client();
    for (const path of [
      `/api/frame/user/profiles/${id}`,
      `/api/frame/user/search/${id}`,
      `/api/frame/user/email/${id}`,
    ]) {
      const { status, body } = await client.post(path, { ids: [], q: "a" });
      expect(status).toBe(403);
      expect(body.code).toBe("capability_disabled");
    }
  });
});

describe("the write gate", () => {
  it("refuses every write from a client with no session", async () => {
    const id = await createArtifact({ user: {} });
    const bare = new Client();
    const named = await bare.post("/api/frame/user/profile", { name: "Anthropic Support" });
    expect(named.status).toBe(403);
    expect(named.body.code).toBe("not_granted");
    // The cookie the refusal did NOT mint: nothing was stored for anybody.
    expect(bare.cookie).toBe("");

    for (const path of [`/api/frame/user/profiles/${id}`, `/api/frame/user/search/${id}`]) {
      const { status, body } = await bare.post(path, { ids: [], q: "a" });
      expect(status).toBe(403);
      expect(body.code).toBe("not_granted");
    }
  });

  it("only lets a viewer join an artifact the shell rendered for them", async () => {
    const id = await createArtifact({ user: {} });
    const other = await createArtifact({ user: {} });
    const store = new UserStore(dataDir);

    // A session, but no boot token: reading the slug-scoped account does not
    // put this viewer in the artifact's directory.
    const drifter = new Client();
    const drifterId = await drifter.id();
    await drifter.get(`/api/account?slug=${id}`);
    expect(await store.isPeer(id, drifterId)).toBe(false);

    // A token minted for a different artifact does not join this one either.
    await drifter.open(other);
    await drifter.get(`/api/account?slug=${id}`, drifter.tokenFor(other));
    expect(await store.isPeer(id, drifterId)).toBe(false);
    expect(await store.isPeer(other, drifterId)).toBe(true);

    // Opening the artifact itself is what joins.
    await drifter.open(id);
    expect(await store.isPeer(id, drifterId)).toBe(true);
  });

  it("keeps a stranger's chosen name out of an artifact's search results", async () => {
    const id = await createArtifact({ user: {} });
    const owner = new Client();
    await owner.login();
    await owner.post("/api/frame/user/profile", { name: "Ada Lovelace" });
    await owner.open(id);

    // The stranger has a session and a name, but never opened this artifact.
    const stranger = new Client();
    await stranger.id();
    await stranger.post("/api/frame/user/profile", { name: "Anthropic Support" });
    await stranger.get(`/api/account?slug=${id}`);

    const found = await owner.post(`/api/frame/user/search/${id}`, { q: "support" });
    expect(found.body.profiles).toEqual([]);
  });
});

describe("body size limit", () => {
  it("refuses a profile write over the cap before it is parsed", async () => {
    const oversized = await new Client().post("/api/frame/user/profile", {
      name: "x".repeat(600 * 1024),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.body.code).toBe("too_large");
  });
});

describe("RateLimiter", () => {
  it("allows a burst up to the limit and refuses the rest of the window", () => {
    const limiter = new RateLimiter(3, 1000);
    const at = 10_000;
    expect([1, 2, 3, 4].map(() => limiter.allow("a", at))).toEqual([true, true, true, false]);
    // A different caller has its own budget, and the window reopens.
    expect(limiter.allow("b", at)).toBe(true);
    expect(limiter.allow("a", at + 1001)).toBe(true);
  });
});

describe("email", () => {
  it("needs the declared scope", async () => {
    const without = await createArtifact({ user: { config: { scopes: ["profile"] } } });
    const client = new Client();
    const denied = await client.post(`/api/frame/user/email/${without}`, {});
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("not_granted");
  });

  it("resolves null when the scope is declared (v0 stores no addresses)", async () => {
    const id = await createArtifact({ user: { config: { scopes: ["profile", "email"] } } });
    const client = new Client();
    await client.open(id);
    const { status, body } = await client.post(`/api/frame/user/email/${id}`, {});
    expect(status).toBe(200);
    expect(body).toEqual({ email: null });
  });
});

describe("the email verb end to end", () => {
  /** A broker context whose `api` is the shell's own backend, as the host builds it. */
  const brokerCtx = (artifactId: string, client: Client): BrokerContext => {
    const token = client.tokenFor(artifactId)["x-artifact-frame-token"] ?? "";
    return {
      boot: {
        artifactId,
        frameUrl: `http://frame.test/_f/v1/?__frame_t=${encodeURIComponent(token)}`,
      },
      api: async <T,>(path: string, init?: RequestInit): Promise<T> => {
        const response = await fetch(`${server.shellOrigin}${path}`, {
          ...(init ?? {}),
          headers: {
            "content-type": "application/json",
            ...((init?.headers as Record<string, string>) ?? {}),
            // The browser adds this; here the test client holds the cookie.
            cookie: client.cookie,
          },
        });
        const text = await response.text();
        const body: unknown = text ? JSON.parse(text) : null;
        if (!response.ok) throw body;
        return body as T;
      },
    } as unknown as BrokerContext;
  };

  const call = (method: string): BrokerCall => ({ cap: "user", id: "u1", method, args: [] });

  it("carries a declared scope all the way to the address (v0: null)", async () => {
    const id = await createArtifact({ user: { config: { scopes: ["profile", "email"] } } });
    const client = new Client();
    await client.open(id);
    await expect(handle(call("email"), brokerCtx(id, client))).resolves.toEqual({ email: null });
  });

  it("refuses the verb when the artifact never declared the scope", async () => {
    const id = await createArtifact({ user: {} });
    const client = new Client();
    await client.open(id);
    await expect(handle(call("email"), brokerCtx(id, client))).rejects.toMatchObject({
      code: "not_granted",
    });
  });

  it("never lets an address ride along on the profile verb", async () => {
    const id = await createArtifact({ user: { config: { scopes: ["profile", "email"] } } });
    const client = new Client();
    await client.open(id);
    const profile = (await handle(call("profile"), brokerCtx(id, client))) as {
      email: string | null;
    };
    expect(profile.email).toBeNull();
  });
});

describe("UserStore", () => {
  it("evicts the least recently seen peer, never the active one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "user-peers-"));
    try {
      const store = new UserStore(dir);
      const art = "0123456789abcdef0123456789abcdef";
      const owner = "u_ownerownerownerownerab";
      const peer = (n: number) => `u_${String(n).padStart(22, "0")}`;

      await store.touch(art, owner);
      for (let i = 0; i < MAX_PEERS + 100; i++) {
        await store.touch(art, peer(i));
        // The owner keeps using the page, so they stay the most recent.
        if (i % 100 === 0) await store.touch(art, owner);
      }
      const ids = await store.peers(art);
      expect(ids).toHaveLength(MAX_PEERS);
      expect(ids).toContain(owner);
      // The window kept the newest arrivals and dropped the coldest ones.
      expect(ids).toContain(peer(MAX_PEERS + 99));
      expect(ids).not.toContain(peer(0));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps names, peers and search out of each other's way", async () => {
    const dir = await mkdtemp(join(tmpdir(), "user-store-"));
    try {
      const store = new UserStore(dir);
      const a = "u_aaaaaaaaaaaaaaaaaaaaaa";
      const b = "u_bbbbbbbbbbbbbbbbbbbbbb";
      const art = "0123456789abcdef0123456789abcdef";

      expect(await store.profile(a)).toBeNull();
      await store.setName(a, "Ada");
      expect(await store.profile(a)).toMatchObject({ id: a, name: "Ada" });

      await store.touch(art, a);
      await store.touch(art, a); // idempotent
      await store.touch(art, "not-a-viewer");
      expect(await store.peers(art)).toEqual([a]);
      expect(await store.isPeer(art, b)).toBe(false);

      await store.setName(b, "Grace");
      expect(await store.resolve(art, b, [a, b])).toMatchObject([{ name: "Ada" }, { name: "Grace" }]);
      expect(await store.search(art, "gra")).toEqual([]); // b is not a peer yet
      await store.touch(art, b);
      expect(await store.search(art, "GRA")).toMatchObject([{ name: "Grace" }]);
      expect(await store.search(art, "")).toEqual([]);

      // A viewer who has never been named is not a search hit.
      const c = "u_cccccccccccccccccccccc";
      await store.touch(art, c);
      expect((await store.search(art, "c")).map((r) => r.id)).not.toContain(c);

      // Touching an existing peer moves them to the front of the queue.
      await store.touch(art, a);
      expect((await store.peers(art)).at(-1)).toBe(a);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
