/**
 * `db` — the page-facing store from `reference/contract/0.2.32/db.d.ts`.
 *
 * Refs are pure path holders: building one never touches the network, and a
 * path that breaks the grammar throws a `TypeError` right where it is
 * written. Every terminal call rejects (never throws) with a `DbError`.
 *
 * Subscriptions use the platform's mirror-and-ops model: the shell sends
 * `__frame_db_ev` snapshots carrying index-based splices, this module keeps
 * one mirror array per subscription and applies them, and the objects it
 * hands the page are frozen and structurally shared - a document that did
 * not change is the SAME object across deliveries.
 */
import { createRpc, browserRpcHost, type RpcClient } from "../../frame/rpc.ts";
import { capError, type CapError } from "../../protocol/errors.ts";
import {
  byteLength,
  isPathSegment,
  MAX_PATH_BYTES,
  MAX_PATH_SEGMENTS,
  mintDocId,
  splitPath,
} from "../../protocol/paths.ts";
import type { FrameContext } from "../../frame/types.ts";

const CAP = "db";

/** At most 64 active subscriptions per view (db.d.ts). */
export const MAX_SUBSCRIPTIONS = 64;
/** Argument shape limits applied before a call is posted (surface-area §5.9). */
export const MAX_ARG_DEPTH = 40;
export const MAX_CONTAINER_ENTRIES = 131_072;
export const MAX_ARG_BYTES = 286_720;

const OPERATORS = ["==", "!=", "<", "<=", ">", ">=", "in", "not-in", "array-contains"];
const MAX_WHERE = 10;
const MAX_IN_VALUES = 30;
const MAX_LIMIT = 1000;

/* ------------------------------------------------------------------ */
/* path grammar                                                        */
/* ------------------------------------------------------------------ */

export type PathKind = "document" | "collection";

/**
 * The broken rule, or null when the path is good. The message names the rule
 * and - for a parity failure - the segment count, because that is the number
 * the author has to think about.
 */
export function pathProblem(path: unknown, kind: PathKind): string | null {
  if (typeof path !== "string") return "the path must be a string";
  if (path.length === 0) return "the path must not be empty";
  const bytes = byteLength(path);
  if (bytes > MAX_PATH_BYTES) {
    return `a path is at most ${MAX_PATH_BYTES} bytes; this one is ${bytes}`;
  }
  const segs = splitPath(path);
  if (segs.length > MAX_PATH_SEGMENTS) {
    return `a path has at most ${MAX_PATH_SEGMENTS} segments; this one has ${segs.length}`;
  }
  for (const [index, seg] of segs.entries()) {
    if (seg.length === 0) {
      return `segment ${index + 1} of ${segs.length} is empty`;
    }
    if (seg === "." || seg === "..") {
      return `segment ${index + 1} of ${segs.length} is "${seg}", which is never a path segment`;
    }
    if (byteLength(seg) > 200) {
      return `segment ${index + 1} of ${segs.length} is longer than 200 bytes`;
    }
    if (!isPathSegment(seg)) {
      return `segment ${index + 1} of ${segs.length} ("${seg}") may use only letters, digits and _ - . ~ : @ +`;
    }
  }
  const even = segs.length % 2 === 0;
  if (kind === "document" && !even) {
    return `a document path has an even number of segments; "${path}" has ${segs.length}`;
  }
  if (kind === "collection" && even) {
    return `a collection path has an odd number of segments; "${path}" has ${segs.length}`;
  }
  return null;
}

/** Throws the `TypeError` the contract promises, naming the call site. */
export function assertPath(where: string, path: unknown, kind: PathKind): string {
  const problem = pathProblem(path, kind);
  if (problem !== null) throw new TypeError(`${where}: ${problem}`);
  return path as string;
}

function lastSegment(path: string): string {
  const segs = splitPath(path);
  return segs[segs.length - 1] ?? path;
}

/* ------------------------------------------------------------------ */
/* argument validation                                                 */
/* ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const INVALID = (message: string): CapError => capError("invalid_argument", message);

/**
 * Plain JSON only, at most 40 levels, 131072 entries per container and
 * 286720 bytes serialized - checked before anything is posted, so an
 * argument the shell could never accept fails here with the code the
 * contract names.
 */
