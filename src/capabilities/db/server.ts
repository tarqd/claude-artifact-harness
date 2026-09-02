/**
 * `db` backend: the document store the shell broker calls, plus the realtime
 * lane it subscribes on.
 *
 *   POST /api/frame/db/:id/call        one verb (get/set/update/delete/
 *                                      acquire/query), cookie-authenticated
 *   POST /api/frame/db/:id/subscribe   mints a lane grant for one spec
 *   WS   /api/frame/db/ws              rows for granted subscriptions
 *
 * All three live on the SHELL origin: identity is the viewer cookie, and the
 * frame origin never reaches the store (it would carry no cookie and, being
 * a different origin, is refused by the lane's origin check as well).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Context } from "hono";
import { WebSocketServer, type WebSocket } from "ws";
import { capError, isCapError, toCapError, type CapError } from "../../protocol/errors.ts";
import { isArtifactId, isCollectionPath, isDocumentPath, splitPath } from "../../protocol/paths.ts";
import type { ServerApps, ServerContext } from "../../server/types.ts";
import type { ArtifactMeta } from "../../server/store.ts";
import { checkAccess, compileRules, type CompiledRule, type Level, type RuleViewer } from "./rules.ts";
import {
  DbStore,
  orderRows,
  matchesWhere,
  validateQuerySpec,
  type DocRow,
  type QuerySpec,
} from "./store.ts";

/** How long a lane grant stays usable. */
const GRANT_TTL_MS = 10 * 60 * 1000;
/** Writes are coalesced this long before the lane re-evaluates subscriptions. */
const PUSH_COALESCE_MS = 10;
/**
 * At most this many live subscriptions per lane (db.d.ts: 64 per view). The
 * frame enforces the same number, but only the trusted side can be believed:
 * every extra subscription is a full collection scan on every write.
 */
const MAX_LANE_SUBS = 64;
/** How many (artifact, version) pairs the warn-once set remembers. */
const MAX_REPORTED = 256;

export type SubscribeSpec = { path: string } | QuerySpec;

interface ViewIdentity {
  meta: ArtifactMeta;
  viewer: RuleViewer;
  rules: CompiledRule[];
}

