/**
 * `assets` backend.
 *
 * Storage (design.md "Backend storage"): `artifacts/<id>/blobs/<blobId>` holds
 * the bytes, `artifacts/<id>/blobs/<blobId>.json` is the sidecar naming the
 * stored content type (plus size, creation time, a per-artifact sequence
 * number and who uploaded it), and `artifacts/<id>/blobs/usage.json` is the
 * usage record `list` reports. Every read and write for one artifact is
 * serialised through a promise chain, as the spine's store does, so a page is
 * never handed rows and a usage count that disagree.
 *
 * Routes:
 *   shell origin (viewer cookie, admin-or-owner to write)
 *     POST /api/frame/blob/:id/upload           raw body, Content-Type header
 *     POST /api/frame/blob/:id/list             {after?}
 *     POST /api/frame/blob/:id/:blobId/delete
 *   frame origin (anonymous, like every other subresource)
 *     GET|HEAD /_blob/:blobId
 *
 * The frame-origin read is scoped by the **host label**, never by anything the
 * client says: `<artifactA>.localhost/_blob/<id>` only ever looks under
 * artifact A's directory, so artifact B's origin cannot fetch A's bytes even
 * when it knows the id.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isCapError } from "../../protocol/errors.ts";
import { isArtifactId, isBlobId } from "../../protocol/paths.ts";
import { DEFAULT_FRAME_BODY_LIMIT, maxBodySize } from "../../server/body-limit.ts";
import type { ArtifactMeta } from "../../server/store.ts";
import type { ServerApps, ServerContext } from "../../server/types.ts";
import type { Context } from "hono";
import {
  MAX_ARTIFACT_ASSETS,
  MAX_ARTIFACT_BYTES,
  blobUrl,
  checkSize,
  checkType,
  invalidRequest,
  limitFor,
  tooLarge,
  LIST_PAGE_SIZE,
  upstreamError,
  type AssetPage,
  type AssetRecord,
  type AssetUsage,
} from "./protocol.ts";

const USAGE_FILE = "usage.json";

/** A stored row: the wire record plus the ordering key it is filed under. */
interface Row extends AssetRecord {
  seq: number;
}

/** What the sidecar holds: the row plus who wrote it. */
interface Sidecar extends Row {
  by: string | null;
}

export interface StoredBlob {
  body: Buffer;
  type: string;
}

/** Per-artifact storage ceiling; crossing it is the documented `too_large`. */
export interface BlobLimits {
  maxBytes?: number;
  maxCount?: number;
}

/**
 * The sort key: a per-artifact sequence number assigned under the write lock,
 * so two uploads in the same millisecond cannot tie and list order is always
 * creation order. `createdAt` and the id follow it only so that rows written
 * before sequence numbers existed (`seq: 0`) still order sensibly.
 */
function sortKey(row: Row): string {
  return `${String(row.seq).padStart(12, "0")}|${row.createdAt}|${row.id}`;
}

/**
 * A page cursor is the sort key of the last row it returned, so a row deleted
 * between two pages cannot make the next page skip its neighbour. It is opaque
 * to the page.
 */
function cursorFor(row: Row): string {
  return sortKey(row);
}

/** The wire record: the ordering key is ours, not the page's. */
function wire(row: Row): AssetRecord {
  return { id: row.id, url: row.url, type: row.type, size: row.size, createdAt: row.createdAt };
}

function totals(rows: Row[]): AssetUsage {
  return { count: rows.length, bytes: rows.reduce((sum, r) => sum + r.size, 0) };
}

export function mintBlobId(): string {
  return randomUUID().replaceAll("-", "");
}

/* ------------------------------------------------------------------ */
/* the store                                                           */
/* ------------------------------------------------------------------ */

export class BlobStore {
  private readonly locks = new Map<string, Promise<unknown>>();
  /** High-water mark per artifact, so a sequence is never reused in a run. */
  private readonly highSeq = new Map<string, number>();
  private readonly maxBytes: number;
  private readonly maxCount: number;

  constructor(
    private readonly dataDir: string,
    limits: BlobLimits = {},
  ) {
    this.maxBytes = limits.maxBytes ?? MAX_ARTIFACT_BYTES;
    this.maxCount = limits.maxCount ?? MAX_ARTIFACT_ASSETS;
  }

  private dir(artifactId: string): string {
    if (!isArtifactId(artifactId)) throw invalidRequest("bad artifact id");
    return join(this.dataDir, "artifacts", artifactId, "blobs");
  }

