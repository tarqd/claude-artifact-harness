/**
 * The room lane: the small JSON protocol the shell broker and the server
 * speak over the websocket at `/api/frame/room/ws`, plus the topic ACL both
 * sides evaluate.
 *
 * This is OUR wire, not the platform's: claude.ai's contract stops at the
 * `__frame_cap` / `__frame_room_ev` boundary, and everything below it is a
 * self-hosting detail. Keeping it in one file means the broker and the
 * server can never disagree about a field name.
 */

/** Sharing levels, ordered. `owner` and `admin` are "can edit". */
export const LEVEL_ORDER: Readonly<Record<string, number>> = Object.freeze({
  view: 0,
  interact: 1,
  admin: 2,
  owner: 3,
});

/** A topic level from the declaration. Anything else is treated as admin. */
export type TopicLevel = "interact" | "admin";

/** At most 16 exact-match topics may be opened (room.d.ts). */
export const MAX_DECLARED_TOPICS = 16;

/**
 * Read `capabilities.room.config.topics` into a map. Entries past the
 * sixteenth, malformed names and unknown levels are dropped rather than
 * widening the default: a topic that is not understood stays admin-only.
 */
export function readTopics(config: unknown): Map<string, TopicLevel> {
  const out = new Map<string, TopicLevel>();
  if (typeof config !== "object" || config === null) return out;
  const topics = (config as { topics?: unknown }).topics;
  if (typeof topics !== "object" || topics === null || Array.isArray(topics)) return out;
  for (const [name, level] of Object.entries(topics as Record<string, unknown>)) {
    if (out.size >= MAX_DECLARED_TOPICS) break;
    if (level === "interact" || level === "admin") out.set(name, level);
  }
  return out;
}

/**
 * May a viewer at `level` emit on `topic`? Unlisted topics are admin-only —
 * the declaration opens topics, it never closes them.
 */
export function mayEmit(topic: string, level: string, topics: Map<string, TopicLevel>): boolean {
  const required = topics.get(topic) ?? "admin";
  const have = LEVEL_ORDER[level] ?? 0;
  const need = LEVEL_ORDER[required] ?? LEVEL_ORDER.admin!;
  return have >= need;
}

/* ------------------------------------------------------------------ */
/* lane messages                                                       */
/* ------------------------------------------------------------------ */

/** broker → server */
export type LaneRequest =
  | { kind: "presence"; p: Record<string, unknown> }
  | { kind: "emit"; topic: string; d?: unknown }
  | { kind: "ping" };

/** server → broker */
export type LaneEvent =
  | { kind: "welcome"; peer: string }
  | { kind: "presence"; peer: string; p: Record<string, unknown>; isMe: boolean }
  | { kind: "event"; peer: string; topic: string; d?: unknown; isMe: boolean; sameTab: boolean }
  | { kind: "gone"; peer: string }
  | { kind: "revoked"; code?: string }
  | { kind: "pong" };

/** Peer ids are minted by the shell and are opaque to the page. */
export const PEER_ID_RE = /^[a-z0-9]{16,32}$/;

export function isPeerId(v: unknown): v is string {
  return typeof v === "string" && PEER_ID_RE.test(v);
}

const PEER_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** 252 = 7 x 36: bytes at or above it are redrawn so no letter is favoured. */
const PEER_BYTE_CEILING = 252;
const PEER_ID_LENGTH = 16;

/** 16 characters, the shape the contract's own example uses, all random. */
export function mintPeerId(): string {
  const bytes = new Uint8Array(PEER_ID_LENGTH);
  let out = "";
  while (out.length < PEER_ID_LENGTH) {
    globalThis.crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= PEER_BYTE_CEILING) continue; // biased draw: take another byte
      out += PEER_ALPHABET[byte % 36];
      if (out.length === PEER_ID_LENGTH) break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* limits                                                              */
/* ------------------------------------------------------------------ */

/**
 * The bounds the frame enforces on the page — and, since the wire carries
 * exactly what the frame produced, the same bounds the server enforces on
 * the lane. One table so the two halves can never drift apart.
 */
export interface RoomLimits {
  maxBytes: number;
  presenceHz: number;
  keepaliveMs: number;
  silenceMs: number;
  maxPeers: number;
}

const LIMIT_SPECS = {
  maxBytes: { fallback: 4096, min: 1024, max: 65_536 },
  presenceHz: { fallback: 30, min: 1, max: 120 },
  keepaliveMs: { fallback: 20_000, min: 1000, max: 600_000 },
  silenceMs: { fallback: 150_000, min: 10_000, max: 3_600_000 },
  maxPeers: { fallback: 256, min: 2, max: 4096 },
} as const;

/** The largest `maxBytes` any declaration can ask for. */
export const MAX_LIMIT_BYTES = LIMIT_SPECS.maxBytes.max;

/** `config.limits`, clamped. A non-finite or out-of-range value is ignored. */
export function readLimits(config: unknown): RoomLimits {
  const raw =
    typeof config === "object" && config !== null
      ? (config as { limits?: unknown }).limits
      : undefined;
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out = {} as RoomLimits;
  for (const key of Object.keys(LIMIT_SPECS) as Array<keyof RoomLimits>) {
    const spec = LIMIT_SPECS[key];
    const value = source[key];
    out[key] =
      typeof value === "number" && Number.isFinite(value)
        ? Math.min(spec.max, Math.max(spec.min, Math.round(value)))
        : spec.fallback;
  }
  return out;
}
