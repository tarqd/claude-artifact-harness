/**
 * The db document store: one JSON file per document under
 * `DATA_DIR/artifacts/<id>/db/`, an in-memory index rebuilt on first touch,
 * and a single-process write lock per artifact (design.md "Backend storage").
 *
 * Everything here is store semantics only - no HTTP, no identity, no rules.
 * The caller (server.ts) decides who may see what and hands this module
 * already-authorised paths.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capError } from "../../protocol/errors.ts";
import { isPlainObject, mergeDeep } from "./query.ts";
// Merging, filtering and ordering are pure and shared with the broker, which
// applies a page's own write to its mirrors; callers still import them here.
export { compareValues, isPlainObject, matchesWhere, mergeDeep, orderRows } from "./query.ts";
import {
  encodePathForFs,
  isCollectionPath,
  isDocumentPath,
  parentCollection,
  splitPath,
} from "../../protocol/paths.ts";

/* ------------------------------------------------------------------ */
/* limits (db.d.ts)                                                    */
/* ------------------------------------------------------------------ */

/** A document body, serialized. */
export const MAX_DOC_BYTES = 256 * 1024;
/** Nesting depth of a document body; the body object itself is level 1. */
export const MAX_DOC_DEPTH = 32;
/** Documents in one artifact's database. */
export const MAX_DOCUMENTS = 5000;
/** Lease length clamp, in ms. */
export const MIN_TTL_MS = 1000;
export const MAX_TTL_MS = 600_000;
export const DEFAULT_TTL_MS = 30_000;
/** Query shape limits. */
export const MAX_WHERE = 10;
export const MAX_IN_VALUES = 30;
export const MAX_LIMIT = 1000;
/** A filter's `v`, serialized — it is sealed into the lane grant verbatim. */
export const MAX_WHERE_VALUE_BYTES = 4096;
/** Documents one query may scan before it is refused. */
export const MAX_SCAN = 5000;

export const QUERY_OPERATORS = [
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "in",
  "not-in",
  "array-contains",
] as const;
export type QueryOperator = (typeof QUERY_OPERATORS)[number];

const INVALID = (message: string): never => {
  throw capError("invalid_argument", message);
};

/* ------------------------------------------------------------------ */
/* shapes                                                              */
/* ------------------------------------------------------------------ */

