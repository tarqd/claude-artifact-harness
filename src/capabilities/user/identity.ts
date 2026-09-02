/**
 * Pure identity helpers shared by the three sides of the `user` slice.
 *
 * Nothing here touches a DOM, a socket or a filesystem: the frame bundles it
 * into `/_runtime/user.js`, the broker and the backend import the same
 * functions, so an id gets the same colour everywhere it is drawn.
 */

/**
 * The six swatches an unresolved profile is coloured from (surface-area.md
 * §5.1), the platform's own palette and hash so that an id draws the same
 * colour here as on claude.ai (verified by the conformance run against the
 * platform's user module).
 */
export const SWATCHES: readonly string[] = Object.freeze([
  "#62744c",
  "#b04e72",
  "#5b7596",
  "#a3651f",
  "#7a6ba8",
  "#3f7a75",
]);

/** The colour of a viewer with no id at all. */
export const NO_ID_COLOR = "#c7c9d1";

/** The platform's hash: `h = h * 31 + code`, kept unsigned 32-bit. */
export function hashId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** The swatch an id always gets; the empty id (a viewer with none) is grey. */
export function colorForId(id: string): string {
  if (id === "") return NO_ID_COLOR;
  const index = hashId(id) % SWATCHES.length;
  return SWATCHES[index] as string;
}

/**
 * The placeholder avatar for an id with no picture: a filled circle in the
 * id's own colour, as a data URI so it needs no network and passes the
 * frame's `img-src 'self' data: blob:` CSP. Byte-identical to the platform's.
 */
export function avatarDataUri(id: string): string {
  return avatarForColor(colorForId(id));
}

export function avatarForColor(color: string): string {
  return (
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2 2'%3E" +
    `%3Ccircle cx='1' cy='1' r='1' fill='${encodeURIComponent(color)}'/%3E%3C/svg%3E`
  );
}

/**
 * Header the broker uses to hand the backend the signed asset token from the
 * boot record: proof that the shell really rendered this artifact for this
 * viewer. The broker sends it shell -> backend only; the frame origin does
 * see the same token once, in its own iframe URL (`__frame_t`), but never
 * through this header — the preamble strips it from `location` on boot
 * (`src/frame/preamble.ts`) and this slice's frame module never reads it.
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
