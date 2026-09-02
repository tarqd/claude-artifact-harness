/**
 * `assets` — the constants and pure validators the frame, the shell broker and
 * the server all share (surface-area.md §5.4).
 *
 * The accepted media types, the two size caps, the `/_blob/<id>` URL grammar
 * and the four documented error codes are the contract a page written for
 * claude.ai relies on, so they live in one place and are applied on every
 * side: the frame refuses obvious caller bugs before a round trip, and the
 * server refuses them again because it never trusts the frame.
 */
import { capError, type CapError } from "../../protocol/errors.ts";
import { BLOB_ID_RE } from "../../protocol/paths.ts";

export const CAP = "assets";

/** The documented reply budget for `assets` (surface-area.md §4). */
export const ASSETS_TIMEOUT_MS = 130_000;

/** 20 MiB per blob. */
export const MAX_BLOB_BYTES = 20 * 1024 * 1024;
/** 2 MiB for SVG, which is markup an origin executes rather than opaque bytes. */
export const MAX_SVG_BYTES = 2 * 1024 * 1024;

export const SVG_TYPE = "image/svg+xml";

/**
 * A self-host restriction §5.4 does not name: one artifact's assets may total
 * at most 512 MiB across at most 2000 blobs. Crossing either ceiling is
 * refused with `too_large` — the documented code for "these bytes do not
 * fit" — so a page still only ever sees the four codes.
 */
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_ARTIFACT_ASSETS = 2000;

/** Exactly the list in surface-area.md §5.4, in that order. */
export const ACCEPTED_TYPES: readonly string[] = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
  "application/pdf",
  "font/woff2",
  "font/woff",
  "font/ttf",
  "font/otf",
  "text/csv",
  "text/markdown",
  "application/json",
  "text/plain",
]);

const ACCEPTED = new Set(ACCEPTED_TYPES);

/** Assets resolve relative to the artifact origin (surface-area.md §5.4). */
export const BLOB_PATH_PREFIX = "/_blob/";

/** How many rows one `list` page carries. */
export const LIST_PAGE_SIZE = 100;
/** `list()` follows `next` cursors, at most 16 pages (surface-area.md §5.4). */
export const MAX_LIST_PAGES = 16;

/* ------------------------------------------------------------------ */
/* the four documented codes                                           */
/* ------------------------------------------------------------------ */

export const ASSET_ERROR_CODES: readonly string[] = Object.freeze([
  "invalid_request",
  "too_large",
  "unsupported_type",
  "upstream_error",
]);

export const invalidRequest = (message: string): CapError =>
  capError("invalid_request", message);
export const tooLarge = (message: string): CapError => capError("too_large", message);
export const unsupportedType = (message: string): CapError =>
  capError("unsupported_type", message);
export const upstreamError = (message: string): CapError =>
  capError("upstream_error", message);

/** Anything this slice returns to a page carries one of the four codes. */
export function isAssetErrorCode(code: unknown): boolean {
  return typeof code === "string" && ASSET_ERROR_CODES.includes(code);
}

/* ------------------------------------------------------------------ */
/* wire records                                                        */
/* ------------------------------------------------------------------ */

export interface AssetRecord {
  id: string;
  /** Always relative: the page renders it against its own origin. */
  url: string;
  type: string;
  size: number;
  createdAt: string;
}

export interface AssetUsage {
  count: number;
  bytes: number;
}

export interface AssetPage {
  assets: AssetRecord[];
  usage: AssetUsage;
  /** Cursor for the next page; absent on the last one. */
  next?: string;
}

export interface AssetListResult {
  assets: AssetRecord[];
  usage: AssetUsage;
}

export interface AssetDeleteResult {
  id: string;
  deleted: boolean;
}

/* ------------------------------------------------------------------ */
/* grammar                                                             */
/* ------------------------------------------------------------------ */

export function blobUrl(id: string): string {
  return `${BLOB_PATH_PREFIX}${id}`;
}

/**
 * A bare media type: parameters (`; charset=utf-8`) stripped, lower-cased.
 * Returns `null` when nothing usable is left, which is a different failure
 * from "a type we do not accept".
 */
export function normalizeType(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const bare = (raw.split(";")[0] ?? "").trim().toLowerCase();
  return bare.length > 0 ? bare : null;
}

export function isAcceptedType(type: string): boolean {
  return ACCEPTED.has(type);
}

/** The cap that applies to one type: SVG is held to 2 MiB, everything else 20. */
export function limitFor(type: string): number {
  return type === SVG_TYPE ? MAX_SVG_BYTES : MAX_BLOB_BYTES;
}

/**
 * `delete(idOrUrl)` accepts "a 32-hex id or `/_blob/<id>`". A query string or
 * fragment on the URL form is ignored so a cache-busted `asset.url` still
 * resolves; anything else is a caller bug.
 */
export function parseAssetRef(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  let value = ref.trim();
  const cut = value.search(/[?#]/);
  if (cut >= 0) value = value.slice(0, cut);
  if (value.startsWith(BLOB_PATH_PREFIX)) value = value.slice(BLOB_PATH_PREFIX.length);
  return BLOB_ID_RE.test(value) ? value : null;
}

/**
 * The size check both the frame and the server run. Returns the error to
 * raise, or `null` when the bytes are within the cap for their type.
 */
export function checkSize(type: string, size: number): CapError | null {
  const limit = limitFor(type);
  if (size > limit) {
    const mib = Math.round(limit / (1024 * 1024));
    return tooLarge(
      type === SVG_TYPE
        ? `an SVG asset must be at most ${mib} MiB`
        : `an asset must be at most ${mib} MiB`,
    );
  }
  return null;
}

/**
 * The type check both the frame and the server run: a missing type is a
 * caller bug (`invalid_request`), a type outside the list is
 * `unsupported_type`.
 */
export function checkType(raw: unknown): { type: string } | { error: CapError } {
  const type = normalizeType(raw);
  if (type === null) {
    return {
      error: invalidRequest(
        "upload needs a content type: pass {type} or a Blob that carries one",
      ),
    };
  }
  if (!isAcceptedType(type)) {
    return { error: unsupportedType(`${type} is not an accepted asset type`) };
  }
  return { type };
}
