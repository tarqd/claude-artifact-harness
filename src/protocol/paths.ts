/**
 * Path and id grammar shared by every slice (surface-area.md §5.9, §6).
 * Pure functions only: they run in the frame, the shell and the server.
 */

/** One db path segment: `^[A-Za-z0-9_\-.~:@+]+$`, at most 200 bytes. */
const SEGMENT_RE = /^[A-Za-z0-9_\-.~:@+]+$/;
export const MAX_SEGMENT_BYTES = 200;
export const MAX_PATH_BYTES = 1000;
export const MAX_PATH_SEGMENTS = 16;

const utf8 = new TextEncoder();

export function byteLength(s: string): number {
  return utf8.encode(s).length;
}

export function isPathSegment(seg: string): boolean {
  if (seg === "." || seg === "..") return false;
  return SEGMENT_RE.test(seg) && byteLength(seg) <= MAX_SEGMENT_BYTES;
}

export function splitPath(path: string): string[] {
  return path.split("/");
}

/** A syntactically valid path, without deciding document vs collection. */
export function isValidPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (byteLength(path) > MAX_PATH_BYTES) return false;
  const segs = splitPath(path);
  if (segs.length === 0 || segs.length > MAX_PATH_SEGMENTS) return false;
  return segs.every(isPathSegment);
}

/** Documents have an even number of segments (`boards/b1`). */
export function isDocumentPath(path: string): boolean {
  return isValidPath(path) && splitPath(path).length % 2 === 0;
}

/** Collections have an odd number of segments (`boards`, `boards/b1/cards`). */
export function isCollectionPath(path: string): boolean {
  return isValidPath(path) && splitPath(path).length % 2 === 1;
}

/** The collection a document path lives in, or null. */
export function parentCollection(path: string): string | null {
  if (!isDocumentPath(path)) return null;
  const segs = splitPath(path);
  segs.pop();
  return segs.join("/");
}

/** Filesystem-safe encoding of a db path (one file per document). */
export function encodePathForFs(path: string): string {
  return splitPath(path).map(encodeURIComponent).join("__");
}

/* ------------------------------------------------------------------ */
/* ids                                                                 */
/* ------------------------------------------------------------------ */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomChars(alphabet: string, n: number): string {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

/** Client-minted document id: 20 base-36 characters. */
export function mintDocId(): string {
  return randomChars(BASE36, 20);
}

/** Viewer id: `u_` + 22 base62 characters (`^u_[A-Za-z0-9_]{22}$`). */
export function mintUserId(): string {
  return `u_${randomChars(BASE62, 22)}`;
}

export const USER_ID_RE = /^u_[A-Za-z0-9_]{22}$/;

export function isUserId(v: unknown): v is string {
  return typeof v === "string" && USER_ID_RE.test(v);
}

/** Artifact id: 32 hex characters, so it can be a DNS label (`<id>.localhost`). */
export function mintArtifactId(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

export const ARTIFACT_ID_RE = /^[0-9a-f]{32}$/;

export function isArtifactId(v: unknown): v is string {
  return typeof v === "string" && ARTIFACT_ID_RE.test(v);
}

/** Version id, as claude.ai constrains it: `^[A-Za-z0-9_-]{1,64}$`. */
export const VERSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isVersionId(v: unknown): v is string {
  return typeof v === "string" && VERSION_ID_RE.test(v);
}

export function nextVersionId(current: string | null): string {
  const n = current && /^v(\d+)$/.test(current) ? Number(current.slice(1)) : 0;
  return `v${n + 1}`;
}

/* ------------------------------------------------------------------ */
/* artifact file paths (publish(files) and `/_f/<ver>/<path>`)          */
/* ------------------------------------------------------------------ */

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * A relative, traversal-free path an artifact version may store or serve.
 * Rejects leading slashes, `.`/`..` segments, backslashes and control chars.
 */
export function isArtifactFilePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  if (CONTROL_CHARS_RE.test(path) || /\s/.test(path)) return false;
  const segs = path.split("/");
  if (segs.length > 32) return false;
  return segs.every((s) => s.length > 0 && s !== "." && s !== "..");
}

/** Blob id: 32 hex characters (`/_blob/<id>`). */
export const BLOB_ID_RE = /^[0-9a-f]{32}$/;

export function isBlobId(v: unknown): v is string {
  return typeof v === "string" && BLOB_ID_RE.test(v);
}