export function checkArgument(value: unknown, what: string): void {
  walk(value, what, 1, new Set());
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw INVALID(`${what} must be plain JSON`);
  }
  if (json === undefined) throw INVALID(`${what} must be plain JSON`);
  if (byteLength(json) > MAX_ARG_BYTES) {
    throw INVALID(`${what} is larger than ${MAX_ARG_BYTES} bytes`);
  }
}

function walk(value: unknown, what: string, depth: number, seen: Set<unknown>): void {
  if (depth > MAX_ARG_DEPTH) throw INVALID(`${what} is deeper than ${MAX_ARG_DEPTH} levels`);
  if (value === null) return;
  const type = typeof value;
  if (type === "string" || type === "boolean") return;
  if (type === "number") {
    if (!Number.isFinite(value)) throw INVALID(`${what} holds a number JSON cannot carry`);
    return;
  }
  if (type !== "object") throw INVALID(`${what} holds a ${type}, which is not JSON`);
  if (seen.has(value)) throw INVALID(`${what} is cyclic`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_CONTAINER_ENTRIES) {
      throw INVALID(`${what} holds a list of more than ${MAX_CONTAINER_ENTRIES} items`);
    }
    for (const item of value) walk(item, what, depth + 1, seen);
  } else {
    if (!isPlainObject(value)) throw INVALID(`${what} holds a value that is not plain JSON`);
    const keys = Object.keys(value);
    if (keys.length > MAX_CONTAINER_ENTRIES) {
      throw INVALID(`${what} holds an object with more than ${MAX_CONTAINER_ENTRIES} keys`);
    }
    for (const key of keys) walk((value as Record<string, unknown>)[key], what, depth + 1, seen);
  }
  seen.delete(value);
}

function checkBody(body: unknown, verb: string): Record<string, unknown> {
  if (!isPlainObject(body)) {
    throw INVALID(`${verb} takes a plain object body`);
  }
  checkArgument(body, "the document body");
  return body;
}

/* ------------------------------------------------------------------ */
/* snapshots                                                           */
/* ------------------------------------------------------------------ */

export interface SnapshotMetadata {
  fromCache: boolean;
  hasPendingWrites: boolean;
}

export interface DocumentSnapshot {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
  metadata: SnapshotMetadata;
}

export interface DocumentChange {
  type: "added" | "modified" | "removed";
  doc: DocumentSnapshot;
  oldIndex: number;
  newIndex: number;
}

export interface QuerySnapshot {
  docs: DocumentSnapshot[];
  size: number;
  empty: boolean;
  docChanges(): DocumentChange[];
  metadata: SnapshotMetadata;
}

const METADATA_CACHE = new Map<string, SnapshotMetadata>();

function metadataOf(fromCache: boolean, hasPendingWrites: boolean): SnapshotMetadata {
  const key = `${fromCache ? 1 : 0}${hasPendingWrites ? 1 : 0}`;
  let meta = METADATA_CACHE.get(key);
  if (!meta) {
    meta = Object.freeze({ fromCache, hasPendingWrites });
    METADATA_CACHE.set(key, meta);
  }
  return meta;
}

/** Delivered bodies are frozen: the page must clone before editing one. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return value;
}

function makeSnapshot(
  id: string,
  data: Record<string, unknown> | undefined,
  metadata: SnapshotMetadata,
): DocumentSnapshot {
  const body = data === undefined ? undefined : deepFreeze(data);
  return Object.freeze({
    id,
    exists: body !== undefined,
    data: () => body,
    metadata,
  });
}

/**
 * The same document under a fresh delivery's metadata. The body object is
 * reused, so `data()` identity (and `===` on the body) survives, while
 * `metadata.fromCache` tracks the delivery that is actually being reported.
 */
export function withMetadata(
  snap: DocumentSnapshot,
  metadata: SnapshotMetadata,
): DocumentSnapshot {
  if (snap.metadata === metadata) return snap;
  return makeSnapshot(snap.id, snap.data(), metadata);
}

