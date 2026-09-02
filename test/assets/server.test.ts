/**
 * The `assets` backend over real sockets, on ephemeral ports and a temporary
 * DATA_DIR: the blob store's layout, the shell-origin write API and its gates,
 * the frame-origin read with its caching headers, and the boundary that
 * matters — one artifact's origin never serves another artifact's blob.
 */
import { readFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../src/server/index.ts";
import { BLOB_ID_RE } from "../../src/protocol/paths.ts";
import { BlobStore, routes } from "../../src/capabilities/assets/server.ts";
import type { FrameEnv, ServerApps, ServerContext } from "../../src/server/types.ts";
import type { AssetPage, AssetRecord } from "../../src/capabilities/assets/protocol.ts";

let server: RunningServer;
let dataDir: string;

const OWNER_TOKEN = "assets-server-owner-token";
const HTML = "<!doctype html><html><head><title>assets</title></head><body>hi</body></html>";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/**
 * One browser: it keeps its viewer cookie, so two clients are two viewers —
 * and it sends the `Origin`/`Sec-Fetch-Site` a browser sends on a same-origin
 * write, which is what `server/guards.ts` requires of anything carrying a
 * cookie. (Without them a `text/plain` upload is refused 415: a request that
 * says nothing about where it came from may not use a content type a forged
 * cross-site form could have sent.)
 */
class Client {
  cookie = "";

  private absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";")[0] ?? "";
      const name = pair.split("=")[0] ?? "";
      if (name !== "av" && name !== "ao") continue;
      const kept = this.cookie.split("; ").filter((c) => c && !c.startsWith(`${name}=`));
      kept.push(pair);
      this.cookie = kept.join("; ");
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const browser = { ...extra, origin: server.shellOrigin, "sec-fetch-site": "same-origin" };
    return this.cookie ? { ...browser, cookie: this.cookie } : browser;
  }

  async login(): Promise<void> {
    const response = await fetch(`${server.shellOrigin}/login?token=${OWNER_TOKEN}`, {
      headers: this.headers(),
      redirect: "manual",
    });
    this.absorb(response);
    expect(response.status).toBe(200);
  }

  async post(
    path: string,
    body?: BodyInit,
    contentType = "application/json",
  ): Promise<{ status: number; body: any }> {
    const init: RequestInit = {
      method: "POST",
      headers: this.headers({ "content-type": contentType }),
    };
    if (body !== undefined) init.body = body;
    const response = await fetch(`${server.shellOrigin}${path}`, init);
    this.absorb(response);
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  }
}

/** The frame origin, reached by the `/_a/<id>/` prefix form (no wildcard DNS). */
function blobUrlFor(artifactId: string, blobId: string): string {
  return `http://127.0.0.1:${server.framePort}/_a/${artifactId}/_blob/${blobId}`;
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

let owner: Client;
let artifact: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "assets-server-"));
  server = await startServer({
    shellPort: 0,
    framePort: 0,
    dataDir,
    ownerToken: OWNER_TOKEN,
    // The blob URLs below use the tooling prefix form (no wildcard DNS here).
    allowPrefixHosts: true,
  });
  owner = new Client();
  await owner.login();
  artifact = await createArtifact({ assets: {} });
});