export interface Lease {
  holder: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface StoredDoc {
  path: string;
  data: Record<string, unknown>;
  /** Bumped on every write; the `version` an `acquire` reports. */
  rev: number;
  updatedAt: string;
  lease?: Lease;
}

export interface WhereClause {
  f: string;
  op: QueryOperator;
  v: unknown;
}

export interface QuerySpec {
  collection: string;
  where?: WhereClause[];
  orderBy?: { f: string; dir: "asc" | "desc" };
  limit?: number;
}

export interface DocRow {
  id: string;
  data: Record<string, unknown>;
}

export interface AcquireOptions {
  holder: string;
  ttlMs?: number;
  data?: Record<string, unknown>;
}

export interface AcquireResult {
  acquired: boolean;
  version?: number;
  expiresAt?: string;
  holder?: string;
}

/* ------------------------------------------------------------------ */
/* body validation                                                     */
/* ------------------------------------------------------------------ */

/** Depth of a JSON value; a body of scalars is depth 1. */
export function jsonDepth(value: unknown, level = 1): number {
  if (Array.isArray(value)) {
    let deepest = level;
    for (const item of value) deepest = Math.max(deepest, jsonDepth(item, level + 1));
    return deepest;
  }
  if (typeof value === "object" && value !== null) {
    let deepest = level;
    for (const item of Object.values(value)) deepest = Math.max(deepest, jsonDepth(item, level + 1));
    return deepest;
  }
  return level;
}

/**
 * A document body: a plain JSON object, at most 256 KiB serialized and
 * 32 levels deep. Anything JSON cannot carry (undefined, functions, NaN,
 * cycles) is `invalid_argument`, not a silently dropped field.
 */
export function validateBody(body: unknown, what = "the document body"): Record<string, unknown> {
  if (!isPlainObject(body)) {
    INVALID(`${what} must be a plain JSON object`);
  }
  const plain = body as Record<string, unknown>;
  assertJsonValues(plain, what);
  if (jsonDepth(plain) > MAX_DOC_DEPTH) {
    INVALID(`${what} is deeper than ${MAX_DOC_DEPTH} levels`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(plain);
  } catch {
    return INVALID(`${what} must be plain JSON`);
  }
  if (serialized === undefined) INVALID(`${what} must be plain JSON`);
  if (Buffer.byteLength(serialized) > MAX_DOC_BYTES) {
    INVALID(`${what} is larger than ${MAX_DOC_BYTES} bytes`);
  }
  return plain;
}

function assertJsonValues(value: unknown, what: string, seen = new Set<unknown>()): void {
  if (value === null) return;
  const type = typeof value;
  if (type === "string" || type === "boolean") return;
  if (type === "number") {
    if (!Number.isFinite(value as number)) INVALID(`${what} holds a number JSON cannot carry`);
    return;
  }
  if (type !== "object") INVALID(`${what} holds a ${type}, which is not JSON`);
  if (seen.has(value)) INVALID(`${what} is cyclic`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValues(item, what, seen);
  } else {
    if (!isPlainObject(value)) INVALID(`${what} holds a value that is not plain JSON`);
    for (const item of Object.values(value as Record<string, unknown>)) {
      assertJsonValues(item, what, seen);
    }
  }
  seen.delete(value);
}

/* ------------------------------------------------------------------ */
/* query validation and evaluation                                     */
/* ------------------------------------------------------------------ */

export function validateQuerySpec(spec: unknown): QuerySpec {
  if (typeof spec !== "object" || spec === null) {
    INVALID("a query needs a collection");
  }
  const raw = spec as { collection?: unknown; where?: unknown; orderBy?: unknown; limit?: unknown };
  if (typeof raw.collection !== "string" || !isCollectionPath(raw.collection)) {
    INVALID("a query needs a collection path with an odd number of segments");
  }
  const out: QuerySpec = { collection: raw.collection as string };

  if (raw.where !== undefined && raw.where !== null) {
    if (!Array.isArray(raw.where)) INVALID("where must be a list of filters");
    const clauses = raw.where as unknown[];
    if (clauses.length > MAX_WHERE) INVALID(`at most ${MAX_WHERE} filters are allowed`);
    out.where = clauses.map((clause) => validateWhere(clause));
  }

  if (raw.orderBy !== undefined && raw.orderBy !== null) {
    const order = raw.orderBy as { f?: unknown; dir?: unknown };
    if (typeof order !== "object" || typeof order.f !== "string" || order.f.length === 0) {
      INVALID("orderBy needs a field name");
    }
    const dir = order.dir === undefined ? "asc" : order.dir;
    if (dir !== "asc" && dir !== "desc") INVALID('orderBy direction must be "asc" or "desc"');
    out.orderBy = { f: order.f as string, dir: dir as "asc" | "desc" };
  }

  if (raw.limit !== undefined && raw.limit !== null) {
    const limit = raw.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      INVALID(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    out.limit = limit as number;
  }
  return out;
}

function validateWhere(clause: unknown): WhereClause {
  if (typeof clause !== "object" || clause === null) INVALID("a filter must be an object");
  const raw = clause as { f?: unknown; op?: unknown; v?: unknown };
  if (typeof raw.f !== "string" || raw.f.length === 0) INVALID("a filter needs a field name");
  if (typeof raw.op !== "string" || !(QUERY_OPERATORS as readonly string[]).includes(raw.op)) {
    INVALID(`a filter operator must be one of ${QUERY_OPERATORS.join(", ")}`);
  }
  const op = raw.op as QueryOperator;
  if (op === "in" || op === "not-in") {
    if (!Array.isArray(raw.v)) INVALID(`the ${op} operator takes an array of values`);
    if ((raw.v as unknown[]).length > MAX_IN_VALUES) {
      INVALID(`the ${op} operator takes at most ${MAX_IN_VALUES} values`);
    }
  }
  // `raw.v` only ever reaches here as `JSON.parse` output (or `undefined`,
  // for an unset field), so it can never be circular or hold a BigInt:
  // `JSON.stringify` cannot throw on it. `?? ""` covers the `undefined` case,
  // where `stringify` itself returns `undefined` rather than a string.
  const serializedValue = JSON.stringify(raw.v) ?? "";
  if (Buffer.byteLength(serializedValue) > MAX_WHERE_VALUE_BYTES) {
    INVALID(`a filter value is larger than ${MAX_WHERE_VALUE_BYTES} bytes`);
  }
  return { f: raw.f as string, op, v: raw.v };
}

/* ------------------------------------------------------------------ */
/* the store                                                           */
/* ------------------------------------------------------------------ */

interface ArtifactDb {
  docs: Map<string, StoredDoc>;
  loaded: Promise<void> | null;
  lock: Promise<unknown>;
}

export type ChangeListener = (artifactId: string, paths: readonly string[]) => void;

export class DbStore {
  private readonly dbs = new Map<string, ArtifactDb>();
  private readonly listeners = new Set<ChangeListener>();

  constructor(private readonly root: string) {}

  private dir(artifactId: string): string {
    return join(this.root, "artifacts", artifactId, "db");
  }

  private entry(artifactId: string): ArtifactDb {
    let db = this.dbs.get(artifactId);
    if (!db) {
      db = { docs: new Map(), loaded: null, lock: Promise.resolve() };
      this.dbs.set(artifactId, db);
    }
    return db;
  }

  /** Rebuild the in-memory index for one artifact, once. */
  private async load(artifactId: string): Promise<ArtifactDb> {
    const db = this.entry(artifactId);
    if (!db.loaded) {
      db.loaded = (async () => {
        let names: string[];
        try {
          names = await readdir(this.dir(artifactId));
        } catch {
          return;
        }
        for (const name of names) {
          if (!name.endsWith(".json")) continue;
          try {
            const raw = await readFile(join(this.dir(artifactId), name), "utf8");
            const doc = JSON.parse(raw) as StoredDoc;
            if (typeof doc.path === "string" && isPlainObject(doc.data)) {
              db.docs.set(doc.path, doc);
            }
          } catch {
            /* a half-written file is not a reason to refuse the whole store */
          }
        }
      })();
    }
    await db.loaded;
    return db;
  }

  /** Serialise writes per artifact: last-writer-wins, but never interleaved. */
  private async withLock<T>(artifactId: string, fn: () => Promise<T>): Promise<T> {
    const db = this.entry(artifactId);
    const run = db.lock.then(fn, fn);
    db.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(artifactId: string, paths: string[]): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(artifactId, paths);
      } catch {
        /* one bad listener must not break a write */
      }
    }
  }

  private async persist(artifactId: string, doc: StoredDoc): Promise<void> {
    const dir = this.dir(artifactId);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${encodePathForFs(doc.path)}.json`);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(doc));
    await rename(tmp, file);
  }

  private async unlink(artifactId: string, path: string): Promise<void> {
    await rm(join(this.dir(artifactId), `${encodePathForFs(path)}.json`), { force: true });
  }

  /** Live leases only; an expired one is invisible to every caller. */
  private activeLease(doc: StoredDoc | undefined, now: number): Lease | null {
    if (!doc?.lease) return null;
    return doc.lease.expiresAt > now ? doc.lease : null;
  }

  async read(artifactId: string, path: string): Promise<StoredDoc | null> {
    if (!isDocumentPath(path)) INVALID(`"${path}" is not a document path`);
    const db = await this.load(artifactId);
    return db.docs.get(path) ?? null;
  }

  async count(artifactId: string): Promise<number> {
    const db = await this.load(artifactId);
    return db.docs.size;
  }

  async set(
    artifactId: string,
    path: string,
    body: unknown,
  ): Promise<StoredDoc> {
    if (!isDocumentPath(path)) INVALID(`"${path}" is not a document path`);
    const data = validateBody(body);
    const db = await this.load(artifactId);
    return this.withLock(artifactId, async () => {
      const existing = db.docs.get(path);
      if (!existing && db.docs.size >= MAX_DOCUMENTS) {
        throw capError(
          "quota_exceeded",
          `this artifact's database is full (${MAX_DOCUMENTS} documents)`,
        );
      }
      const doc: StoredDoc = {
        path,
        data,
        rev: (existing?.rev ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        ...(existing?.lease ? { lease: existing.lease } : {}),
      };
      db.docs.set(path, doc);
      await this.persist(artifactId, doc);
      this.emit(artifactId, [path]);
      return doc;
    });
  }

  async update(artifactId: string, path: string, body: unknown): Promise<StoredDoc> {
    if (!isDocumentPath(path)) INVALID(`"${path}" is not a document path`);
    const patch = validateBody(body, "the update body");
    const db = await this.load(artifactId);
    return this.withLock(artifactId, async () => {
      const existing = db.docs.get(path);
      if (!existing) {
        throw capError("invalid_argument", `no document at "${path}" to update`);
      }
      const merged = validateBody(mergeDeep(existing.data, patch));
      const doc: StoredDoc = {
        path,
        data: merged,
        rev: existing.rev + 1,
        updatedAt: new Date().toISOString(),
        ...(existing.lease ? { lease: existing.lease } : {}),
      };
      db.docs.set(path, doc);
      await this.persist(artifactId, doc);
      this.emit(artifactId, [path]);
      return doc;
    });
  }

  async delete(artifactId: string, path: string): Promise<void> {
    if (!isDocumentPath(path)) INVALID(`"${path}" is not a document path`);
    const db = await this.load(artifactId);
    await this.withLock(artifactId, async () => {
      const existed = db.docs.delete(path);
      await this.unlink(artifactId, path);
      // Idempotent, but only a real removal is worth waking subscribers for.
      if (existed) this.emit(artifactId, [path]);
    });
  }

  /**
   * Cooperative lease. Free (or held by the same holder) grants and renews;
   * busy resolves `{acquired: false}` with the expiry of the lease in force
   * and never the holder's name.
   */
  async acquire(
    artifactId: string,
    path: string,
    options: AcquireOptions,
  ): Promise<AcquireResult> {
    if (!isDocumentPath(path)) INVALID(`"${path}" is not a document path`);
    if (typeof options !== "object" || options === null) INVALID("acquire needs a holder");
    if (typeof options.holder !== "string" || options.holder.length === 0) {
      INVALID("acquire needs a holder string");
    }
    if (options.holder.length > 200) INVALID("the holder string is too long");
    const patch = options.data === undefined ? null : validateBody(options.data, "the lease data");
    const requested =
      typeof options.ttlMs === "number" && Number.isFinite(options.ttlMs) && options.ttlMs > 0
        ? options.ttlMs
        : DEFAULT_TTL_MS;
    const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(requested)));

    const db = await this.load(artifactId);
    return this.withLock(artifactId, async () => {
      const now = Date.now();
      const existing = db.docs.get(path);
      const lease = this.activeLease(existing, now);
      if (lease && lease.holder !== options.holder) {
        return { acquired: false, expiresAt: new Date(lease.expiresAt).toISOString() };
      }
      if (!existing && db.docs.size >= MAX_DOCUMENTS) {
        throw capError(
          "quota_exceeded",
          `this artifact's database is full (${MAX_DOCUMENTS} documents)`,
        );
      }
      const expiresAt = now + ttl;
      const data = patch ? validateBody(mergeDeep(existing?.data ?? {}, patch)) : (existing?.data ?? {});
      const doc: StoredDoc = {
        path,
        data,
        rev: (existing?.rev ?? 0) + 1,
        updatedAt: new Date(now).toISOString(),
        lease: { holder: options.holder, expiresAt },
      };
      db.docs.set(path, doc);
      await this.persist(artifactId, doc);
      this.emit(artifactId, [path]);
      return {
        acquired: true,
        version: doc.rev,
        expiresAt: new Date(expiresAt).toISOString(),
        holder: options.holder,
      };
    });
  }

  /**
   * Every document directly inside one collection, unordered. The caller
   * filters by visibility before ordering, so an invisible document is
   * omitted rather than counted against the window.
   */
  async collect(artifactId: string, collection: string): Promise<StoredDoc[]> {
    if (!isCollectionPath(collection)) {
      INVALID(`"${collection}" is not a collection path`);
    }
    const db = await this.load(artifactId);
    const depth = splitPath(collection).length + 1;
    const out: StoredDoc[] = [];
    for (const doc of db.docs.values()) {
      if (splitPath(doc.path).length !== depth) continue;
      if (parentCollection(doc.path) !== collection) continue;
      out.push(doc);
      if (out.length > MAX_SCAN) {
        throw capError("resource_exhausted", "this query scans too many documents");
      }
    }
    return out;
  }

  /** Drop one artifact's cached index (used by tests and by deletion). */
  forget(artifactId: string): void {
    this.dbs.delete(artifactId);
  }
}