function makeQuerySnapshot(
  docs: DocumentSnapshot[],
  changes: DocumentChange[],
  metadata: SnapshotMetadata,
): QuerySnapshot {
  const frozenDocs = Object.freeze(docs) as DocumentSnapshot[];
  const frozenChanges = Object.freeze(changes) as DocumentChange[];
  return Object.freeze({
    docs: frozenDocs,
    size: frozenDocs.length,
    empty: frozenDocs.length === 0,
    docChanges: () => frozenChanges,
    metadata,
  });
}

/* ------------------------------------------------------------------ */
/* the mirror                                                          */
/* ------------------------------------------------------------------ */

export interface SnapshotOp {
  type: "added" | "modified" | "removed";
  id: string;
  data?: Record<string, unknown>;
  oldIndex: number;
  newIndex: number;
}

export interface MirrorEntry {
  id: string;
  snap: DocumentSnapshot;
}

function clampIndex(index: unknown, max: number): number {
  if (typeof index !== "number" || !Number.isFinite(index)) return max;
  return Math.min(Math.max(Math.trunc(index), 0), max);
}

/**
 * Apply one delivery's ops to the mirror, in order, and report the changes.
 * `removed` carries the last snapshot the listener saw, so a removal handler
 * still has the document body.
 */
export function applyOps(
  mirror: MirrorEntry[],
  ops: readonly SnapshotOp[],
  metadata: SnapshotMetadata,
): DocumentChange[] {
  const changes: DocumentChange[] = [];
  for (const op of ops) {
    if (!op || typeof op.id !== "string") continue;
    if (op.type === "removed") {
      const at = clampIndex(op.oldIndex, mirror.length - 1);
      const entry = mirror[at]?.id === op.id ? mirror[at] : mirror.find((e) => e.id === op.id);
      if (!entry) continue;
      mirror.splice(mirror.indexOf(entry), 1);
      changes.push(Object.freeze({ type: "removed" as const, doc: entry.snap, oldIndex: at, newIndex: -1 }));
      continue;
    }
    if (op.type === "added") {
      const snap = makeSnapshot(op.id, op.data ?? {}, metadata);
      const at = clampIndex(op.newIndex, mirror.length);
      mirror.splice(at, 0, { id: op.id, snap });
      changes.push(Object.freeze({ type: "added" as const, doc: snap, oldIndex: -1, newIndex: at }));
      continue;
    }
    if (op.type === "modified") {
      const from = mirror.findIndex((entry) => entry.id === op.id);
      if (from >= 0) mirror.splice(from, 1);
      const snap = makeSnapshot(op.id, op.data ?? {}, metadata);
      const at = clampIndex(op.newIndex, mirror.length);
      mirror.splice(at, 0, { id: op.id, snap });
      changes.push(
        Object.freeze({ type: "modified" as const, doc: snap, oldIndex: from < 0 ? at : from, newIndex: at }),
      );
    }
  }
  return changes;
}

/* ------------------------------------------------------------------ */
/* queries                                                             */
/* ------------------------------------------------------------------ */

interface WhereInput {
  field: unknown;
  op: unknown;
  value: unknown;
}

interface QueryState {
  where: WhereInput[];
  order: Array<{ field: unknown; dir?: unknown }>;
  limit?: unknown;
}

export interface QueryDesc {
  collection: string;
  where?: Array<{ f: string; op: string; v: unknown }>;
  orderBy?: { f: string; dir: "asc" | "desc" };
  limit?: number;
}