afterAll(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function upload(
  client: Client,
  id: string,
  bytes: Buffer,
  type: string,
): Promise<{ status: number; body: any }> {
  return client.post(`/api/frame/blob/${id}/upload`, new Uint8Array(bytes), type);
}

describe("upload", () => {
  it("stores the bytes, a content-type sidecar and a usage record", async () => {
    const { status, body } = await upload(owner, artifact, PNG, "image/png");
    expect(status).toBe(200);
    const record = body as AssetRecord;
    expect(record.id).toMatch(BLOB_ID_RE);
    expect(record.url).toBe(`/_blob/${record.id}`);
    expect(record.type).toBe("image/png");
    expect(record.size).toBe(PNG.length);
    expect(Date.parse(record.createdAt)).toBeGreaterThan(0);

    const blobs = join(dataDir, "artifacts", artifact, "blobs");
    expect((await stat(join(blobs, record.id))).size).toBe(PNG.length);
    const sidecar = JSON.parse(await readFile(join(blobs, `${record.id}.json`), "utf8"));
    expect(sidecar.type).toBe("image/png");
    expect(sidecar.by).toMatch(/^u_/);
    const usage = JSON.parse(await readFile(join(blobs, "usage.json"), "utf8"));
    expect(usage).toMatchObject({ count: 1, bytes: PNG.length });

    // Clean up so the later counting tests start from a known state.
    await owner.post(`/api/frame/blob/${artifact}/${record.id}/delete`);
  });

  it("refuses a type outside the list", async () => {
    const bad = await upload(owner, artifact, Buffer.from("MZ"), "application/x-msdownload");
    expect(bad.status).toBe(415);
    expect(bad.body.code).toBe("unsupported_type");
  });

  it("stores an empty asset: §5.4 sets caps, not a minimum", async () => {
    const empty = await upload(owner, artifact, Buffer.alloc(0), "image/png");
    expect(empty.status).toBe(200);
    expect((empty.body as AssetRecord).size).toBe(0);

    const served = await fetch(blobUrlFor(artifact, (empty.body as AssetRecord).id));
    expect(served.status).toBe(200);
    expect((await served.arrayBuffer()).byteLength).toBe(0);
    await owner.post(`/api/frame/blob/${artifact}/${(empty.body as AssetRecord).id}/delete`);
  });

  it("refuses a body that crosses the cap without declaring its length", async () => {
    // A chunked upload with no `content-length`: the running byte cap has to
    // stop it, since there is nothing to check up front.
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 3 MiB against the 2 MiB SVG cap: the server must give up part way.
        if (sent >= 3 * 1024 * 1024) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const response = await fetch(`${server.shellOrigin}/api/frame/blob/${artifact}/upload`, {
      method: "POST",
      headers: { "content-type": "image/svg+xml", cookie: owner.cookie },
      body,
      // @ts-expect-error -- Node needs `duplex` for a streaming request body.
      duplex: "half",
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { code: string }).code).toBe("too_large");
  });

  it("holds an SVG to 2 MiB", async () => {
    const svg = Buffer.alloc(2 * 1024 * 1024 + 1, 0x20);
    const big = await upload(owner, artifact, svg, "image/svg+xml");
    expect(big.status).toBe(413);
    expect(big.body.code).toBe("too_large");

    // The same bytes as a PNG are under the 20 MiB cap and go through.
    const ok = await upload(owner, artifact, svg, "image/png");
    expect(ok.status).toBe(200);
    await owner.post(`/api/frame/blob/${artifact}/${ok.body.id}/delete`);
  });

  it("refuses a viewer who is not an admin or the owner", async () => {
    const stranger = new Client();
    const refused = await upload(stranger, artifact, PNG, "image/png");
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("upstream_error");
  });

  it("refuses an artifact that does not declare assets", async () => {
    const other = await createArtifact({ db: {} });
    const refused = await upload(owner, other, PNG, "image/png");
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("invalid_request");
  });

  it("refuses an artifact that does not exist", async () => {
    const refused = await upload(owner, "f".repeat(32), PNG, "image/png");
    expect(refused.status).toBe(404);
  });
});

describe("list", () => {
  it("returns the artifact's assets with its usage", async () => {
    const id = await createArtifact({ assets: {} });
    const first = (await upload(owner, id, Buffer.from("one"), "text/plain")).body as AssetRecord;
    const second = (await upload(owner, id, Buffer.from("two!"), "text/csv")).body as AssetRecord;

    const listed = (await owner.post(`/api/frame/blob/${id}/list`, "{}")).body as AssetPage;
    expect(listed.assets.map((a) => a.id)).toEqual([first.id, second.id]);
    expect(listed.usage).toEqual({ count: 2, bytes: 7 });
    expect(listed.next).toBeUndefined();
    // The ordering key is ours, not the page's.
    expect(listed.assets[0]).not.toHaveProperty("seq");
  });

  it("pages by an opaque cursor, in upload order even within one millisecond", async () => {
    const id = await createArtifact({ assets: {} });
    const uploaded: string[] = [];
    for (let i = 0; i < 101; i++) {
      const one = await upload(owner, id, Buffer.from(String(i % 10)), "text/plain");
      uploaded.push((one.body as AssetRecord).id);
    }

    const page = (await owner.post(`/api/frame/blob/${id}/list`, "{}")).body as AssetPage;
    expect(page.assets.map((a) => a.id)).toEqual(uploaded.slice(0, 100));
    expect(page.usage).toEqual({ count: 101, bytes: 101 });
    expect(typeof page.next).toBe("string");

    const rest = (
      await owner.post(`/api/frame/blob/${id}/list`, JSON.stringify({ after: page.next }))
    ).body as AssetPage;
    expect(rest.assets.map((a) => a.id)).toEqual(uploaded.slice(100));
    expect(rest.next).toBeUndefined();

    const past = (
      await owner.post(`/api/frame/blob/${id}/list`, JSON.stringify({ after: rest.next ?? "~" }))
    ).body as AssetPage;
    expect(past.assets).toEqual([]);
  });

  it("derives usage from the sidecars, correcting a stale record", async () => {
    const id = await createArtifact({ assets: {} });
    const record = (await upload(owner, id, PNG, "image/png")).body as AssetRecord;
    const usageFile = join(dataDir, "artifacts", id, "blobs", "usage.json");
    await writeFile(usageFile, JSON.stringify({ count: 99, bytes: 12345 }));

    const listed = (await owner.post(`/api/frame/blob/${id}/list`, "{}")).body as AssetPage;
    expect(listed.usage).toEqual({ count: 1, bytes: record.size });
    // The cache is corrected rather than trusted forever.
    expect(JSON.parse(await readFile(usageFile, "utf8"))).toMatchObject({
      count: 1,
      bytes: record.size,
    });
  });

  it("is readable by a viewer who cannot write", async () => {
    const stranger = new Client();
    const listed = await stranger.post(`/api/frame/blob/${artifact}/list`, "{}");
    expect(listed.status).toBe(200);
  });
});

describe("the frame origin", () => {
  it("serves the bytes with the stored type, immutable caching and nosniff", async () => {
    const record = (await upload(owner, artifact, PNG, "image/png")).body as AssetRecord;
    const response = await fetch(blobUrlFor(artifact, record.id));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
    await owner.post(`/api/frame/blob/${artifact}/${record.id}/delete`);
  });

  it("gives a text asset a charset", async () => {
    const record = (await upload(owner, artifact, Buffer.from("a,b\n"), "text/csv"))
      .body as AssetRecord;
    const response = await fetch(blobUrlFor(artifact, record.id));
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    await owner.post(`/api/frame/blob/${artifact}/${record.id}/delete`);
  });

  it("never serves another artifact's blob", async () => {
    const mine = (await upload(owner, artifact, PNG, "image/png")).body as AssetRecord;
    const other = await createArtifact({ assets: {} });

    // The id is guessed correctly; only the origin is wrong.
    const stolen = await fetch(blobUrlFor(other, mine.id));
    expect(stolen.status).toBe(404);

    const mineAgain = await fetch(blobUrlFor(artifact, mine.id));
    expect(mineAgain.status).toBe(200);
    await owner.post(`/api/frame/blob/${artifact}/${mine.id}/delete`);
  });

  it("404s an id that is not 32 hex, and one that does not exist", async () => {
    expect((await fetch(blobUrlFor(artifact, "../meta.json"))).status).toBe(404);
    expect((await fetch(blobUrlFor(artifact, "0".repeat(32)))).status).toBe(404);
  });

  it("404s a malformed id, from this slice and not from a placeholder", async () => {
    for (const bad of ["A".repeat(32), "0".repeat(31), "not-an-id"]) {
      const response = await fetch(blobUrlFor(artifact, bad));
      expect(response.status).toBe(404);
      // This slice's own body, never a "the assets slice is not installed".
      expect(await response.text()).toBe("not found");
    }
    // `/_blob/` names no id at all, so it matches no route: Hono's own 404.
    expect((await fetch(blobUrlFor(artifact, ""))).status).toBe(404);
  });

  it("answers HEAD with the headers and no body", async () => {
    const record = (await upload(owner, artifact, PNG, "image/png")).body as AssetRecord;
    const response = await fetch(blobUrlFor(artifact, record.id), { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(PNG.length));
    expect((await response.arrayBuffer()).byteLength).toBe(0);

    expect((await fetch(blobUrlFor(artifact, "zz"), { method: "HEAD" })).status).toBe(404);
    await owner.post(`/api/frame/blob/${artifact}/${record.id}/delete`);
  });

  it("refuses a forged asset token, as every other frame path does", async () => {
    const record = (await upload(owner, artifact, PNG, "image/png")).body as AssetRecord;
    const forged = await fetch(`${blobUrlFor(artifact, record.id)}?__frame_t=not.a.real.token`);
    expect(forged.status).toBe(403);
    // The same request without the parameter is an ordinary anonymous fetch.
    expect((await fetch(blobUrlFor(artifact, record.id))).status).toBe(200);
    await owner.post(`/api/frame/blob/${artifact}/${record.id}/delete`);
  });
});

/**
 * The frame-origin route on its own, mounted on a bare Hono app that supplies
 * a `frameViewer` — the same route the real server serves `/_blob/<id>` with.
 */
describe("the frame-origin route itself", () => {
  it("serves the viewer's own artifact and nothing else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assets-route-"));
    try {
      const store = new BlobStore(dir);
      const owned = "a".repeat(32);
      const record = await store.put(owned, Buffer.from("hello"), "text/plain", null);

      let artifactId: string | null = owned;
      const frame = new Hono<FrameEnv>();
      frame.use("*", async (c, next) => {
        c.set("frameViewer", { id: null, artifactId, level: "interact" });
        await next();
      });
      const apps: ServerApps = { shell: new Hono(), frame };
      routes(apps, { config: { dataDir: dir } } as unknown as ServerContext);

      const ok = await frame.request(`/_blob/${record.id}`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("hello");
      expect(ok.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(ok.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

      const head = await frame.request(`/_blob/${record.id}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe("5");

      expect((await frame.request("/_blob/nope")).status).toBe(404);

      // An unlabelled host has no artifact, so it can read nothing.
      artifactId = null;
      expect((await frame.request(`/_blob/${record.id}`)).status).toBe(404);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the per-artifact ceiling", () => {
  it("refuses the blob that would cross it with too_large", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assets-quota-"));
    try {
      const id = "b".repeat(32);
      const bytes = new BlobStore(dir, { maxBytes: 8 });
      await bytes.put(id, Buffer.alloc(4), "image/png", null);
      await bytes.put(id, Buffer.alloc(4), "image/png", null);
      await expect(bytes.put(id, Buffer.alloc(1), "image/png", null)).rejects.toMatchObject({
        code: "too_large",
      });
      expect(await bytes.usage(id)).toEqual({ count: 2, bytes: 8 });

      const other = "c".repeat(32);
      const counted = new BlobStore(dir, { maxCount: 1 });
      await counted.put(other, Buffer.alloc(1), "image/png", null);
      await expect(counted.put(other, Buffer.alloc(1), "image/png", null)).rejects.toMatchObject({
        code: "too_large",
      });
      expect((await counted.usage(other)).count).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("delete", () => {
  it("removes the bytes, the sidecar and the usage, and is idempotent", async () => {
    const id = await createArtifact({ assets: {} });
    const record = (await upload(owner, id, PNG, "image/png")).body as AssetRecord;
    expect((await fetch(blobUrlFor(id, record.id))).status).toBe(200);

    const first = await owner.post(`/api/frame/blob/${id}/${record.id}/delete`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ id: record.id, deleted: true });

    expect((await fetch(blobUrlFor(id, record.id))).status).toBe(404);
    const listed = (await owner.post(`/api/frame/blob/${id}/list`, "{}")).body as AssetPage;
    expect(listed.assets).toEqual([]);
    expect(listed.usage).toEqual({ count: 0, bytes: 0 });

    // Deleting again is a success: the page's intent holds either way.
    const again = await owner.post(`/api/frame/blob/${id}/${record.id}/delete`);
    expect(again.body).toEqual({ id: record.id, deleted: false });
  });

  it("refuses a malformed id and a viewer who cannot write", async () => {
    const bad = await owner.post(`/api/frame/blob/${artifact}/not-an-id/delete`);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_request");

    const record = (await upload(owner, artifact, PNG, "image/png")).body as AssetRecord;
    const stranger = new Client();
    const refused = await stranger.post(`/api/frame/blob/${artifact}/${record.id}/delete`);
    expect(refused.status).toBe(403);
    expect((await fetch(blobUrlFor(artifact, record.id))).status).toBe(200);
    await owner.post(`/api/frame/blob/${artifact}/${record.id}/delete`);
  });
});
