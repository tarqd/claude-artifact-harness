/**
 * The `room` validators. Everything here runs in the frame (the page's own
 * process) because that is where the platform runs it: a page must see the
 * same rejection, with the same message, whether it is talking to claude.ai
 * or to this harness.
 *
 * Three grammars live here:
 *   - the topic grammar (`^[a-z][a-z0-9_.-]{0,47}$`, colon-free);
 *   - the loose "plain JSON" check `emit`/`presence` payloads must pass;
 *   - the strict `ToClaude` walker `sendToClaudeSession` runs, including the
 *     format-character table and its emoji joiner exceptions.
 *
 * Reference: docs/analysis/sample-room.md §2.6, §2.8 and §2.11.
 */
import { capError, type CapError } from "../../protocol/errors.ts";

/* ------------------------------------------------------------------ */
/* topics                                                              */
/* ------------------------------------------------------------------ */

/** `Topic` in room.d.ts. Colon-free so no page can forge a platform kind. */
export const TOPIC_RE = /^[a-z][a-z0-9_.-]{0,47}$/;

export function isTopic(v: unknown): v is string {
  return typeof v === "string" && TOPIC_RE.test(v);
}

/* ------------------------------------------------------------------ */
/* the loose plain-JSON check (`Se`)                                   */
/* ------------------------------------------------------------------ */

/** Entries per array/object, depth, and total nodes (§2.11 `Ae`/`Qe`/`et`). */
const LOOSE_ENTRIES = 4096;
const LOOSE_DEPTH = 24;
const LOOSE_NODES = 16_384;

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === null || proto === Object.prototype;
}

/**
 * True when `value` is data a `JSON.stringify` round trip preserves: no
 * functions, symbols, bigints, typed arrays or class instances, and inside
 * the container/depth/node budget.
 */
export function isPlainJson(value: unknown): boolean {
  let nodes = 0;
  const walk = (v: unknown, depth: number): boolean => {
    if (++nodes > LOOSE_NODES) return false;
    if (depth > LOOSE_DEPTH) return false;
    // `undefined` survives as an omitted key, exactly as the platform's own
    // check allows: the merge round-trips through JSON and drops it.
    if (v === null || v === undefined) return true;
    const type = typeof v;
    if (type === "string" || type === "boolean") return true;
    if (type === "number") return Number.isFinite(v as number);
    if (type !== "object") return false; // function, symbol, bigint
    if (ArrayBuffer.isView(v as object)) return false;
    if (Array.isArray(v)) {
      if (v.length > LOOSE_ENTRIES) return false;
      return v.every((entry) => walk(entry, depth + 1));
    }
    if (!isPlainObject(v as object)) return false;
    const keys = Object.keys(v as object);
    if (keys.length > LOOSE_ENTRIES) return false;
    return keys.every((key) => walk((v as Record<string, unknown>)[key], depth + 1));
  };
  return walk(value, 0);
}

const encoder = new TextEncoder();

export function jsonBytes(text: string): number {
  return encoder.encode(text).length;
}

/* ------------------------------------------------------------------ */
/* presence                                                            */
/* ------------------------------------------------------------------ */

/** Keys a patch may never introduce, whatever the page passes. */
const SKIPPED_PRESENCE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Merge a patch into the current presence object, per field, latest value
 * wins; a top-level `null` removes the field. Returns the merged object
 * (already round-tripped through JSON, so `undefined` values are gone), or
 * throws a `CapError` and leaves the caller's object untouched.
 */