/** Builders are pure; a bad query is refused here, at the terminal call. */
export function buildQueryDesc(collection: string, state: QueryState): QueryDesc {
  const desc: QueryDesc = { collection };
  if (state.where.length > MAX_WHERE) {
    throw INVALID(`a query takes at most ${MAX_WHERE} filters`);
  }
  if (state.where.length > 0) {
    desc.where = state.where.map((clause) => {
      if (typeof clause.field !== "string" || clause.field.length === 0) {
        throw INVALID("where() needs a field name");
      }
      if (typeof clause.op !== "string" || !OPERATORS.includes(clause.op)) {
        throw INVALID(`where() operator must be one of ${OPERATORS.join(", ")}`);
      }
      if (clause.op === "in" || clause.op === "not-in") {
        if (!Array.isArray(clause.value)) {
          throw INVALID(`the ${clause.op} operator takes an array of values`);
        }
        if (clause.value.length > MAX_IN_VALUES) {
          throw INVALID(`the ${clause.op} operator takes at most ${MAX_IN_VALUES} values`);
        }
      }
      checkArgument(clause.value, "a filter value");
      return { f: clause.field, op: clause.op, v: clause.value };
    });
  }
  if (state.order.length > 1) {
    throw INVALID("a query takes at most one orderBy");
  }
  const order = state.order[0];
  if (order) {
    if (typeof order.field !== "string" || order.field.length === 0) {
      throw INVALID("orderBy() needs a field name");
    }
    const dir = order.dir === undefined ? "asc" : order.dir;
    if (dir !== "asc" && dir !== "desc") {
      throw INVALID('orderBy() direction must be "asc" or "desc"');
    }
    desc.orderBy = { f: order.field, dir };
  }
  if (state.limit !== undefined) {
    const limit = state.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw INVALID(`limit() takes an integer between 1 and ${MAX_LIMIT}`);
    }
    desc.limit = limit;
  }
  return desc;
}

/* ------------------------------------------------------------------ */
/* installation                                                        */
/* ------------------------------------------------------------------ */

type Unsubscribe = () => void;

interface Sub {
  subId: string;
  kind: "doc" | "query";
  docId: string;
  next: (snap: unknown) => void;
  error?: (e: CapError) => void;
  mirror: MirrorEntry[];
  dead: boolean;
}

function isDbEvent(data: unknown): data is { __frame_db_ev: true; ev: Record<string, unknown> } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { __frame_db_ev?: unknown }).__frame_db_ev === true &&
    typeof (data as { ev?: unknown }).ev === "object" &&
    (data as { ev: unknown }).ev !== null
  );
}

function report(error: CapError): void {
  const reporter = (globalThis as { reportError?: (e: unknown) => void }).reportError;
  if (typeof reporter === "function") reporter(error);
  else console.error(error);
}

