/**
 * `db` broker: the shell half of the store.
 *
 * Verbs are one same-origin POST each (the viewer cookie is the credential,
 * and no token ever reaches the frame). Subscriptions are kept here: the
 * broker holds a mirror of every subscription's rows, opens ONE websocket
 * lane per view for realtime rows, and turns each new row set into the
 * `added`/`modified`/`removed` ops the frame replays against its own mirror.
 *
 * The lane is best-effort. When it is not connected the same mirrors are
 * refreshed on a timer over HTTP and the snapshots go out with
 * `fromCache: true`, which is exactly what the contract promises: delivery
 * "rides a realtime stream when available and falls back to periodic
 * refresh - same callbacks either way".
 */
import { capError, toCapError } from "../../protocol/errors.ts";
import type { BrokerCall, BrokerContext } from "../../shell/types.ts";
import { matchesWhere, mergeDeep, orderRows } from "./query.ts";
import type { QuerySpec } from "./store.ts";

/** Foreground refresh cadence while the lane is down (db.d.ts: about 30 s). */
const REFRESH_MS = 30_000;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;
/** At most 64 live subscriptions per view (db.d.ts); the frame agrees. */
const MAX_SUBSCRIPTIONS = 64;

export interface DocRow {
  id: string;
  data: Record<string, unknown>;
}

export interface SnapshotOp {
  type: "added" | "modified" | "removed";
  id: string;
  data?: Record<string, unknown>;
  oldIndex: number;
  newIndex: number;
}

type SubscribeSpec = { path: string } | Record<string, unknown>;

/** What `acquire` resolves with (db.d.ts `AcquireResult`). */
export interface AcquireResult {
  acquired: boolean;
  version?: number;
  expiresAt?: string;
  holder?: string;
}

interface SubState {
  subId: string;
  spec: SubscribeSpec;
  grant: string | null;
  /** The rows the frame's mirror currently holds, in order. */
  mirror: DocRow[];
  delivered: boolean;
  fromCache: boolean;
  /** `hasPendingWrites` of the last delivery, so the flag clearing is one. */
  pending: boolean;
  /** The view clock of the newest delivery applied to `mirror`. */
  appliedAt: number;
}

interface ViewState {
  subs: Map<string, SubState>;
  socket: WebSocket | null;
  connected: boolean;
  /** Writes this view has in flight (latency compensation metadata). */
  pendingWrites: number;
  revoked: boolean;
  disposed: boolean;
  /**
   * Monotonic per view: every fetch and every lane push takes a stamp when it
   * is ISSUED, so a slow HTTP refresh can never move a mirror backwards over
   * a lane push that landed while it was in flight.
   */
  clock: number;
  refreshTimer: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
}

const VIEWS = new WeakMap<BrokerContext, ViewState>();

function stateFor(ctx: BrokerContext): ViewState {
  let state = VIEWS.get(ctx);
  if (!state) {
    state = {
      subs: new Map(),
      socket: null,
      connected: false,
      pendingWrites: 0,
      revoked: false,
      disposed: false,
      clock: 0,
      refreshTimer: null,
      reconnectTimer: null,
      backoffMs: RECONNECT_MIN_MS,
    };
    VIEWS.set(ctx, state);
  }
  return state;
}

/* ------------------------------------------------------------------ */
/* the mirror diff                                                     */
/* ------------------------------------------------------------------ */

/**
 * Turn "these are the rows now" into the index-based splices the frame
 * applies to its mirror: removals first (from the end, so every index is
 * still valid when it is applied), then additions and moves in target order.
 * Replaying these ops against `previous` yields exactly `next`.
 */