interface GrantPayload {
  /** viewer id */
  v: string;
  /** artifact id */
  a: string;
  /** the subscription id this grant was minted for; it opens no other */
  d: string;
  /** the spec, already normalised and validated */
  s: SubscribeSpec;
  /** expiry, epoch ms */
  e: number;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function statusFor(error: CapError): 400 | 403 | 429 | 503 {
  switch (error.code) {
    case "resource_exhausted":
    case "quota_exceeded":
      return 429;
    case "revoked":
    case "capability_disabled":
      return 403;
    case "unavailable":
      return 503;
    default:
      return 400;
  }
}

export function declaresDb(meta: ArtifactMeta): boolean {
  return Object.prototype.hasOwnProperty.call(meta.capabilities, "db");
}

export function dbConfig(meta: ArtifactMeta): unknown {
  return meta.capabilities.db?.config;
}

/**
 * Why this declaration cannot be run, one message per problem. The spine
 * calls it at `POST /api/artifacts` so a bad `rules` list is refused at
 * publish instead of quietly closing the view (`CapabilityServer`).
 */
export function validateConfig(config: unknown): string[] {
  return compileRules(config).errors;
}

/**
 * `data/users/me/...` names the caller's own subtree, resolved server-side:
 * the segment right after a `{self}` rule prefix may be spelled `me`.
 * Nothing else in the path is rewritten.
 */
export function resolveSelfSegments(
  path: string,
  rules: readonly CompiledRule[],
  viewerId: string | null,
): string {
  const segs = splitPath(path);
  for (const rule of rules) {
    if (!rule.self) continue;
    const at = rule.segs.length;
    if (segs.length <= at) continue;
    if (!rule.segs.every((seg, i) => seg === segs[i])) continue;
    if (segs[at] !== "me") continue;
    if (viewerId === null) {
      throw capError("invalid_argument", "this view has no viewer id, so it has no own subtree");
    }
    segs[at] = viewerId;
  }
  return segs.join("/");
}

function docId(path: string): string {
  const segs = splitPath(path);
  return segs[segs.length - 1] ?? path;
}

/* ------------------------------------------------------------------ */
/* the slice                                                           */
/* ------------------------------------------------------------------ */

export function routes(apps: ServerApps, ctx: ServerContext): void {
  const store = new DbStore(ctx.config.dataDir);

  /* ------------------------------ identity ----------------------------- */

  /** `<artifact>@<version>` declarations already warned about. */
  const reported = new Set<string>();

  /**
   * The rules a view of this artifact runs under. A declaration that does
   * not compile closes the view to `owner`/`owner`, which is silent from
   * the page's side — so say so on the server, once per published version,
   * or the author only sees a store that answers `exists: false`.
   */
  function rulesFor(meta: ArtifactMeta): CompiledRule[] {
    const compiled = compileRules(dbConfig(meta));
    if (compiled.errors.length === 0) return compiled.rules;
    const key = `${meta.id}@${meta.currentVersion}`;
    if (!reported.has(key)) {
      if (reported.size >= MAX_REPORTED) reported.clear();
      reported.add(key);
      console.warn(
        `db: artifact ${meta.id} declares rules that do not compile, so every path ` +
          `is closed to everyone but the owner until they are fixed:\n` +
          compiled.errors.map((message) => `  - ${message}`).join("\n"),
      );
    }
    return compiled.rules;
  }

  async function identify(c: Context, id: string): Promise<ViewIdentity> {
    if (!isArtifactId(id)) throw capError("invalid_argument", "bad artifact id");
    const meta = await ctx.store.readMeta(id);
    if (!meta) throw capError("invalid_argument", "no such artifact");
    if (!declaresDb(meta)) {
      throw capError("revoked", "this artifact no longer declares db");
    }
    const cookieViewer = ctx.auth.viewer(c);
    const level = ctx.auth.levelFor(cookieViewer, meta) as Level;
    return {
      meta,
      viewer: { id: cookieViewer.id, level },
      rules: rulesFor(meta),
    };
  }

  /* ------------------------------- verbs ------------------------------- */

  function readablePath(view: ViewIdentity, path: string): boolean {
    return checkAccess(view.rules, path, "read", view.viewer).allowed;
  }

  function assertWritable(view: ViewIdentity, path: string): void {
    const decision = checkAccess(view.rules, path, "write", view.viewer);
    if (decision.allowed) return;
    // A refused write is `invalid_argument`, whether it was refused for the
    // level or because it aimed at another viewer's `{self}` subtree: the
    // store never tells a caller that a path exists but is not theirs.
    throw capError(
      "invalid_argument",
      decision.foreign
        ? "this path is in another viewer's private subtree"
        : `writing "${path}" needs the ${decision.required} sharing level`,
    );
  }

  function docPath(view: ViewIdentity, raw: unknown): string {
    if (typeof raw !== "string") throw capError("invalid_argument", "a path is required");
    const path = resolveSelfSegments(raw, view.rules, view.viewer.id);
    if (!isDocumentPath(path)) {
      throw capError(
        "invalid_argument",
        `"${raw}" is not a document path (it needs an even number of valid segments)`,
      );
    }
    return path;
  }

  function querySpec(view: ViewIdentity, raw: unknown): QuerySpec {
    const spec = validateQuerySpec(raw);
    const collection = resolveSelfSegments(spec.collection, view.rules, view.viewer.id);
    if (!isCollectionPath(collection)) {
      throw capError("invalid_argument", `"${spec.collection}" is not a collection path`);
    }
    return { ...spec, collection };
  }

  async function runQuery(view: ViewIdentity, spec: QuerySpec): Promise<DocRow[]> {
    const docs = await store.collect(view.meta.id, spec.collection);
    const rows: DocRow[] = [];
    for (const doc of docs) {
      // An unreadable document is omitted, exactly as a missing one is.
      if (!readablePath(view, doc.path)) continue;
      if (spec.where?.some((clause) => !matchesWhere(doc.data, clause))) continue;
      rows.push({ id: docId(doc.path), data: doc.data });
    }
    return orderRows(rows, spec);
  }

  async function call(view: ViewIdentity, body: Record<string, unknown>): Promise<unknown> {
    switch (body.verb) {
      case "get": {
        const path = docPath(view, body.path);
        const id = docId(path);
        if (!readablePath(view, path)) return { id, exists: false };
        const doc = await store.read(view.meta.id, path);
        return doc ? { id, exists: true, data: doc.data } : { id, exists: false };
      }
      case "set": {
        const path = docPath(view, body.path);
        assertWritable(view, path);
        await store.set(view.meta.id, path, body.body);
        return { ok: true };
      }
      case "update": {
        const path = docPath(view, body.path);
        assertWritable(view, path);
        await store.update(view.meta.id, path, body.body);
        return { ok: true };
      }
      case "delete": {
        const path = docPath(view, body.path);
        assertWritable(view, path);
        await store.delete(view.meta.id, path);
        return { ok: true };
      }
      case "acquire": {
        const path = docPath(view, body.path);
        assertWritable(view, path);
        const options = body.options;
        if (typeof options !== "object" || options === null) {
          throw capError("invalid_argument", "acquire needs a holder");
        }
        return store.acquire(view.meta.id, path, options as { holder: string });
      }
      case "query": {
        const spec = querySpec(view, body.spec);
        return { docs: await runQuery(view, spec) };
      }
      default:
        throw capError("invalid_argument", `unknown db verb "${String(body.verb)}"`);
    }
  }

  /** The rows one subscription currently sees. Shared by the lane and refresh. */
  async function evaluate(view: ViewIdentity, spec: SubscribeSpec): Promise<DocRow[]> {
    if ("path" in spec) {
      const path = spec.path;
      if (!readablePath(view, path)) return [];
      const doc = await store.read(view.meta.id, path);
      return doc ? [{ id: docId(path), data: doc.data }] : [];
    }
    return runQuery(view, spec);
  }

  function normaliseSpec(view: ViewIdentity, raw: unknown): SubscribeSpec {
    if (typeof raw !== "object" || raw === null) {
      throw capError("invalid_argument", "a subscription needs a path or a collection");
    }
    if (typeof (raw as { path?: unknown }).path === "string") {
      return { path: docPath(view, (raw as { path: string }).path) };
    }
    return querySpec(view, raw);
  }

  /* -------------------------------- HTTP ------------------------------- */

  apps.shell.post("/api/frame/db/:id/call", async (c) => {
    try {
      const view = await identify(c, c.req.param("id"));
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) throw capError("invalid_argument", "bad request body");
      return c.json(await call(view, body));
    } catch (err) {
      const error = toCapError(err, "unavailable");
      return c.json(error, statusFor(error));
    }
  });