export function install(ctx: FrameContext): void {
  if (!ctx.capabilities[CAP]) return;

  const rpc: RpcClient = createRpc({
    cap: CAP,
    shellOrigin: ctx.shellOrigin,
    // "no reply from shell" is a transient platform condition for db.
    onTimeout: () => capError("unavailable", "the store did not answer"),
  });
  const pipe = ctx.pipe(CAP);
  const subs = new Map<string, Sub>();
  let revoked = false;

  /* ------------------------------ delivery ----------------------------- */

  const terminate = (sub: Sub, error: CapError): void => {
    if (sub.dead) return;
    sub.dead = true;
    subs.delete(sub.subId);
    if (sub.error) {
      try {
        sub.error(error);
      } catch {
        /* the page's own handler threw; the listener still dies */
      }
    } else {
      report(error);
    }
  };

  const onSnapshotEvent = (ev: Record<string, unknown>): void => {
    const sub = subs.get(String(ev.subId));
    if (!sub || sub.dead) return;
    const metadata = metadataOf(ev.fromCache === true, ev.hasPendingWrites === true);
    const ops = Array.isArray(ev.ops) ? (ev.ops as SnapshotOp[]) : [];
    const changes = applyOps(sub.mirror, ops, metadata);
    try {
      if (sub.kind === "doc") {
        const entry = sub.mirror[0];
        const snap = entry
          ? withMetadata(entry.snap, metadata)
          : makeSnapshot(sub.docId, undefined, metadata);
        sub.next(snap);
      } else {
        const docs = sub.mirror.map((entry) => entry.snap);
        sub.next(makeQuerySnapshot(docs, changes, metadata));
      }
    } catch (err) {
      // A throwing `next` is the page's problem, not the subscription's.
      report(capError("invalid_argument", `an onSnapshot handler threw: ${String(err)}`));
    }
  };

  const host = browserRpcHost(ctx.shellOrigin);
  host.listen((ev) => {
    if (!host.accepts(ev)) return;
    if (!isDbEvent(ev.data)) return;
    const event = ev.data.ev;
    if (event.type === "revoked") {
      revoked = true;
      const error = capError("revoked", "this view's access to the store was withdrawn");
      for (const sub of [...subs.values()]) terminate(sub, error);
      return;
    }
    if (event.type === "error") {
      const sub = subs.get(String(event.subId));
      const code = typeof event.code === "string" ? event.code : "unavailable";
      // `unavailable` on a live subscription is handled by the shell (it
      // falls back to periodic refresh), so it never reaches the page.
      if (!sub || code === "unavailable") return;
      terminate(
        sub,
        capError(code, typeof event.message === "string" ? event.message : "the store refused"),
      );
      return;
    }
    if (event.type === "snapshot") onSnapshotEvent(event);
  });

  /* ------------------------------- verbs ------------------------------- */

  const guard = (): void => {
    if (revoked) throw capError("revoked", "this view's access to the store was withdrawn");
  };

  const docGet = pipe.wrap("get", async (path: string): Promise<DocumentSnapshot> => {
    guard();
    const result = await rpc.call<{ id?: string; exists?: boolean; data?: Record<string, unknown> }>(
      "get",
      [{ path }],
    );
    const id = typeof result?.id === "string" ? result.id : lastSegment(path);
    const metadata = metadataOf(false, false);
    return result?.exists === true
      ? makeSnapshot(id, result.data ?? {}, metadata)
      : makeSnapshot(id, undefined, metadata);
  });

  const docSet = pipe.wrap("set", async (path: string, data: unknown): Promise<void> => {
    guard();
    await rpc.call("set", [{ path }, checkBody(data, "set")]);
  });

  const docUpdate = pipe.wrap("update", async (path: string, data: unknown): Promise<void> => {
    guard();
    await rpc.call("update", [{ path }, checkBody(data, "update")]);
  });

  const docDelete = pipe.wrap("delete", async (path: string): Promise<void> => {
    guard();
    await rpc.call("delete", [{ path }]);
  });

  const docAcquire = pipe.wrap("acquire", async (path: string, options: unknown) => {
    guard();
    if (!isPlainObject(options) || typeof options.holder !== "string" || options.holder.length === 0) {
      throw INVALID("acquire needs a holder string");
    }
    if (options.ttlMs !== undefined && typeof options.ttlMs !== "number") {
      throw INVALID("ttlMs must be a number of milliseconds");
    }
    if (options.data !== undefined) checkBody(options.data, "acquire");
    checkArgument(options, "the acquire options");
    return rpc.call("acquire", [{ path }, options]);
  });

  const queryGet = pipe.wrap("query", async (collection: string, state: QueryState): Promise<QuerySnapshot> => {
    guard();
    const desc = buildQueryDesc(collection, state);
    const result = await rpc.call<{ docs?: Array<{ id: string; data: Record<string, unknown> }> }>(
      "query",
      [desc],
    );
    const metadata = metadataOf(false, false);
    const rows = Array.isArray(result?.docs) ? result.docs : [];
    const docs = rows.map((row) => makeSnapshot(String(row.id), row.data ?? {}, metadata));
    const changes = docs.map((doc, index) =>
      Object.freeze({ type: "added" as const, doc, oldIndex: -1, newIndex: index }),
    );
    return makeQuerySnapshot(docs, changes, metadata);
  });

  /* ---------------------------- subscriptions --------------------------- */

  const startSub = (
    kind: "doc" | "query",
    docId: string,
    spec: unknown,
    next: unknown,
    error: unknown,
  ): Unsubscribe => {
    const errorCb = typeof error === "function" ? (error as (e: CapError) => void) : undefined;
    const fail = (e: CapError): Unsubscribe => {
      // onSnapshot returns synchronously, so a refusal is delivered after it.
      queueMicrotask(() => {
        if (errorCb) errorCb(e);
        else report(e);
      });
      return () => undefined;
    };

    if (revoked) {
      return fail(capError("revoked", "this view's access to the store was withdrawn"));
    }
    if (typeof next !== "function") {
      return fail(INVALID("onSnapshot needs a callback"));
    }
    if (subs.size >= MAX_SUBSCRIPTIONS) {
      return fail(
        capError(
          "resource_exhausted",
          `this view already has ${MAX_SUBSCRIPTIONS} active subscriptions`,
        ),
      );
    }

    const subId = mintDocId();
    const sub: Sub = {
      subId,
      kind,
      docId,
      next: next as (snap: unknown) => void,
      ...(errorCb ? { error: errorCb } : {}),
      mirror: [],
      dead: false,
    };
    subs.set(subId, sub);

    rpc.call("subscribe", [subId, spec]).catch((err: unknown) => {
      const e: CapError =
        typeof err === "object" && err !== null && typeof (err as CapError).code === "string"
          ? (err as CapError)
          : capError("unavailable", "the store did not answer");
      if (e.code === "revoked") revoked = true;
      terminate(sub, e);
    });

    return () => {
      if (sub.dead) return;
      sub.dead = true;
      subs.delete(subId);
      void rpc.call("unsubscribe", [subId]).catch(() => undefined);
    };
  };

  // A page that goes away releases its subscriptions, exactly as the
  // platform's module does; the shell drops the lane with the view anyway.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", () => {
      for (const sub of [...subs.values()]) {
        sub.dead = true;
        subs.delete(sub.subId);
        void rpc.call("unsubscribe", [sub.subId]).catch(() => undefined);
      }
    });
  }

  /* -------------------------------- refs ------------------------------- */

  const makeQuery = (collection: string, state: QueryState): object => {
    const extend = (patch: Partial<QueryState>): object =>
      makeQuery(collection, { ...state, ...patch });

    const query = {
      where(field: unknown, op: unknown, value: unknown) {
        return extend({ where: [...state.where, { field, op, value }] });
      },
      orderBy(field: unknown, dir?: unknown) {
        return extend({ order: [...state.order, { field, dir }] });
      },
      limit(n: unknown) {
        return extend({ limit: n });
      },
      get: () => queryGet(collection, state),
      onSnapshot(next: unknown, error?: unknown): Unsubscribe {
        let desc: QueryDesc;
        try {
          desc = buildQueryDesc(collection, state);
        } catch (err) {
          const e = err as CapError;
          const cb = typeof error === "function" ? (error as (x: CapError) => void) : undefined;
          queueMicrotask(() => (cb ? cb(e) : report(e)));
          return () => undefined;
        }
        return startSub("query", collection, desc, next, error);
      },
    };
    return Object.freeze(query);
  };

  const makeDoc = (path: string): object => {
    const doc = {
      id: lastSegment(path),
      path,
      get: () => docGet(path),
      set: (data: unknown) => docSet(path, data),
      update: (data: unknown) => docUpdate(path, data),
      delete: () => docDelete(path),
      acquire: (options: unknown) => docAcquire(path, options),
      onSnapshot(next: unknown, error?: unknown): Unsubscribe {
        return startSub("doc", lastSegment(path), { path }, next, error);
      },
      collection(sub: unknown) {
        const relative = assertPathFragment("DocumentReference.collection", sub);
        return makeCollection(assertPath("DocumentReference.collection", `${path}/${relative}`, "collection"));
      },
    };
    return Object.freeze(doc);
  };

  const makeCollection = (path: string): object => {
    const base = makeQuery(path, { where: [], order: [] }) as Record<string, unknown>;
    const collection = {
      ...base,
      path,
      doc(id?: unknown) {
        const segment = id === undefined ? mintDocId() : assertPathFragment("CollectionReference.doc", id);
        return makeDoc(assertPath("CollectionReference.doc", `${path}/${segment}`, "document"));
      },
      add: pipe.wrap("add", async (data: unknown) => {
        const ref = collection.doc() as { set(d: unknown): Promise<void> };
        await ref.set(data);
        return ref;
      }),
    };
    return Object.freeze(collection);
  };

  /** A relative fragment must itself be a run of valid segments. */
  function assertPathFragment(where: string, value: unknown): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`${where}: the path must be a non-empty string`);
    }
    for (const [index, seg] of splitPath(value).entries()) {
      if (!isPathSegment(seg)) {
        throw new TypeError(
          `${where}: segment ${index + 1} ("${seg}") may use only letters, digits and _ - . ~ : @ +`,
        );
      }
    }
    return value;
  }

  const namespace = {
    doc(path: unknown) {
      return makeDoc(assertPath("db.doc", path, "document"));
    },
    collection(path: unknown) {
      return makeCollection(assertPath("db.collection", path, "collection"));
    },
  };

  ctx.mount(CAP, namespace);
}
