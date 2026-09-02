/**
 * Pure identity helpers shared by the three sides of the `user` slice.
 *
 * Nothing here touches a DOM, a socket or a filesystem: the frame bundles it
 * into `/_runtime/user.js`, the broker and the backend import the same
 * functions, so an id gets the same colour everywhere it is drawn.
 */

/**
 * The six swatches an unresolved profile is coloured from (surface-area.md
 * §5.1: "a deterministic colour from a hash of the id over six swatches").
 * The platform's exact palette is not observable from the modules, so these
 * are ours — what matters is that the choice is deterministic and stable.
 */
export const SWATCHES: readonly string[] = Object.freeze([
  "#c96442",
  "#5a8ec0",
  "#6f8f5c",
  "#b08a3e",
  "#9a6bab",
  "#4f8f8a",
]);

/** djb2 over UTF-16 code units, kept in 32 bits so it is stable everywhere. */
export function hashId(id: string): number {
  let hash = 5381;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) + hash + id.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/** The swatch an id always gets, including the empty id (a viewer with none). */
export function colorForId(id: string): string {
  const index = hashId(id) % SWATCHES.length;
  return SWATCHES[index] as string;
}

/**
 * The placeholder avatar for an id with no picture: a filled circle in the
 * id's own colour, as a data URI so it needs no network and passes the
 * frame's `img-src 'self' data: blob:` CSP.
 */
export function avatarDataUri(id: string): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">' +
    `<circle cx="32" cy="32" r="32" fill="${colorForId(id)}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Header the broker uses to hand the backend the signed asset token from the
 * boot record: proof that the shell really rendered this artifact for this
 * viewer. It travels shell -> backend only; the frame is never handed it.
 */
export const FRAME_TOKEN_HEADER = "x-artifact-frame-token";

/** At most this many ids travel in one `profiles` wire batch. */
export const MAX_PROFILE_IDS = 128;
/**
 * At most this many batches are sent for one `profiles()` call. The page
 * still gets an entry for every id it asked about; ids past the last batch
 * simply keep their unresolved placeholder.
 */
export const MAX_PROFILE_BATCHES = 8;
/** `search(q)` sends at most this many characters of the query. */
export const MAX_QUERY_CHARS = 100;
/** A display name is stored at most this long. */
export const MAX_NAME_CHARS = 64;

/** What one side sends the other for a profile. `color` is derived, never sent. */
export interface WireProfile {
  id: string;
  name: string;
  avatarUrl: string | null;
  email?: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Read an untrusted profile off the wire; anything malformed becomes null. */
export function readWireProfile(value: unknown): WireProfile | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return null;
  const name = typeof value.name === "string" ? value.name : "";
  const avatarUrl = typeof value.avatarUrl === "string" && value.avatarUrl ? value.avatarUrl : null;
  const email = typeof value.email === "string" && value.email ? value.email : null;
  return { id: value.id, name, avatarUrl, email };
}

/**
 * Unique, non-empty string ids in call order, capped. Used on both sides:
 * the frame trims what it asks for, the broker never trusts that it did.
 */
export function normalizeIds(value: unknown, limit = MAX_PROFILE_IDS): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "") continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

/** The query as it goes on the wire: trimmed, and at most 100 characters. */
export function normalizeQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_QUERY_CHARS);
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** A display name as it is stored: no control characters, bounded, trimmed. */
export function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, MAX_NAME_CHARS);
}
