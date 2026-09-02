/**
 * A pre-parse body-size guard for JSON POST routes. `hono/body-limit`
 * meters bytes as they stream in — a request that lies about
 * `content-length`, declares none at all (chunked), or simply sends more
 * than it should is refused as soon as it crosses the cap, so a handler's
 * `c.req.json()` / `c.req.text()` never buffers an oversized body before
 * anyone looks at it. The response matches the codebase's standard error
 * shape (`{code, message}`, `too_large`, 413).
 */
import { bodyLimit } from "hono/body-limit";
import type { MiddlewareHandler } from "hono";
import { capError } from "../protocol/errors.ts";

export function maxBodySize(maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    // The declared-length branch refuses without ever reading the body, so
    // the rest of it is still incoming on this socket: the same reason
    // `assets/server.ts` closes the connection rather than leaving a client
    // to find out by reset on its next request.
    onError: (c) =>
      c.json(capError("too_large", "the request body is too large"), 413, {
        connection: "close",
      }),
  });
}

/** The default cap for a broker JSON route with no larger declared need. */
export const DEFAULT_FRAME_BODY_LIMIT = 512 * 1024;

/**
 * `/api/frame/self/*` (the `artifact` capability's `publish` backend) sends
 * either `html` (a raw UTF-8 string) or `files` (each file's bytes carried
 * base64, per the wire format in `artifact/broker.ts`), both bounded by the
 * store's `MAX_VERSION_BYTES`/`MAX_HTML_BYTES` ceiling (16 MiB of *decoded*
 * content). Base64 alone inflates that by 4/3 (~21.3 MiB) — smaller than
 * the `html` path's worst case below, so the same 2x factor covers both
 * with room left for the JSON envelope (quotes, keys, per-file
 * `contentType`/`encoding`).
 */
export const PUBLISH_BODY_LIMIT = 2 * 16 * 1024 * 1024;

/**
 * The admin write routes (`src/server/admin.ts`) only ever carry `html` (no
 * `files`), so they don't need base64 headroom — but JSON string escaping
 * can still inflate a maximal 16 MiB document past a cap sized for the
 * decoded bytes alone. 2x the decoded ceiling covers the case where every
 * byte comes out as one of the common 2-character escapes (`"` -> `\"`,
 * `\` -> `\\`, a newline -> `\n`). It does not cover a document made
 * mostly of other C0 control bytes, which JSON writes as 6-character
 * `\u00XX` escapes; such a body is refused 413 here instead of 400 by the
 * store, which is an acceptable trade for a bound that is known up front.
 */
export const ADMIN_PUBLISH_BODY_LIMIT = 2 * 16 * 1024 * 1024;