export function diffRows(previous: readonly DocRow[], next: readonly DocRow[]): SnapshotOp[] {
  const work = previous.map((row) => ({ id: row.id, json: JSON.stringify(row.data) }));
  const wanted = new Set(next.map((row) => row.id));
  const ops: SnapshotOp[] = [];

  for (let i = work.length - 1; i >= 0; i--) {
    const entry = work[i];
    if (!entry || wanted.has(entry.id)) continue;
    ops.push({ type: "removed", id: entry.id, oldIndex: i, newIndex: -1 });
    work.splice(i, 1);
  }

  for (let i = 0; i < next.length; i++) {
    const row = next[i];
    if (!row) continue;
    const json = JSON.stringify(row.data);
    const at = work.findIndex((entry) => entry.id === row.id);
    if (at === -1) {
      work.splice(i, 0, { id: row.id, json });
      ops.push({ type: "added", id: row.id, data: row.data, oldIndex: -1, newIndex: i });
      continue;
    }
    const entry = work[at]!;
    if (at === i && entry.json === json) continue;
    work.splice(at, 1);
    entry.json = json;
    work.splice(i, 0, entry);
    ops.push({ type: "modified", id: row.id, data: row.data, oldIndex: at, newIndex: i });
  }
  return ops;
}

/* ------------------------------------------------------------------ */
/* latency compensation                                                */
/* ------------------------------------------------------------------ */

