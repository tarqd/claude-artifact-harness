/**
 * The shell origin's request guard: who may POST to a capability lane at all,
 * and how that lane's body is read.
 *
 * A viewer's consent for a capability lives in the shell page — never in a
 * header the caller writes — so a lane with side effects (running a connector
 * tool, spending the operator's model budget) has to establish that the shell
 * page is what asked before it does anything. Two callers it must not serve:
 * a browser on any site the viewer happens to visit, which can send a "simple"
 * cross-site POST with no preflight (`text/plain`, `mode: "no-cors"`) and get
 * the effect even though the answer is opaque to it; and a bare HTTP client,
 * which sends whatever it likes and holds no cookie at all.
 *
 * `sameOriginOnly` closes the first. The second is closed by the lane itself
 * asking `auth.existingViewer` rather than `auth.viewer`: an API route must
 * never mint an identity, because minting one is precisely what turns a
 * credential-less caller into an accepted viewer.
 *
 * Only the lanes that call it are guarded today (`mcp`, `sample`). It is kept
 * request-shaped, with no per-lane state, so that issue #7 can mount it as one
 * Hono middleware over every `/api/frame/*` and `/api/account` POST; until then
 * the db, user, artifact and account lanes are still unguarded.
 */
import type { Context } from "hono";
import { capError, type CapError } from "../protocol/errors.ts";
import type { ServerContext } from "./types.ts";

export type FailStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 502 | 503;

/** A refusal carrying the status and the `{code, message}` body to answer. */
export class Refusal extends Error {
  constructor(
    readonly status: FailStatus,
    readonly error: CapError,
  ) {
    super(error.message);
  }
}

export function refuse(status: FailStatus, code: string, message: string): never {
  throw new Refusal(status, capError(code, message));
}

/** What one lane calls itself when it refuses. Slice vocabularies differ. */
export interface Lane {
  /** Names the lane in the refusal: "connector calls", "sampling calls". */
  what: string;
  /** The `{code}` an unusable request answers with (`bad_request`, ...). */
  badRequestCode: string;
  /** Largest request body this lane will read. */
  maxBodyBytes: number;
}

/**
 * Only the shell page may call this lane. A request from any other site —
 * which the browser would otherwise send as a "simple" cross-site POST, with
 * the cookie under `SameSite=Lax` left off but the effect still happening —
 * is refused before the body is read.
 */
export function sameOriginOnly(c: Context, ctx: ServerContext, lane: Lane): void {
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    refuse(415, lane.badRequestCode, "the body must be application/json");
  }
  const site = c.req.header("sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    refuse(403, "not_granted", `${lane.what} are only accepted from the shell page`);
  }
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== ctx.shellOrigin) {
    refuse(403, "not_granted", `${lane.what} are only accepted from the shell page`);
  }
}

/**
 * Read the body with a running byte cap: a request that declares no length
 * (chunked) or lies about it is refused as soon as it crosses the cap, never
 * after it has been buffered whole.
 */
export async function readJsonBody(c: Context, lane: Lane): Promise<Record<string, unknown>> {
  const tooLarge = (): never => refuse(413, "too_large", "the request body is too large");
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > lane.maxBodyBytes) tooLarge();
  let bytes: Uint8Array;
  const stream = c.req.raw.body;
  if (!stream) {
    bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > lane.maxBodyBytes) tooLarge();
  } else {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > lane.maxBodyBytes) {
          await reader.cancel().catch(() => undefined);
          tooLarge();
        }
        chunks.push(value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released by cancel() */
      }
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    refuse(400, lane.badRequestCode, "bad request body");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse(400, lane.badRequestCode, "bad request body");
  }
  return parsed as Record<string, unknown>;
}
