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
 * Matches the store's own `MAX_HTML_BYTES` / `MAX_VERSION_BYTES` ceiling
 * (16 MiB), plus headroom for the JSON envelope and base64 file encoding.
 */
export const PUBLISH_BODY_LIMIT = 17 * 1024 * 1024;