  /**
   * Serialise every access to one artifact's directory. Not reentrant: the
   * helpers below run *inside* a lock and never take one themselves.
   */
  private async withLock<T>(artifactId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(artifactId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.locks.set(
      artifactId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** Every sidecar in the directory, in creation order. */
  private async rows(artifactId: string): Promise<Row[]> {
    const dir = this.dir(artifactId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: Row[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!isBlobId(id)) continue; // usage.json and anything else is not an asset
      try {
        const raw = await readFile(join(dir, name), "utf8");
        const parsed = JSON.parse(raw) as Partial<Sidecar>;
        if (typeof parsed.type !== "string" || typeof parsed.size !== "number") continue;
        out.push({
          id,
          url: blobUrl(id),
          type: parsed.type,
          size: parsed.size,
          createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
          seq: typeof parsed.seq === "number" && Number.isFinite(parsed.seq) ? parsed.seq : 0,
        });
      } catch {
        /* an unreadable sidecar is not an asset */
      }
    }
    out.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
    return out;
  }

  /** Write the usage cache. Runs inside the lock; never fails the call. */
  private async writeUsage(artifactId: string, usage: AssetUsage): Promise<void> {
    const dir = this.dir(artifactId);
    // A unique temp name: two writers on this path must never rename the same
    // file out from under each other.
    const tmp = join(dir, `${USAGE_FILE}.${randomUUID()}.tmp`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(tmp, JSON.stringify({ ...usage, updatedAt: new Date().toISOString() }));
      await rename(tmp, join(dir, USAGE_FILE));
    } catch {
      /* the record is a cache: a failure to persist it must not fail the call */
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Usage derived from the sidecars, refreshing the cached record whenever it
   * disagrees — a stale `usage.json` is corrected rather than trusted. Runs
   * inside the lock.
   */
  private async syncUsage(artifactId: string, rows: Row[]): Promise<AssetUsage> {
    const usage = totals(rows);
    let cached: AssetUsage | null = null;
    try {
      const parsed = JSON.parse(
        await readFile(join(this.dir(artifactId), USAGE_FILE), "utf8"),
      ) as Partial<AssetUsage>;
      if (typeof parsed.count === "number" && typeof parsed.bytes === "number") {
        cached = { count: parsed.count, bytes: parsed.bytes };
      }
    } catch {
      /* missing or corrupt: rewrite it */
    }
    if (!cached || cached.count !== usage.count || cached.bytes !== usage.bytes) {
      await this.writeUsage(artifactId, usage);
    }
    return usage;
  }

  /** The artifact's usage, derived from the sidecars. */
  async usage(artifactId: string): Promise<AssetUsage> {
    return this.withLock(artifactId, async () =>
      this.syncUsage(artifactId, await this.rows(artifactId)),
    );
  }

  async put(
    artifactId: string,
    body: Buffer,
    type: string,
    by: string | null,
  ): Promise<AssetRecord> {
    return this.withLock(artifactId, async () => {
      const dir = this.dir(artifactId);
      await mkdir(dir, { recursive: true });
      const existing = await this.rows(artifactId);
      const used = totals(existing);

      // The per-artifact ceiling. `too_large` is the documented code for "the
      // bytes do not fit", and it is the one a page can act on.
      if (used.count + 1 > this.maxCount) {
        throw tooLarge(`this artifact already holds ${this.maxCount} assets`);
      }
      if (used.bytes + body.length > this.maxBytes) {
        const mib = Math.round(this.maxBytes / (1024 * 1024));
        throw tooLarge(`this artifact's assets may total at most ${mib} MiB`);
      }

      const seq =
        Math.max(
          this.highSeq.get(artifactId) ?? 0,
          ...existing.map((r) => r.seq),
          0,
        ) + 1;
      this.highSeq.set(artifactId, seq);

      const id = mintBlobId();
      const row: Row = {
        id,
        url: blobUrl(id),
        type,
        size: body.length,
        createdAt: new Date().toISOString(),
        seq,
      };
      const sidecar: Sidecar = { ...row, by };
      await writeFile(join(dir, id), body);
      await writeFile(join(dir, `${id}.json`), JSON.stringify(sidecar, null, 2));
      await this.writeUsage(artifactId, {
        count: used.count + 1,
        bytes: used.bytes + row.size,
      });
      return wire(row);
    });
  }

  /** One page of the artifact's assets, plus the whole artifact's usage. */
  async list(artifactId: string, after?: string): Promise<AssetPage> {
    return this.withLock(artifactId, async () => {
      const all = await this.rows(artifactId);
      // Rows and usage come from the same read, so they can never disagree.
      const usage = await this.syncUsage(artifactId, all);
      const rest = after ? all.filter((row) => cursorFor(row) > after) : all;
      const rows = rest.slice(0, LIST_PAGE_SIZE);
      const last = rows[rows.length - 1];
      const assets = rows.map(wire);
      if (last && rest.length > rows.length) {
        return { assets, usage, next: cursorFor(last) };
      }
      return { assets, usage };
    });
  }

  async remove(artifactId: string, blobId: string): Promise<boolean> {
    if (!isBlobId(blobId)) throw invalidRequest("bad asset id");
    return this.withLock(artifactId, async () => {
      const dir = this.dir(artifactId);
      let existed = false;
      try {
        await readFile(join(dir, `${blobId}.json`), "utf8");
        existed = true;
      } catch {
        existed = false;
      }
      await rm(join(dir, blobId), { force: true });
      await rm(join(dir, `${blobId}.json`), { force: true });
      await this.syncUsage(artifactId, await this.rows(artifactId));
      return existed;
    });
  }

  /** The bytes and their stored content type, or `null`. */
  async read(artifactId: string, blobId: string): Promise<StoredBlob | null> {
    if (!isArtifactId(artifactId) || !isBlobId(blobId)) return null;
    const dir = this.dir(artifactId);
    try {
      const body = await readFile(join(dir, blobId));
      let type = "application/octet-stream";
      try {
        const parsed = JSON.parse(await readFile(join(dir, `${blobId}.json`), "utf8")) as {
          type?: unknown;
        };
        if (typeof parsed.type === "string" && parsed.type.length > 0) type = parsed.type;
      } catch {
        /* no sidecar: serve as opaque bytes rather than guessing */
      }
      return { body, type };
    } catch {
      return null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* serving                                                             */
/* ------------------------------------------------------------------ */

const TEXTUAL = /^text\/|^application\/json$/;

/** Bytes are immutable: the id is content-addressed by minting, never reused. */
export function blobHeaders(type: string): Record<string, string> {
  return {
    "content-type": TEXTUAL.test(type) ? `${type}; charset=utf-8` : type,
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    // An uploaded SVG is markup on the artifact's own origin; `sandbox` keeps
    // it from executing if it is ever navigated to directly. It has no effect
    // on `<img>`, `<video>`, `<link rel=font>` or `fetch`.
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
  };
}

const NOT_FOUND_HEADERS: Record<string, string> = {
  "content-type": "text/plain; charset=UTF-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

async function blobResponse(
  blobs: BlobStore,
  artifactId: string | null,
  blobId: string,
  method: string,
): Promise<Response> {
  const missing = new Response("not found", { status: 404, headers: NOT_FOUND_HEADERS });
  if (!artifactId || !isBlobId(blobId)) return missing;
  const found = await blobs.read(artifactId, blobId);
  if (!found) return missing;
  const headers = { ...blobHeaders(found.type), "content-length": String(found.body.length) };
  if (method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(new Uint8Array(found.body), { status: 200, headers });
}

/* ------------------------------------------------------------------ */
/* shell-origin routes                                                 */
/* ------------------------------------------------------------------ */

interface Gate {
  meta: ArtifactMeta;
  viewerId: string;
  canEdit: boolean;
}

/** Resolve the artifact and the asking viewer, or the refusal to send back. */
async function gate(
  c: Context,
  ctx: ServerContext,
): Promise<{ ok: Gate } | { refusal: Response }> {
  const id = c.req.param("id");
  const json = (body: unknown, status: 400 | 403 | 404): { refusal: Response } => ({
    refusal: c.json(body, status),
  });
  if (!isArtifactId(id)) return json(invalidRequest("bad artifact id"), 400);
  const meta = await ctx.store.readMeta(id);
  if (!meta) return json(invalidRequest("no such artifact"), 404);
  if (!("assets" in meta.capabilities)) {
    return json(invalidRequest("this artifact does not declare assets"), 400);
  }
  const viewer = ctx.auth.viewer(c);
  const level = ctx.auth.levelFor(viewer, meta);
  return { ok: { meta, viewerId: viewer.id, canEdit: ctx.auth.canEdit(level) } };
}

/**
 * Read the request body with a running byte cap: an upload that lies about its
 * length (or declares none at all) is refused as soon as it crosses the cap,
 * never after it has been buffered whole.
 */
async function readCappedBody(c: Context, limit: number): Promise<Buffer | "too_large"> {
  const stream = c.req.raw.body;
  if (!stream) {
    // No stream to meter (an empty body, or an adapter that already buffered):
    // the declared-length check above is the only guard that applies.
    const buffered = Buffer.from(await c.req.arrayBuffer());
    return buffered.length > limit ? "too_large" : buffered;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return "too_large";
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released by cancel() */
    }
  }
  return Buffer.concat(chunks, total);
}

/** A capability error from the store keeps its code and its documented status. */
function failure(c: Context, err: unknown): Response {
  if (isCapError(err)) {
    if (err.code === "too_large") return c.json(err, 413);
    if (err.code === "unsupported_type") return c.json(err, 415);
    if (err.code === "invalid_request") return c.json(err, 400);
    return c.json(err, 500);
  }
  return c.json(upstreamError(err instanceof Error ? err.message : String(err)), 500);
}

export function routes(apps: ServerApps, ctx: ServerContext): void {
  const blobs = new BlobStore(ctx.config.dataDir);

  // `/upload` has its own streaming cap (`readCappedBody`, sized per content
  // type below); the two small JSON routes get the same pre-parse guard
  // every other frame JSON route does.
  apps.shell.use("/api/frame/blob/:id/list", maxBodySize(DEFAULT_FRAME_BODY_LIMIT));
  apps.shell.use("/api/frame/blob/:id/:blobId/delete", maxBodySize(DEFAULT_FRAME_BODY_LIMIT));

  apps.shell.post("/api/frame/blob/:id/upload", async (c) => {
    const resolved = await gate(c, ctx);
    if ("refusal" in resolved) return resolved.refusal;
    if (!resolved.ok.canEdit) {
      return c.json(upstreamError("this viewer cannot change this artifact's assets"), 403);
    }

    const checked = checkType(c.req.header("content-type"));
    if ("error" in checked) {
      return c.json(checked.error, checked.error.code === "unsupported_type" ? 415 : 400);
    }
    const limit = limitFor(checked.type);

    // Refuse an oversized body before reading it at all when the client
    // declares its length; the real check meters the bytes as they arrive.
    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > limit) {
      return c.json(checkSize(checked.type, declared) ?? upstreamError("too large"), 413);
    }

    let body: Buffer | "too_large";
    try {
      body = await readCappedBody(c, limit);
    } catch (err) {
      return c.json(upstreamError(err instanceof Error ? err.message : String(err)), 400);
    }
    if (body === "too_large") {
      // The rest of the body was never read, so this connection cannot be
      // reused: say so rather than leaving a client to find out by reset.
      return c.json(checkSize(checked.type, limit + 1) ?? upstreamError("too large"), 413, {
        connection: "close",
      });
    }

    try {
      const record = await blobs.put(
        resolved.ok.meta.id,
        body,
        checked.type,
        resolved.ok.viewerId,
      );
      return c.json(record);
    } catch (err) {
      return failure(c, err);
    }
  });

  apps.shell.post("/api/frame/blob/:id/list", async (c) => {
    const resolved = await gate(c, ctx);
    if ("refusal" in resolved) return resolved.refusal;
    const body = (await c.req.json().catch(() => null)) as { after?: unknown } | null;
    const after = typeof body?.after === "string" && body.after ? body.after : undefined;
    try {
      return c.json(await blobs.list(resolved.ok.meta.id, after));
    } catch (err) {
      return failure(c, err);
    }
  });

  apps.shell.post("/api/frame/blob/:id/:blobId/delete", async (c) => {
    const resolved = await gate(c, ctx);
    if ("refusal" in resolved) return resolved.refusal;
    if (!resolved.ok.canEdit) {
      return c.json(upstreamError("this viewer cannot change this artifact's assets"), 403);
    }
    const blobId = c.req.param("blobId");
    if (!isBlobId(blobId)) return c.json(invalidRequest("bad asset id"), 400);
    try {
      // Deleting an asset that is already gone is a success: the page's
      // intent (this id must not resolve) holds either way.
      const deleted = await blobs.remove(resolved.ok.meta.id, blobId);
      return c.json({ id: blobId, deleted });
    } catch (err) {
      return failure(c, err);
    }
  });

  /* ---------------------------- frame origin ---------------------------- */

  // The spine leaves this path free for the slice (`mountFrameRoutes` used to
  // hold it with a 501 placeholder, which — Hono ending the chain at the first
  // handler that returns — hid this route). Identity comes from the frame
  // middleware's `frameViewer`, whose `artifactId` is the host label: artifact
  // B's origin can never read artifact A's bytes, even knowing the id.
  apps.frame.on(["GET", "HEAD"], "/_blob/:blobId", async (c) => {
    const viewer = c.get("frameViewer");
    return blobResponse(blobs, viewer.artifactId, c.req.param("blobId"), c.req.method);
  });
}
