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
 * content). Base64 alone inflates that by 4/3 (~21.3 MiB); this leaves
 * further headroom for the JSON envelope (quotes, keys, per-file
 * `contentType`/`encoding`) on top of the base64 payload.
 */
export const PUBLISH_BODY_LIMIT = 24 * 1024 * 1024;

/**
 * The admin write routes (`src/server/admin.ts`) only ever carry `html` (no
 * `files`), so they don't need base64 headroom — but JSON string escaping
 * (`"` -> `\"`, newlines -> `\n`, ...) can still inflate a maximal 16 MiB
 * document past a cap sized for the decoded bytes alone. 16 MiB * 1.25
 * comfortably covers realistic escaping ratios without losing the point of
 * having a cap.
 */
export const ADMIN_PUBLISH_BODY_LIMIT = 20 * 1024 * 1024;