export function mergePresence(
  current: Record<string, unknown>,
  patch: unknown,
  maxBytes: number,
): Record<string, unknown> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw capError("invalid_argument", "room.presence takes one object of fields to merge");
  }
  const merged: Record<string, unknown> = { ...current };
  for (const key of Object.keys(patch as Record<string, unknown>)) {
    if (SKIPPED_PRESENCE_KEYS.has(key)) continue;
    const value = (patch as Record<string, unknown>)[key];
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  if (!isPlainJson(merged)) {
    throw capError(
      "invalid_argument",
      "presence fields must be plain JSON data - the patch was not applied",
    );
  }
  let text: string;
  try {
    const encoded = JSON.stringify(merged);
    if (typeof encoded !== "string") throw new Error("not serializable");
    text = encoded;
  } catch {
    throw capError("invalid_argument", "presence fields must be plain JSON data");
  }
  if (jsonBytes(text) > maxBytes) {
    throw capError(
      "invalid_argument",
      `your merged presence object serializes over ${maxBytes} bytes - the patch was not applied`,
    );
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* emit payloads                                                       */
/* ------------------------------------------------------------------ */

/** Validate `emit(topic, data)` exactly as the platform module does. */
export function validateEmit(topic: unknown, data: unknown, maxBytes: number): void {
  if (!isTopic(topic)) {
    throw capError(
      "invalid_argument",
      "emit topic must match ^[a-z][a-z0-9_.-]{0,47}$ (colon-free)",
    );
  }
  if (data === undefined) return;
  if (!isPlainJson(data)) {
    throw capError("invalid_argument", "emit data must be plain JSON data");
  }
  let text: string;
  try {
    const encoded = JSON.stringify(data);
    if (typeof encoded !== "string") throw new Error("not serializable");
    text = encoded;
  } catch {
    throw capError("invalid_argument", "emit data must be plain JSON data");
  }
  if (jsonBytes(text) > maxBytes) {
    throw capError("invalid_argument", `emit data serializes over ${maxBytes} bytes`);
  }
}

/* ------------------------------------------------------------------ */
/* the strict ToClaude walker                                          */
/* ------------------------------------------------------------------ */

export const TO_CLAUDE_MAX_BYTES = 4096;
const TO_CLAUDE_DEPTH = 8;
const TO_CLAUDE_KEYS = 64;
const TO_CLAUDE_ENTRIES = 64;
const TO_CLAUDE_JOINERS = 8;
const TO_CLAUDE_BUDGET = 16_384;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

const PICTOGRAPH_RE = /\p{Extended_Pictographic}|\p{Emoji_Modifier}/u;
const HAN_RE = /\p{Script=Han}/u;
const JOINING_RE =
  /\p{Script=Arabic}|\p{Script=Syriac}|\p{Script=Mongolian}|\p{Script=Devanagari}|\p{Script=Bengali}|\p{Script=Gurmukhi}|\p{Script=Gujarati}|\p{Script=Oriya}|\p{Script=Tamil}|\p{Script=Telugu}|\p{Script=Kannada}|\p{Script=Malayalam}|\p{Script=Sinhala}|\p{Script=Myanmar}|\p{Script=Tibetan}|\p{Script=Khmer}/u;
const FORMAT_RE = /\p{Cf}|\p{Co}/u;

/**
 * The explicit invisible-character table (`Le` in the platform module).
 * Ranges are inclusive.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x2800, 0x2800],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0xfffd, 0xfffd],
  [0x16fe4, 0x16fe4],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];

function inTable(cp: number): boolean {
  return INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function isControl(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
}

function isNonCharacter(cp: number): boolean {
  if (cp >= 0xfdd0 && cp <= 0xfdef) return true;
  const low = cp & 0xffff;
  return low === 0xfffe || low === 0xffff;
}

/** What the previous code point can carry: the joiner state machine. */
type Carrier = "none" | "pictograph" | "selector" | "han" | "joining" | "keycap";

const BAD_CHAR =
  "has a control, private-use, format or invisible character " +
  "(strip format characters from picked text before sending)";
const BAD_JOINER =
  "has a joiner or variation selector with no character to carry it (or a run, or more than 8)";

/**
 * Scan one string for characters the platform refuses. Returns the message
 * tail, or `null` when the string is acceptable.
 */
export function checkString(s: string): string | null {
  let carrier: Carrier = "none";
  let joiners = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    // Lone surrogates survive `for...of` as single code units.
    if (cp >= 0xd800 && cp <= 0xdfff) return BAD_CHAR;

    if (cp >= 0xfe00 && cp <= 0xfe0f) {
      const ok =
        carrier === "pictograph" || carrier === "han" || (cp === 0xfe0f && carrier === "keycap");
      if (!ok || ++joiners > TO_CLAUDE_JOINERS) return BAD_JOINER;
      carrier = carrier === "pictograph" ? "selector" : "none";
      continue;
    }
    if (cp >= 0xe0100 && cp <= 0xe01ef) {
      if (carrier !== "han" || ++joiners > TO_CLAUDE_JOINERS) return BAD_JOINER;
      carrier = "none";
      continue;
    }
    if (cp === 0x200d) {
      const ok = carrier === "pictograph" || carrier === "selector" || carrier === "joining";
      if (!ok || ++joiners > TO_CLAUDE_JOINERS) return BAD_JOINER;
      carrier = "none";
      continue;
    }
    if (cp === 0x200c) {
      if (carrier !== "joining" || ++joiners > TO_CLAUDE_JOINERS) return BAD_JOINER;
      carrier = "none";
      continue;
    }

    if (isControl(cp) || isNonCharacter(cp) || inTable(cp) || FORMAT_RE.test(ch)) return BAD_CHAR;

    if (PICTOGRAPH_RE.test(ch)) carrier = "pictograph";
    else if (HAN_RE.test(ch)) carrier = "han";
    else if (JOINING_RE.test(ch)) carrier = "joining";
    else if (/^[#*0-9]$/.test(ch)) carrier = "keycap";
    else carrier = "none";
  }
  return null;
}

function reject(path: string, tail: string): never {
  throw capError("invalid_argument", `room.sendToClaudeSession: ${path} ${tail}`);
}

/**
 * The strict walker. Throws `invalid_argument` naming the offending path
 * (`data.items[3].label`) exactly as the platform's messages do.
 */
export function walkToClaude(root: unknown): void {
  let budget = TO_CLAUDE_BUDGET;
  const walk = (v: unknown, depth: number, path: string): void => {
    if (--budget < 0) reject(path, "the object has too many nodes to check");
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) reject(path, "is not a finite number");
      return;
    }
    if (typeof v === "string") {
      if (v.length > TO_CLAUDE_MAX_BYTES) {
        reject(path, `is longer than the whole object may be (${TO_CLAUDE_MAX_BYTES} bytes)`);
      }
      budget -= v.length;
      if (budget < 0) {
        reject(
          path,
          `carries more text than the whole object may (${TO_CLAUDE_MAX_BYTES} bytes)`,
        );
      }
      const bad = checkString(v);
      if (bad) reject(path, bad);
      return;
    }
    if (typeof v !== "object") reject(path, "is not plain JSON data"); // function, symbol, bigint
    if (ArrayBuffer.isView(v as object)) reject(path, "is not plain JSON data");
    if (depth >= TO_CLAUDE_DEPTH) reject(path, `nests deeper than ${TO_CLAUDE_DEPTH}`);
    if (Array.isArray(v)) {
      if (v.length > TO_CLAUDE_ENTRIES) reject(path, `has more than ${TO_CLAUDE_ENTRIES} entries`);
      v.forEach((entry, index) => walk(entry, depth + 1, `${path}[${index}]`));
      return;
    }
    if (!isPlainObject(v as object)) reject(path, "is not a plain object");
    const keys = Object.keys(v as object);
    if (keys.length > TO_CLAUDE_KEYS) reject(path, `has more than ${TO_CLAUDE_KEYS} keys`);
    for (const key of keys) {
      if (!KEY_RE.test(key) || key === "prototype" || key in Object.prototype) {
        reject(
          path,
          `has a key that is not an identifier ([A-Za-z_][A-Za-z0-9_-]*, at most ${TO_CLAUDE_KEYS}) or is a reserved name`,
        );
      }
      walk((v as Record<string, unknown>)[key], depth + 1, `${path}.${key}`);
    }
  };
  walk(root, 0, "data");
}

/**
 * The full `sendToClaudeSession` argument check. Returns the value to send
 * (the JSON round trip, so nothing exotic crosses `postMessage`), or throws
 * a `CapError`.
 */
export function validateToClaude(data: unknown): Record<string, unknown> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw capError(
      "invalid_argument",
      "room.sendToClaudeSession takes one plain object the artifact defines, e.g. {selectedText, blockId}",
    );
  }
  walkToClaude(data);
  let text: string;
  try {
    const encoded = JSON.stringify(data);
    if (typeof encoded !== "string") throw new Error("not serializable");
    text = encoded;
  } catch {
    throw capError(
      "invalid_argument",
      "room.sendToClaudeSession's object must serialize as JSON",
    );
  }
  const bytes = jsonBytes(text);
  if (bytes > TO_CLAUDE_MAX_BYTES) {
    throw capError(
      "invalid_argument",
      `room.sendToClaudeSession's object may be at most ${TO_CLAUDE_MAX_BYTES} bytes of JSON text; it is ${bytes}`,
    );
  }
  const round = JSON.parse(text) as Record<string, unknown>;
  if (Object.keys(round).length === 0) {
    throw capError("invalid_argument", "nothing to send: the object has no fields");
  }
  return round;
}

/** Narrow anything thrown by the validators above. */
export function asCapError(err: unknown, fallback: string): CapError {
  if (typeof err === "object" && err !== null && typeof (err as CapError).code === "string") {
    return err as CapError;
  }
  return capError("invalid_argument", fallback);
}