  apps.shell.post("/api/frame/db/:id/subscribe", async (c) => {
    try {
      const view = await identify(c, c.req.param("id"));
      const body = (await c.req.json().catch(() => null)) as
        | { spec?: unknown; subId?: unknown }
        | null;
      const subId = body?.subId;
      if (typeof subId !== "string" || subId.length === 0 || subId.length > 64) {
        throw capError("invalid_argument", "a subscription grant needs a subscription id");
      }
      const spec = normaliseSpec(view, body?.spec);
      const expires = Date.now() + GRANT_TTL_MS;
      const payload: GrantPayload = {
        v: view.viewer.id ?? "",
        a: view.meta.id,
        d: subId,
        s: spec,
        e: expires,
      };
      const grant = ctx.auth.seal(Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"));
      return c.json({ grant, spec, expiresIn: Math.floor(GRANT_TTL_MS / 1000) });
    } catch (err) {
      const error = toCapError(err, "unavailable");
      return c.json(error, statusFor(error));
    }
  });

  /* ------------------------------ the lane ----------------------------- */

  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<Duplex>();

  interface Lane {
    socket: WebSocket;
    artifactId: string;
    viewerId: string | null;
    /** The `ao` cookie named this viewer: the owner half of `Auth.viewer`. */
    isOwner: boolean;
    subs: Map<string, SubscribeSpec>;
  }
  const lanes = new Set<Lane>();

  function send(lane: Lane, message: unknown): void {
    if (lane.socket.readyState !== 1) return;
    try {
      lane.socket.send(JSON.stringify(message));
    } catch {
      /* the peer went away between the check and the write */
    }
  }

  /** The identity a lane message runs under, re-read so a republish lands. */
  async function laneView(lane: Lane): Promise<ViewIdentity | null> {
    const meta = await ctx.store.readMeta(lane.artifactId);
    if (!meta || !declaresDb(meta)) return null;
    // The same identity the HTTP path resolves, or an owner's lane would see
    // fewer rows than their own `get()` returns.
    const level = ctx.auth.levelFor(
      { id: lane.viewerId ?? "", isOwner: lane.isOwner },
      meta,
    ) as Level;
    return {
      meta,
      viewer: { id: lane.viewerId, level },
      rules: rulesFor(meta),
    };
  }

  async function pushSub(lane: Lane, subId: string, spec: SubscribeSpec): Promise<void> {
    const view = await laneView(lane);
    if (!view) {
      send(lane, { kind: "revoked" });
      lane.subs.clear();
      return;
    }
    try {
      const docs = await evaluate(view, spec);
      send(lane, { kind: "rows", subId, docs });
    } catch (err) {
      const error = toCapError(err, "unavailable");
      send(lane, { kind: "error", subId, code: error.code, message: error.message });
      if (error.code !== "unavailable") lane.subs.delete(subId);
    }
  }

  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  store.onChange((artifactId) => {
    if (pending.has(artifactId)) return;
    pending.set(
      artifactId,
      setTimeout(() => {
        pending.delete(artifactId);
        for (const lane of lanes) {
          if (lane.artifactId !== artifactId) continue;
          for (const [subId, spec] of lane.subs) void pushSub(lane, subId, spec);
        }
      }, PUSH_COALESCE_MS),
    );
  });

  function readCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (header ?? "").split(";")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
    return out;
  }

