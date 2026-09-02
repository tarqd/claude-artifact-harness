/**
 * `user` backend. Everything lives on the SHELL origin, like the other
 * broker backends: identity here is the signed viewer cookie, which the
 * frame origin does not have and must never be able to borrow.
 *
 *   GET  /api/account[?slug=<artifactId>]     the caller's own profile
 *   POST /api/frame/user/profile              set the caller's display name
 *   POST /api/frame/user/email/<artifactId>   v0: null, and only with the scope
 *   POST /api/frame/user/profiles/<artifactId>  resolve ids
 *   POST /api/frame/user/search/<artifactId>    search the artifact's peers
 *
 * Two boundaries are load-bearing. An artifact only ever resolves viewers
 * who have opened *that* artifact (plus the caller), so a page cannot use
 * the directory to enumerate another artifact's audience; and `search`,
 * which is enumeration by definition, additionally requires a writer, as it
 * does on claude.ai.
 */
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import {
  FRAME_TOKEN_HEADER,
  normalizeIds,
  normalizeName,
  normalizeQuery,
} from "./identity.ts";
import { isArtifactId, isUserId } from "../../protocol/paths.ts";
import { clientKey, RateLimiter } from "../../server/ratelimit.ts";
import type { ServerApps, ServerContext } from "../../server/types.ts";
import type { ArtifactMeta } from "../../server/store.ts";
import { UserStore, type StoredProfile } from "./store.ts";

/** The scope a page gets without asking. `email` must be declared. */
const DEFAULT_SCOPES = ["profile"] as const;

/** The two budgets inside the spine's rate-limit window, per client address. */
export const NAME_WRITES_PER_WINDOW = 60;
export const JOIN_WRITES_PER_WINDOW = 240;

// The limiter itself lives in the spine (`server/ratelimit.ts`): login uses
// the same one. Re-exported here so this slice's tests keep one import.
export { RateLimiter, RATE_WINDOW_MS } from "../../server/ratelimit.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function declaresUser(meta: ArtifactMeta): boolean {
  return Object.prototype.hasOwnProperty.call(meta.capabilities, "user");
}

/**
 * `{user: {scopes: [...]}}` and `{user: {config: {scopes: [...]}}}` are both
 * accepted: the first is how the capabilities skill spells a declaration,
 * the second is how the shell carries it.
 */
export function scopesOf(meta: ArtifactMeta): string[] {
  const entry = meta.capabilities.user as unknown;
  if (!isRecord(entry)) return [...DEFAULT_SCOPES];
  const fromConfig = isRecord(entry.config) ? entry.config.scopes : undefined;
  const raw = Array.isArray(fromConfig) ? fromConfig : entry.scopes;
  if (!Array.isArray(raw)) return [...DEFAULT_SCOPES];
  const scopes = raw.filter((s): s is string => typeof s === "string");
  // A declaration that names scopes at all still keeps `profile`: the shell
  // forwards `profile: true` to every page that declares `user`.
  return scopes.includes("profile") ? scopes : ["profile", ...scopes];
}

function wire(row: StoredProfile | null, id: string): {
  id: string;
  name: string;
  avatarUrl: null;
  email: null;
} {
  // v0 stores no pictures and no addresses; the frame draws its own
  // deterministic avatar from the id, so `null` here is not a gap.
  return { id, name: row?.name ?? "", avatarUrl: null, email: null };
}

