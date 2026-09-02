/**
 * The two request guards both Hono apps carry before any route runs.
 *
 * ## Why
 *
 * Every write in this harness is a cookie-authenticated POST on the shell
 * origin. Two browser-side attacks reach those routes without ever stealing
 * a credential:
 *
 * 1. **DNS rebinding around the loopback bind.** `BIND_HOST` is `127.0.0.1`,
 *    but binding to loopback is not an authorisation check: a page that
 *    rebinds its own name to `127.0.0.1` is *same-origin* with the shell as
 *    far as the browser is concerned, so its cookies flow and its responses
 *    are readable. The only thing that distinguishes it from the real shell
 *    is the `Host` header — it says `evil.example`, not the host this server
 *    is deployed at. So `hostGuard` refuses any host that is not one of ours.
 * 2. **Same-site CSRF from an artifact frame.** Where a deployment puts the
 *    shell and the frame origins under one registrable domain, the viewer
 *    cookie is `SameSite=Lax` *same-site* for a frame's `fetch(...,
 *    {credentials: "include"})`. The artifact page is attacker-controlled, so
 *    that is a write into the shell API as the viewer. `originGuard` refuses
 *    it: the request's `Origin` is the frame origin, which is not the origin
 *    it is talking to.
 *
 * Neither guard replaces the per-route authorisation; they are the frame
 * around it, which is why they are mounted on the app rather than repeated in
 * each slice. `src/capabilities/mcp/server.ts` keeps its own `sameOriginOnly`
 * for the same reason it grew one: a lane with side effects states its own
 * precondition.
 */
import type { Context, Env, MiddlewareHandler } from "hono";
import { isArtifactId } from "../protocol/paths.ts";
import type { ServerConfig } from "./config.ts";
import type { ServerContext } from "./types.ts";

/** Which origin's host rules a request is judged by. */
export type HostKind = "shell" | "frame";

/**
 * Literal loopback addresses are always accepted, on both origins.
 *
 * They are not a rebinding vector: rebinding works by pointing a *name* at
 * `127.0.0.1`, and the `Host` header then carries that name, never the
 * literal. A browser that really does talk to `http://127.0.0.1:<port>` from
 * another page is making a cross-origin request — no cookie under
 * `SameSite=Lax`, no readable response without the CORS headers this server
 * never sends, and `originGuard` below refuses the write anyway. Tooling on
 * the box (and this repo's own tests) reach both apps this way.
 */
const LOOPBACK = new Set(["127.0.0.1", "::1"]);

/** Content types a browser may send cross-site with no preflight. */
const NO_PREFLIGHT_TYPES = new Set([
  "text/plain",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
]);

/**
 * `Host` → the hostname alone: lowercased, port removed, an IPv6 literal
 * unwrapped from its brackets. `null` when there is no usable host at all
 * (an HTTP/1.0 request with no `Host`, or a header that is only a port).
 */
export function hostnameOf(host: string | undefined): string | null {
  const raw = (host ?? "").trim().toLowerCase();
  if (raw === "") return null;
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    return close > 1 ? raw.slice(1, close) : null;
  }
  const name = raw.split(":")[0] ?? "";
  return name === "" ? null : name;
}

/**
 * Is this `Host` one this server answers to?
 *
 * The shell answers at `SHELL_HOST`. The frame origin answers at
 * `<artifactId>.<FRAME_HOST_SUFFIX>` — and at the bare suffix, which is the
 * host the `/_a/<artifactId>/…` prefix form is reached at where wildcard DNS
 * is unavailable. `ARTIFACT_ALLOWED_HOSTS` adds names for a deployment that
 * is reached at more than one (a proxy's internal name, a LAN address).
 */
export function isKnownHost(
  config: ServerConfig,
  kind: HostKind,
  host: string | undefined,
): boolean {
  const name = hostnameOf(host);
  if (name === null) return false;
  if (LOOPBACK.has(name)) return true;
  if (config.allowedHosts.some((allowed) => allowed.toLowerCase() === name)) return true;
  if (kind === "shell") return name === config.shellHost.toLowerCase();
  const suffix = config.frameHostSuffix.toLowerCase();
  if (name === suffix) return true;
  if (!name.endsWith(`.${suffix}`)) return false;
  return isArtifactId(name.slice(0, name.length - suffix.length - 1));
}

/** Refuse a request whose `Host` names a server that is not this one. */
export function hostGuard<E extends Env>(
  config: ServerConfig,
  kind: HostKind,
): MiddlewareHandler<E> {
  return async (c, next) => {
    if (!isKnownHost(config, kind, c.req.header("host"))) {
      return c.text("unknown host", 403);
    }
    await next();
  };
}

/**
 * `Origin` → is the caller the page this server is serving at this host?
 *
 * An absent `Origin` is a non-browser client (`npm run publish`, `curl`, a
 * test): it is allowed here and covered by the content-type rule below. A
 * present one must be the shell's configured origin, or an origin whose
 * host is byte-for-byte the `Host` being addressed — which is what "the
 * browser considers this same-origin" means, and stays true behind a TLS
 * proxy or on a non-default port without a second config knob.
 */
function originIsSelf<E extends Env>(c: Context<E>, ctx: ServerContext): boolean {
  const origin = c.req.header("origin");
  if (origin === undefined) return true;
  if (origin === ctx.shellOrigin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // `Origin: null` — a sandboxed frame or a cross-origin redirect
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = (c.req.header("host") ?? "").trim().toLowerCase();
  return host !== "" && url.host.toLowerCase() === host;
}

/**
 * Refuse any state-changing request that did not come from this origin's own
 * page. Three checks, in the order a browser makes them cheap to answer:
 *
 * - `Sec-Fetch-Site` must be `same-origin` (the shell page's own `fetch`) or
 *   `none` (a user-initiated navigation). `same-site` is the frame-origin
 *   CSRF above; `cross-site` is any other page.
 * - `Origin`, when sent, must be this origin (see `originIsSelf`).
 * - When *neither* header is present — an old browser, or a bare client —
 *   the content type must be one a browser could not have sent cross-site
 *   without a preflight this server would fail. So `application/json` (every
 *   JSON lane) and `image/png` (an `assets` upload) pass, while the
 *   `text/plain` a forged form or a "simple" `fetch` would carry does not.
 *
 * The last rule is why this is not a flat "every POST must be
 * `application/json`": the `assets` upload lane posts the blob's own media
 * type, and `text/plain` is one of the accepted asset types — it is accepted
 * from the shell page, which sends an `Origin`, and refused from a caller
 * that proves nothing.
 */
export function originGuard<E extends Env>(ctx: ServerContext): MiddlewareHandler<E> {
  return async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD") {
      await next();
      return;
    }
    const site = c.req.header("sec-fetch-site");
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      return deny(c);
    }
    if (!originIsSelf(c, ctx)) return deny(c);
    if (site === undefined && c.req.header("origin") === undefined) {
      const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (type === "" || NO_PREFLIGHT_TYPES.has(type)) {
        return c.json(
          {
            code: "invalid_content",
            message: `${type === "" ? "a" : `a ${type}`} body is not accepted here: send application/json`,
          },
          415,
        );
      }
    }
    await next();
  };
}

function deny<E extends Env>(c: Context<E>): Response {
  return c.json(
    { code: "not_granted", message: "this request did not come from the shell page" },
    403,
  );
}