  // `server.close()` waits for every open connection and an upgraded socket is
  // still one, so drop this lane's sockets when the server is shutting down.
  ctx.onShutdown(() => {
    for (const open of sockets) open.destroy();
    sockets.clear();
  });

  ctx.ws.register("/api/frame/db/ws", (request: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => {
    // The lane is a shell-origin resource: a frame-origin page has neither
    // the cookie nor a matching `Origin`, and is refused before the upgrade.
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== ctx.shellOrigin) {
      socket.destroy();
      return;
    }
    const artifactId = url.searchParams.get("artifact") ?? "";
    if (!isArtifactId(artifactId)) {
      socket.destroy();
      return;
    }
    const cookies = readCookies(request.headers.cookie);
    const viewerId = ctx.auth.unseal(cookies.av);
    const ownerId = ctx.auth.unseal(cookies.ao);
    const isOwner = viewerId !== null && ownerId === viewerId;

    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));

    wss.handleUpgrade(request, socket, head, (ws) => {
      const lane: Lane = { socket: ws, artifactId, viewerId, isOwner, subs: new Map() };
      lanes.add(lane);
      ws.on("close", () => lanes.delete(lane));
      ws.on("error", () => lanes.delete(lane));
      ws.on("message", (raw) => {
        let message: { kind?: unknown; subId?: unknown; grant?: unknown };
        try {
          message = JSON.parse(String(raw)) as typeof message;
        } catch {
          return;
        }
        if (message.kind === "ping") {
          send(lane, { kind: "pong" });
          return;
        }
        if (message.kind === "unsub" && typeof message.subId === "string") {
          lane.subs.delete(message.subId);
          return;
        }
        if (message.kind !== "sub") return;
        if (typeof message.subId !== "string" || typeof message.grant !== "string") return;
        const subId = message.subId;
        if (!lane.subs.has(subId) && lane.subs.size >= MAX_LANE_SUBS) {
          send(lane, {
            kind: "error",
            subId,
            code: "resource_exhausted",
            message: `this view already has ${MAX_LANE_SUBS} active subscriptions`,
          });
          return;
        }
        const payload = readGrant(message.grant);
        if (
          !payload ||
          payload.a !== artifactId ||
          payload.v !== (viewerId ?? "") ||
          payload.d !== subId
        ) {
          send(lane, {
            kind: "error",
            subId,
            code: "invalid_argument",
            message: "this subscription grant is not valid here",
          });
          return;
        }
        lane.subs.set(subId, payload.s);
        void pushSub(lane, subId, payload.s);
      });
    });
  });

  function readGrant(grant: string): GrantPayload | null {
    const value = ctx.auth.unseal(grant);
    if (!value) return null;
    try {
      const payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as GrantPayload;
      if (typeof payload.e !== "number" || payload.e < Date.now()) return null;
      if (typeof payload.a !== "string" || typeof payload.v !== "string") return null;
      if (typeof payload.d !== "string" || payload.d.length === 0) return null;
      if (typeof payload.s !== "object" || payload.s === null) return null;
      return payload;
    } catch {
      return null;
    }
  }
}

/** Exposed for the unit tests: the error a bad call produces. */
export function asCapError(err: unknown): CapError {
  return isCapError(err) ? err : toCapError(err);
}