export function routes(apps: ServerApps, ctx: ServerContext): void {
  const store = new UserStore(ctx.config.dataDir);
  const nameLimit = new RateLimiter(NAME_WRITES_PER_WINDOW);
  const joinLimit = new RateLimiter(JOIN_WRITES_PER_WINDOW);

  const fail = (c: Context, status: 400 | 403 | 404 | 429, code: string, message: string) =>
    c.json({ code, message }, status);

  /**
   * The viewer this request already had, or `null` when it carried no valid
   * cookie. Unlike `auth.viewer`, this never mints one: identity is minted by
   * opening a page, so a cookieless client cannot write anything here.
   */
  const session = (c: Context): string | null => {
    const id = ctx.auth.unseal(getCookie(c, ctx.auth.viewerCookieName()));
    return id !== null && isUserId(id) ? id : null;
  };

  /**
   * Record that this viewer has opened this artifact — the write that puts
   * them in its directory, where other pages can see their name. It takes
   * proof that the shell really rendered *this* artifact for *this* viewer:
   * the signed asset token minted with the boot record and forwarded by the
   * broker. A bare HTTP client has no such token and never joins, so nobody
   * can inject a chosen identity into a page's `search()` results.
   *
   * A token that has aged out is not an error: the viewer joined when the
   * page loaded, and a long-open page keeps reading the directory.
   */
  const join = async (c: Context, meta: ArtifactMeta, viewerId: string): Promise<void> => {
    const claims = ctx.auth.verifyAssetToken(c.req.header(FRAME_TOKEN_HEADER));
    if (!claims || claims.artifactId !== meta.id || claims.viewerId !== viewerId) return;
    if (!joinLimit.allow(clientKey(c))) return;
    await store.touch(meta.id, viewerId);
  };

  /** Resolve `:id` (or `?slug=`) to an artifact that actually declares `user`. */
  const artifactFor = async (
    c: Context,
    id: string | undefined,
  ): Promise<ArtifactMeta | Response> => {
    if (!isArtifactId(id)) return fail(c, 400, "invalid_content", "bad artifact id");
    const meta = await ctx.store.readMeta(id);
    if (!meta) return fail(c, 404, "not_declared", "no such artifact");
    if (!declaresUser(meta)) {
      return fail(c, 403, "capability_disabled", "this artifact does not declare user");
    }
    return meta;
  };

  /* ------------------------------ account ----------------------------- */

  apps.shell.get("/api/account", async (c) => {
    // The one place a viewer id is minted: reading your own (empty) row.
    const viewer = ctx.auth.viewer(c);
    const slug = c.req.query("slug");
    if (slug !== undefined) {
      const meta = await artifactFor(c, slug);
      if (meta instanceof Response) return meta;
      // Opening an artifact is what makes a viewer visible to its peers.
      if (session(c) === viewer.id) await join(c, meta, viewer.id);
    }
    const row = await store.profile(viewer.id);
    return c.json({ account: wire(row, viewer.id) });
  });

  /**
   * Set the caller's display name. Deliberately *not* reachable from the
   * frame: the documented namespace has no setter, so this is a shell and
   * tooling endpoint that acts only on the caller's own row.
   */
  apps.shell.post("/api/frame/user/profile", async (c) => {
    // A name is written only for a session that already exists: minting one
    // here would let a cookieless caller create a row per request.
    const viewerId = session(c);
    if (!viewerId) return fail(c, 403, "not_granted", "no viewer session");
    if (!nameLimit.allow(clientKey(c))) {
      return fail(c, 429, "rate_limited", "too many profile writes");
    }
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    if (!body) return fail(c, 400, "invalid_content", "bad request body");
    const name = normalizeName(body.name);
    if (name === null) return fail(c, 400, "invalid_content", "name must be a string");
    const row = await store.setName(viewerId, name);
    return c.json({ account: wire(row, viewerId) });
  });

  /* ------------------------------- email ------------------------------ */

  apps.shell.post("/api/frame/user/email/:id", async (c) => {
    const meta = await artifactFor(c, c.req.param("id"));
    if (meta instanceof Response) return meta;
    if (!scopesOf(meta).includes("email")) {
      return fail(c, 403, "not_granted", "this artifact did not declare the email scope");
    }
    const viewerId = session(c);
    if (!viewerId) return fail(c, 403, "not_granted", "no viewer session");
    await join(c, meta, viewerId);
    // The scope is honoured, but v0 has no address book: the contract says
    // `email()` may resolve null, and it always does here.
    return c.json({ email: null });
  });

  /* ----------------------------- directory ---------------------------- */

  apps.shell.post("/api/frame/user/profiles/:id", async (c) => {
    const meta = await artifactFor(c, c.req.param("id"));
    if (meta instanceof Response) return meta;
    if (!scopesOf(meta).includes("profile")) {
      return fail(c, 403, "not_granted", "this artifact did not declare the profile scope");
    }
    const viewerId = session(c);
    if (!viewerId) return fail(c, 403, "not_granted", "no viewer session");
    const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
    if (!body) return fail(c, 400, "invalid_content", "bad request body");
    const ids = normalizeIds(body.ids);
    await join(c, meta, viewerId);
    const rows = await store.resolve(meta.id, viewerId, ids);
    const profiles: Record<string, ReturnType<typeof wire>> = {};
    for (const row of rows) profiles[row.id] = wire(row, row.id);
    return c.json({ profiles });
  });

  apps.shell.post("/api/frame/user/search/:id", async (c) => {
    const meta = await artifactFor(c, c.req.param("id"));
    if (meta instanceof Response) return meta;
    if (!scopesOf(meta).includes("profile")) {
      return fail(c, 403, "not_granted", "this artifact did not declare the profile scope");
    }
    const viewerId = session(c);
    if (!viewerId) return fail(c, 403, "not_granted", "no viewer session");
    const viewer = ctx.auth.viewer(c);
    const level = ctx.auth.levelFor(viewer, meta);
    if (!ctx.auth.canEdit(level)) {
      // Searching is enumeration; on claude.ai it needs a writer, and so it
      // does here. Readers still resolve ids they already know.
      return fail(c, 403, "not_granted", "this viewer cannot search the directory");
    }
    const body = (await c.req.json().catch(() => null)) as { q?: unknown } | null;
    if (!body) return fail(c, 400, "invalid_content", "bad request body");
    const q = normalizeQuery(body.q);
    await join(c, meta, viewerId);
    const rows = q === "" ? [] : await store.search(meta.id, q);
    return c.json({ profiles: rows.map((row) => wire(row, row.id)) });
  });
}
