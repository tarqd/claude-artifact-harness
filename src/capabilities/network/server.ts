/**
 * `network` — the enforcement half: the frame origin's CSP `connect-src`.
 *
 * surface-area.md §10.1: `connect-src` allows "none except what
 * `network.origins` declares". §11: the backend a self-host needs for this
 * capability is exactly "CSP `connect-src` generation from declared origins",
 * with no endpoints. So this file mounts no routes at all: it is the
 * validator that turns a declaration into the `connect-src` sources the frame
 * origin serves (see "Where the header is set").
 *
 * ## Why the declaration is validated
 *
 * A declaration is author input that lands verbatim inside a security header.
 * Two things follow:
 *
 * 1. **Header injection.** `"https://a.example; script-src *"` declared as an
 *    origin would, spliced into the policy, add a `script-src` directive of
 *    the author's choosing — the CSP is a `;`-separated list, and the author
 *    controls the string. Worse, a repeated directive is read from its *first*
 *    occurrence, so an injected `frame-ancestors *` ahead of the genuine one
 *    lifts the artifact out of its frame restriction. Every candidate is
 *    therefore parsed and re-emitted from `URL.origin`, never passed through.
 * 2. **Downgrades and over-broad grants.** `http://…` (cleartext), a URL with
 *    credentials, a path (`https://a.example/api` — CSP would read the path
 *    as a source expression prefix), or a wildcard host are not "absolute
 *    https origins" and are dropped. The list is also capped: a header that
 *    grows without bound is a document that eventually fails to load.
 * 3. **The harness's own origins.** An artifact declaring the shell's host —
 *    or a sibling artifact's `<id>.<FRAME_HOST_SUFFIX>` — is not asking for a
 *    third-party API, it is asking to `fetch` the surface that grants it its
 *    own capabilities. Where a deployment puts shell and frames under one
 *    registrable domain the viewer cookie is *same-site* for that fetch, so
 *    the page could write the shell API as the viewer. `SelfHosts` names
 *    those hosts and they are dropped. (`server/guards.ts` refuses the
 *    request as well; this stops the browser from ever making it.)
 *
 * Dropping is silent, as CSP itself is: an author who declared a bad origin
 * sees the fetch blocked in the console, which is where the platform puts it.
 * `frame.ts` still echoes the raw declaration to the page (see its header
 * comment and README.md) — the page is told what was declared, the browser is
 * told only what is safe to allow.
 *
 * ## Where the header is set
 *
 * `src/server/serve.ts` stamps the CSP on every frame-origin response and
 * calls `connectSrcOrigins()` below to build `connect-src`, so the validated
 * subset is the policy the browser enforces. That is the whole enforcement
 * path: this file mounts no routes, no middleware and no websocket lane.
 *
 * A middleware could not have done it. `mountCapabilityRoutes` runs *after*
 * `mountFrameRoutes`, so a middleware registered from here lands behind
 * `app.get("/_f/:ver/*")` in Hono's chain for that route and never sees the
 * document that matters. The slice used to wrap the frame app's own `fetch`
 * for that reason; the one-line call in `serve.ts` replaced it.
 *
 * A route that returns its own `Response` (the `assets` slice serves blobs
 * under `default-src 'none'; sandbox`) keeps its own policy: Hono drops the
 * middleware's headers when a handler builds a response itself, so nothing
 * here has to make an exception for it.
 */
/** A bound on the header: a declaration is not a place for a thousand hosts. */
export const MAX_ORIGINS = 32;

/** Longest candidate string considered at all (a hostname maxes out at 253). */
const MAX_ORIGIN_LENGTH = 512;

/**
 * `scheme://host[:port]` and nothing else, lowercase, no wildcards. This is
 * matched against `URL.origin` (already normalised: host lowercased, a
 * default `:443` dropped), so it is a shape check on our own output rather
 * than on author text. IPv6 literals (`https://[::1]`) do not match and are
 * dropped; a self-host that needs one can widen this regexp.
 */
const ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;

/**
 * One declared entry → the origin to allow, or `null`.
 *
 * Rejects: non-strings, anything with whitespace or a CSP delimiter, non-https
 * schemes, credentials, a path/query/fragment (`https://a.example/` — a bare
 * trailing slash — is accepted, since `URL` adds it), and hosts that are not
 * plain names.
 */
export function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_ORIGIN_LENGTH) return null;
  // Whitespace and the CSP separators can never appear inside one source
  // expression; refuse before parsing so nothing odd reaches `URL`.
  if (/[\s;,'"\\]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  const origin = url.origin;
  if (origin === "null" || !ORIGIN_RE.test(origin)) return null;
  return origin;
}

/**
 * The hosts this deployment is itself served at, which no declaration may
 * open. `shellHost` is `SHELL_HOST`; `frameHostSuffix` is `FRAME_HOST_SUFFIX`,
 * and covers both the bare suffix and every `<artifactId>.<suffix>` sibling.
 */
export interface SelfHosts {
  shellHost: string;
  frameHostSuffix: string;
}

/**
 * Is this hostname one of the harness's own? The shell's host exactly, the
 * frame suffix exactly, or any label under the frame suffix — a sibling
 * artifact's origin is no more a third party than our own is.
 */
export function isSelfHost(hostname: string, self: SelfHosts): boolean {
  const host = hostname.toLowerCase();
  const suffix = self.frameHostSuffix.trim().toLowerCase();
  if (host === self.shellHost.trim().toLowerCase()) return true;
  return suffix !== "" && (host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * The declared list → the `connect-src` sources to add beyond `'self'`:
 * validated, normalised, self-hosts dropped, de-duplicated, order preserved,
 * capped.
 */
export function validateOrigins(value: unknown, self: SelfHosts): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const origin = normalizeOrigin(entry);
    if (origin === null || out.includes(origin)) continue;
    if (isSelfHost(new URL(origin).hostname, self)) continue;
    out.push(origin);
    if (out.length >= MAX_ORIGINS) break;
  }
  return out;
}

/**
 * `meta.capabilities` → the `connect-src` additions.
 *
 * An `optional: true` declaration opens nothing. The spine's
 * `buildInitCapabilities` drops optional declarations before `__frame_init`
 * and there is no later grant path, so such a page never receives the
 * `network` namespace at all: widening the browser's allowlist for it would
 * hand the document a reach the view was never granted. The policy therefore
 * tracks what the view can use, not what the author wrote.
 */
export function connectSrcOrigins(
  capabilities: Record<string, { config?: unknown }> | undefined,
  self: SelfHosts,
): string[] {
  const config = capabilities?.network?.config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) return [];
  const record = config as { optional?: unknown; origins?: unknown };
  if (record.optional === true) return [];
  return validateOrigins(record.origins, self);
}