/** One of this page's writes, in the shape the mirror has to see it. */
export type LocalWrite =
  | { verb: "set"; path: string; body: unknown }
  | { verb: "update"; path: string; body: unknown }
  | { verb: "delete"; path: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `me` is resolved server-side, and a subscription's spec comes back
 * resolved, so a page's own private path is matched in both forms.
 */
function variants(path: string, viewerId: string): string[] {
  const resolved = path
    .split("/")
    .map((segment) => (segment === "me" ? viewerId : segment))
    .join("/");
  return resolved === path ? [path] : [path, resolved];
}

/**
 * Apply one of this page's writes to one subscription's rows, so the writer
 * sees it at once — db.d.ts: "Your own writes appear immediately
 * (`hasPendingWrites: true` until confirmed)". `null` means the write does
 * not belong to this subscription, or cannot be placed faithfully; that
 * subscription just waits for the confirming refresh. Filters and ordering
 * are the server's own (`query.ts`), so the optimistic view is the view the
 * confirmation will bring, and a refusal is rolled back by the same refresh.
 */
export function applyLocalWrite(
  rows: readonly DocRow[],
  spec: SubscribeSpec,
  write: LocalWrite,
  viewerId: string,
): DocRow[] | null {
  const cut = write.path.lastIndexOf("/");
  if (cut <= 0 || cut === write.path.length - 1) return null;
  const id = write.path.slice(cut + 1);
  const current = rows.find((row) => row.id === id) ?? null;

  let next: Record<string, unknown> | null;
  if (write.verb === "delete") {
    next = null;
  } else if (write.verb === "set") {
    if (!isRecord(write.body)) return null; // the server will refuse it
    next = write.body;
  } else {
    // `update` needs the document that is being merged into: an `update`
    // against rows this view does not hold would be inventing one.
    if (current === null || !isRecord(write.body)) return null;
    next = mergeDeep(current.data, write.body);
  }

  const target = spec as { path?: unknown; collection?: unknown };
  if (typeof target.path === "string") {
    if (!variants(write.path, viewerId).includes(target.path)) return null;
    return next === null ? [] : [{ id, data: next }];
  }
  if (
    typeof target.collection !== "string" ||
    !variants(write.path.slice(0, cut), viewerId).includes(target.collection)
  ) {
    return null;
  }
  const query = spec as unknown as QuerySpec;
  const kept = rows.filter((row) => row.id !== id);
  if (next !== null && (query.where ?? []).every((clause) => matchesWhere(next, clause))) {
    kept.push({ id, data: next });
  }
  return orderRows(kept, query);
}

/* ------------------------------------------------------------------ */
/* delivery                                                            */
/* ------------------------------------------------------------------ */

function pushEvent(ctx: BrokerContext, ev: unknown): void {
  ctx.toFrame({ __frame_db_ev: true, ev });
}

function deliver(
  ctx: BrokerContext,
  state: ViewState,
  sub: SubState,
  rows: DocRow[],
  stamp: number,
): void {
  // An older delivery (an HTTP refresh overtaken by a lane push) is dropped.
  if (stamp < sub.appliedAt) return;
  sub.appliedAt = stamp;
  const fromCache = !state.connected;
  const hasPendingWrites = state.pendingWrites > 0;
  const ops = diffRows(sub.mirror, rows);
  // Nothing changed and nothing about the delivery changed: stay quiet. The
  // metadata counts as a change: the delivery that confirms a write usually
  // carries no ops (the rows already match the optimistic ones), and it is
  // the only one that can drop `hasPendingWrites` back to false.
  if (
    ops.length === 0 &&
    sub.delivered &&
    sub.fromCache === fromCache &&
    sub.pending === hasPendingWrites
  ) {
    return;
  }
  sub.mirror = rows;
  sub.delivered = true;
  sub.fromCache = fromCache;
  sub.pending = hasPendingWrites;
  pushEvent(ctx, {
    type: "snapshot",
    subId: sub.subId,
    fromCache,
    hasPendingWrites,
    ops,
  });
}

function failSub(ctx: BrokerContext, state: ViewState, subId: string, err: unknown): void {
  const error = toCapError(err, "unavailable");
  // `unavailable` is handled internally: the lane retries and the refresh
  // timer keeps the listener alive, so the page never sees it.
  if (error.code === "unavailable") return;
  state.subs.delete(subId);
  // The server keeps re-evaluating a subscription nobody dropped for it.
  sendLane(state, { kind: "unsub", subId });
  stopRefreshTimerIfIdle(state);
  pushEvent(ctx, { type: "error", subId, code: error.code, message: error.message });
}

function revoke(ctx: BrokerContext, state: ViewState): void {
  if (state.revoked) return;
  state.revoked = true;
  state.subs.clear();
  stopRefreshTimerIfIdle(state);
  closeLane(state);
  pushEvent(ctx, { type: "revoked" });
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function callPath(ctx: BrokerContext): string {
  return `/api/frame/db/${ctx.boot.artifactId}/call`;
}

function post<T>(ctx: BrokerContext, path: string, body: unknown): Promise<T> {
  return ctx.api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

async function fetchRows(ctx: BrokerContext, sub: SubState): Promise<DocRow[]> {
  if ("path" in sub.spec && typeof sub.spec.path === "string") {
    const result = await post<{ id: string; exists: boolean; data?: Record<string, unknown> }>(
      ctx,
      callPath(ctx),
      { verb: "get", path: sub.spec.path },
    );
    return result.exists && result.data ? [{ id: result.id, data: result.data }] : [];
  }
  const result = await post<{ docs: DocRow[] }>(ctx, callPath(ctx), {
    verb: "query",
    spec: sub.spec,
  });
  return Array.isArray(result.docs) ? result.docs : [];
}

async function refresh(ctx: BrokerContext, state: ViewState, sub: SubState): Promise<void> {
  const stamp = ++state.clock;
  try {
    const rows = await fetchRows(ctx, sub);
    if (state.disposed || !state.subs.has(sub.subId)) return;
    deliver(ctx, state, sub, rows, stamp);
  } catch (err) {
    const error = toCapError(err, "unavailable");
    if (error.code === "revoked") {
      revoke(ctx, state);
      return;
    }
    failSub(ctx, state, sub.subId, error);
  }
}

function refreshAll(ctx: BrokerContext, state: ViewState): void {
  for (const sub of [...state.subs.values()]) void refresh(ctx, state, sub);
}

/** Deliver this view's own write to every subscription that holds it. */
function applyOptimistic(ctx: BrokerContext, state: ViewState, write: LocalWrite): void {
  const viewerId = ctx.viewer.id;
  const stamp = ++state.clock;
  for (const sub of [...state.subs.values()]) {
    const rows = applyLocalWrite(sub.mirror, sub.spec, write, viewerId);
    if (rows !== null) deliver(ctx, state, sub, rows, stamp);
  }
}

function startRefreshTimer(ctx: BrokerContext, state: ViewState): void {
  if (state.refreshTimer !== null) return;
  state.refreshTimer = setInterval(() => {
    if (state.disposed || state.connected || state.subs.size === 0) return;
    refreshAll(ctx, state);
  }, REFRESH_MS);
}

/** Nothing left to refresh: stop waking the tab until the next subscribe. */
function stopRefreshTimerIfIdle(state: ViewState): void {
  if (state.subs.size > 0 || state.refreshTimer === null) return;
  clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

/* ------------------------------------------------------------------ */
/* the realtime lane                                                   */
/* ------------------------------------------------------------------ */

function laneUrl(ctx: BrokerContext): string | null {
  if (typeof location === "undefined" || typeof WebSocket === "undefined") return null;
  const url = new URL("/api/frame/db/ws", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("artifact", ctx.boot.artifactId);
  return url.href;
}

function closeLane(state: ViewState): void {
  state.connected = false;
  if (state.reconnectTimer !== null) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  const socket = state.socket;
  state.socket = null;
  if (socket) {
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    try {
      socket.close();
    } catch {
      /* already gone */
    }
  }
}

function sendLane(state: ViewState, message: unknown): boolean {
  const socket = state.socket;
  if (!socket || !state.connected) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function registerSub(state: ViewState, sub: SubState): void {
  if (sub.grant === null) return;
  sendLane(state, { kind: "sub", subId: sub.subId, grant: sub.grant });
}

function ensureLane(ctx: BrokerContext, state: ViewState): void {
  if (state.disposed || state.revoked || state.socket !== null) return;
  const url = laneUrl(ctx);
  if (url === null) return;
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch {
    return;
  }
  state.socket = socket;
  socket.onopen = () => {
    if (state.socket !== socket) return;
    state.connected = true;
    state.backoffMs = RECONNECT_MIN_MS;
    for (const sub of state.subs.values()) registerSub(state, sub);
  };
  socket.onmessage = (event: MessageEvent) => {
    if (state.socket !== socket) return;
    let message: { kind?: unknown; subId?: unknown; docs?: unknown; code?: unknown; message?: unknown };
    try {
      message = JSON.parse(String(event.data)) as typeof message;
    } catch {
      return;
    }
    if (message.kind === "revoked") {
      revoke(ctx, state);
      return;
    }
    if (typeof message.subId !== "string") return;
    const sub = state.subs.get(message.subId);
    if (!sub) return;
    if (message.kind === "rows" && Array.isArray(message.docs)) {
      deliver(ctx, state, sub, message.docs as DocRow[], ++state.clock);
      return;
    }
    if (message.kind === "error") {
      failSub(ctx, state, sub.subId, {
        code: typeof message.code === "string" ? message.code : "unavailable",
        message: typeof message.message === "string" ? message.message : "the store refused",
      });
    }
  };
  const dropped = (): void => {
    if (state.socket !== socket) return;
    state.socket = null;
    state.connected = false;
    if (state.disposed || state.revoked) return;
    // A dropped lane is not a subscription error: fall back to refresh and
    // reconnect. The next delivery simply carries `fromCache: true`.
    refreshAll(ctx, state);
    const wait = state.backoffMs;
    state.backoffMs = Math.min(RECONNECT_MAX_MS, state.backoffMs * 2);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (state.subs.size > 0) ensureLane(ctx, state);
    }, wait);
  };
  socket.onclose = dropped;
  socket.onerror = dropped;
}

/* ------------------------------------------------------------------ */
/* the broker                                                          */
/* ------------------------------------------------------------------ */

async function subscribe(
  ctx: BrokerContext,
  state: ViewState,
  args: unknown[],
): Promise<undefined> {
  const subId = args[0];
  const spec = args[1];
  if (typeof subId !== "string" || subId.length === 0 || subId.length > 64) {
    throw capError("invalid_argument", "a subscription needs an id");
  }
  if (typeof spec !== "object" || spec === null) {
    throw capError("invalid_argument", "a subscription needs a path or a collection");
  }
  if (!state.subs.has(subId) && state.subs.size >= MAX_SUBSCRIPTIONS) {
    throw capError(
      "resource_exhausted",
      `this view already has ${MAX_SUBSCRIPTIONS} active subscriptions`,
    );
  }
  const sub: SubState = {
    subId,
    spec: spec as SubscribeSpec,
    grant: null,
    mirror: [],
    delivered: false,
    fromCache: true,
    pending: false,
    appliedAt: 0,
  };
  state.subs.set(subId, sub);
  let granted: { grant: string; spec: SubscribeSpec };
  try {
    granted = await post<{ grant: string; spec: SubscribeSpec }>(
      ctx,
      `/api/frame/db/${ctx.boot.artifactId}/subscribe`,
      // The grant is minted for THIS subscription id and opens no other.
      { spec, subId },
    );
  } catch (err) {
    state.subs.delete(subId);
    stopRefreshTimerIfIdle(state);
    const error = toCapError(err, "unavailable");
    if (error.code === "revoked") revoke(ctx, state);
    throw error;
  }
  if (state.disposed || !state.subs.has(subId)) return undefined;
  sub.grant = granted.grant;
  // The server hands back the normalised spec (`me` resolved, defaults
  // filled in); refreshes must use exactly what the lane subscribed to.
  if (granted.spec && typeof granted.spec === "object") sub.spec = granted.spec;

  startRefreshTimer(ctx, state);
  if (state.connected) {
    registerSub(state, sub);
  } else {
    ensureLane(ctx, state);
    await refresh(ctx, state, sub);
  }
  return undefined;
}

export async function handle(call: BrokerCall, ctx: BrokerContext): Promise<unknown> {
  const state = stateFor(ctx);
  if (state.revoked) {
    throw capError("revoked", "this view's access to the store was withdrawn");
  }

  const path = (): string => {
    const spec = call.args[0];
    if (typeof spec !== "object" || spec === null || typeof (spec as { path?: unknown }).path !== "string") {
      throw capError("invalid_argument", "a path is required");
    }
    return (spec as { path: string }).path;
  };

  /** Any refusal that says the grant is gone revokes the whole view. */
  const request = async <T>(body: Record<string, unknown>): Promise<T> => {
    try {
      return await post<T>(ctx, callPath(ctx), body);
    } catch (err) {
      const error = toCapError(err, "unavailable");
      if (error.code === "revoked") revoke(ctx, state);
      throw error;
    }
  };

  const write = async <T>(body: Record<string, unknown>, local?: LocalWrite): Promise<T> => {
    state.pendingWrites++;
    // The writer sees its own write at once, marked `hasPendingWrites`,
    // instead of waiting for the round trip.
    if (local) applyOptimistic(ctx, state, local);
    try {
      return await request<T>(body);
    } finally {
      state.pendingWrites--;
      // The confirming pass, which also rolls an optimistic row back when the
      // server refused the write, and clears `hasPendingWrites`.
      refreshAll(ctx, state);
    }
  };

  switch (call.method) {
    case "get":
      return request({ verb: "get", path: path() });
    // A write resolves with nothing: `set`, `update` and `delete` are void.
    case "set": {
      const body = { verb: "set" as const, path: path(), body: call.args[1] };
      return write(body, body).then(() => undefined);
    }
    case "update": {
      const body = { verb: "update" as const, path: path(), body: call.args[1] };
      return write(body, body).then(() => undefined);
    }
    case "delete": {
      const body = { verb: "delete" as const, path: path() };
      return write(body, body).then(() => undefined);
    }
    case "acquire":
      return write<AcquireResult>({ verb: "acquire", path: path(), options: call.args[1] });
    case "query":
      return request({ verb: "query", spec: call.args[0] });
    case "subscribe":
      return subscribe(ctx, state, call.args);
    case "unsubscribe": {
      const subId = call.args[0];
      if (typeof subId === "string") {
        state.subs.delete(subId);
        sendLane(state, { kind: "unsub", subId });
        stopRefreshTimerIfIdle(state);
      }
      return undefined;
    }
    default:
      throw capError("capability_removed", `db.${call.method} is not part of this runtime`);
  }
}

export function dispose(ctx: BrokerContext): void {
  const state = VIEWS.get(ctx);
  if (!state) return;
  state.disposed = true;
  state.subs.clear();
  closeLane(state);
  if (state.refreshTimer !== null) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}
