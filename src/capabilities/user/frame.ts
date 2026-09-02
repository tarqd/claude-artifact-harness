/**
 * `user` — the page-facing namespace (surface-area.md §5.1).
 *
 *   id() isOwner() canEdit()   answered from `__frame_init` config, no RPC
 *   name() avatarUrl() me()    the `profile` (and `email`) backend calls
 *   email()                    only when the artifact declared the scope
 *   profiles(ids) search(q)    the viewer directory
 *
 * Two rules shape everything here. First, **no method ever rejects**: every
 * failure — a refusal, a malformed reply, no reply at all — becomes a benign
 * default (`null`, `false`, `""`, `[]`, an unresolved profile), because a
 * page decorating a byline must not break when identity is unavailable. That
 * is why the RPC client is built with a 20 s budget that *resolves* `null`
 * instead of rejecting. Second, an id that cannot be resolved still gets a
 * stable colour and a data-URI circle avatar, so avatars never flicker
 * between renders.
 */
import { createRpc, type RpcHost } from "../../frame/rpc.ts";
import type { FrameContext } from "../../frame/types.ts";
import { isUserId } from "../../protocol/paths.ts";
import {
  avatarDataUri,
  colorForId,
  MAX_PROFILE_BATCHES,
  MAX_PROFILE_IDS,
  normalizeIds,
  normalizeQuery,
  readWireProfile,
  type WireProfile,
} from "./identity.ts";

const CAP = "user";

/** The reply budget for every `user` call; a timeout resolves `null`. */
export const USER_TIMEOUT_MS = 20_000;

/** `__frame_init.capabilities.user.config`, after reading it defensively. */
export interface UserConfig {
  id: string | null;
  owner: boolean;
  canEdit: boolean;
  profile: boolean;
  email: boolean;
}

export interface Profile {
  id: string;
  name: string;
  avatarUrl: string | null;
  color: string;
  email: string | null;
  isMe: boolean;
}

export interface Me {
  id: string | null;
  name: string;
  avatarUrl: string | null;
  color: string;
  email: string | null;
  isOwner: boolean;
  canEdit: boolean;
}

export interface UserNamespace {
  id(): Promise<string | null>;
  isOwner(): Promise<boolean>;
  canEdit(): Promise<boolean>;
  name(): Promise<string>;
  avatarUrl(): Promise<string | null>;
  email(): Promise<string | null>;
  me(): Promise<Me>;
  profiles(ids: unknown): Promise<Record<string, Profile>>;
  search(q: unknown): Promise<Profile[]>;
}

/** The slice of `document` this module uses; a seam so tests need no DOM. */
export interface VisibilityDoc {
  visibilityState?: string;
  addEventListener(type: string, listener: () => void): void;
}

export interface CreateUserOptions {
  /** Test seam: stand in for `parent.postMessage`. */
  host?: RpcHost;
  /** Test seam: stand in for `document` (pass `null` for "no document"). */
  doc?: VisibilityDoc | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * The config is whatever the shell put in `__frame_init`; a missing or
 * malformed field is the conservative answer, never a thrown error.
 */
export function readConfig(raw: unknown): UserConfig {
  const c = isRecord(raw) ? raw : {};
  return {
    id: typeof c.id === "string" && c.id !== "" ? c.id : null,
    owner: c.owner === true,
    canEdit: c.canEdit === true,
    profile: c.profile === true,
    email: c.email === true,
  };
}

/** An id nobody could resolve: right colour, right avatar, empty name. */
export function unresolvedProfile(id: string, isMe: boolean): Profile {
  return {
    id,
    name: "",
    avatarUrl: avatarDataUri(id),
    color: colorForId(id),
    email: null,
    isMe,
  };
}

function toProfile(wire: WireProfile, isMe: boolean): Profile {
  return {
    id: wire.id,
    name: wire.name,
    // No stored picture is not "no avatar": the deterministic circle stands in.
    avatarUrl: wire.avatarUrl ?? avatarDataUri(wire.id),
    color: colorForId(wire.id),
    email: wire.email ?? null,
    isMe,
  };
}

/** The default `document` seam, absent outside a browser (unit tests). */
function defaultDoc(): VisibilityDoc | null {
  return typeof document === "undefined" ? null : (document as unknown as VisibilityDoc);
}

export function createUser(ctx: FrameContext, options: CreateUserOptions = {}): UserNamespace {
  const config = readConfig(ctx.capabilities?.[CAP]?.config);
  const rpc = createRpc({
    cap: CAP,
    shellOrigin: ctx.shellOrigin,
    timeoutMs: USER_TIMEOUT_MS,
    host: options.host,
    // "resolves null (never rejects)" — surface-area.md §4.
    onTimeout: () => ({ resolve: null }),
  });
  const pipe = ctx.pipe(CAP);

  /* ----------------------------- caches ----------------------------- */

  /** Resolved directory entries, keyed by id. */
  const directory = new Map<string, WireProfile>();
  /** `undefined` = not fetched yet; `null` = fetched and unavailable. */
  let selfProfile: WireProfile | null | undefined;
  let selfEmail: string | null | undefined;
  /**
   * Bumped by every cache clear. A reply that was already in flight when the
   * tab became visible again carries the epoch it was sent under, so it can
   * answer its own caller without quietly repopulating the cleared cache.
   */
  let epoch = 0;
  /** In-flight self calls, so concurrent readers share one round trip. */
  let selfProfileCall: Promise<WireProfile | null> | null = null;
  let selfEmailCall: Promise<string | null> | null = null;

  const clearCaches = (): void => {
    epoch += 1;
    directory.clear();
    selfProfile = undefined;
    selfEmail = undefined;
    selfProfileCall = null;
    selfEmailCall = null;
  };

  // The platform drops its profile cache when the tab is shown again, so a
  // page left open overnight redraws with names as they are now.
  const doc = options.doc === undefined ? defaultDoc() : options.doc;
  if (doc) {
    try {
      doc.addEventListener("visibilitychange", () => {
        if (doc.visibilityState === "hidden") return;
        clearCaches();
      });
    } catch {
      /* an exotic document: the cache simply lives for the page's lifetime */
    }
  }

  /* ------------------------------ calls ----------------------------- */

  /** Every backend call funnels through here: a failure is `null`, never a throw. */
  async function ask<T>(method: string, args: unknown[]): Promise<T | null> {
    try {
      const result = await rpc.call<T>(method, args);
      return (result ?? null) as T | null;
    } catch {
      return null;
    }
  }

  function fetchSelfProfile(): Promise<WireProfile | null> {
    if (!config.profile || config.id === null) return Promise.resolve(null);
    if (selfProfile !== undefined) return Promise.resolve(selfProfile);
    // One round trip however many of name()/avatarUrl()/me() ask at once.
    if (selfProfileCall) return selfProfileCall;
    const mine = epoch;
    const call = (async (): Promise<WireProfile | null> => {
      const reply = await ask<unknown>("profile", []);
      const wire = readWireProfile(reply);
      // A reply that raced a cache clear still answers its own caller, but it
      // does not repopulate the cleared cache: the next read fetches again.
      if (mine === epoch) {
        // Still the current epoch, so this is still the call parked in
        // `selfProfileCall`; a clear would have dropped it already.
        selfProfile = wire;
        selfProfileCall = null;
        if (wire) directory.set(wire.id, wire);
      }
      return wire;
    })();
    selfProfileCall = call;
    return call;
  }

  function fetchSelfEmail(): Promise<string | null> {
    if (!config.email) return Promise.resolve(null);
    if (selfEmail !== undefined) return Promise.resolve(selfEmail);
    if (selfEmailCall) return selfEmailCall;
    const mine = epoch;
    const call = (async (): Promise<string | null> => {
      const reply = await ask<unknown>("email", []);
      // The broker answers `{email}`; a bare string is accepted too.
      let address: string | null = null;
      if (typeof reply === "string") address = reply || null;
      else if (isRecord(reply) && typeof reply.email === "string") address = reply.email || null;
      if (mine === epoch) {
        selfEmail = address;
        selfEmailCall = null;
      }
      return address;
    })();
    selfEmailCall = call;
    return call;
  }

  /**
   * Everything this call could resolve, whether from the cache or the wire.
   * The answer is returned rather than only cached, so a reply that raced a
   * cache clear still serves its own caller without outliving it.
   */
  async function resolveMany(ids: readonly string[]): Promise<Map<string, WireProfile>> {
    const known = new Map<string, WireProfile>();
    for (const id of ids) {
      const wire = directory.get(id);
      if (wire) known.set(id, wire);
    }
    // Only ids of the documented shape reach the wire; anything else could
    // not be a viewer, so it goes straight to its unresolved default.
    const missing = ids.filter((id) => !known.has(id) && isUserId(id));
    const wanted = Math.min(missing.length, MAX_PROFILE_IDS * MAX_PROFILE_BATCHES);
    // The wire batch stays at 128 ids; a longer list is chunked, and anything
    // past the last chunk keeps its unresolved placeholder.
    for (let from = 0; from < wanted; from += MAX_PROFILE_IDS) {
      const batch = missing.slice(from, from + MAX_PROFILE_IDS);
      const mine = epoch;
      const reply = await ask<unknown>("profiles", [batch]);
      if (!isRecord(reply)) continue;
      for (const value of Object.values(reply)) {
        const wire = readWireProfile(value);
        if (!wire) continue;
        known.set(wire.id, wire);
        if (mine === epoch) directory.set(wire.id, wire);
      }
    }
    return known;
  }

  /* --------------------------- the namespace ------------------------ */

  const id = pipe.wrap("id", (): string | null => config.id);
  const isOwner = pipe.wrap("isOwner", (): boolean => config.owner);
  const canEdit = pipe.wrap("canEdit", (): boolean => config.canEdit);

  const name = pipe.wrap("name", async (): Promise<string> => {
    const profile = await fetchSelfProfile();
    return profile?.name ?? "";
  });

  const avatarUrl = pipe.wrap("avatarUrl", async (): Promise<string | null> => {
    if (config.id === null) return null;
    const profile = await fetchSelfProfile();
    // The platform's module answers the profile's picture or null here; only
    // `me()` and `profiles()` fill in the placeholder circle.
    return profile?.avatarUrl ?? null;
  });

  const email = pipe.wrap("email", (): Promise<string | null> => fetchSelfEmail());

  const me = pipe.wrap("me", async (): Promise<Me> => {
    const [profile, address] = await Promise.all([fetchSelfProfile(), fetchSelfEmail()]);
    return {
      id: config.id,
      name: profile?.name ?? "",
      avatarUrl:
        config.id === null ? null : (profile?.avatarUrl ?? avatarDataUri(config.id)),
      color: colorForId(config.id ?? ""),
      email: address,
      isOwner: config.owner,
      canEdit: config.canEdit,
    };
  });

  const profiles = pipe.wrap(
    "profiles",
    async (input: unknown): Promise<Record<string, Profile>> => {
      // Every id the page asked about gets an entry: a caller indexing the
      // map must never find `undefined`, however long its list was.
      const ids = normalizeIds(input, Number.POSITIVE_INFINITY);
      const out: Record<string, Profile> = {};
      if (ids.length === 0) return out;
      const known = config.profile ? await resolveMany(ids) : new Map<string, WireProfile>();
      for (const each of ids) {
        const isMe = config.id !== null && each === config.id;
        const wire = known.get(each);
        out[each] = wire ? toProfile(wire, isMe) : unresolvedProfile(each, isMe);
      }
      return out;
    },
  );

  // "latest call wins": a superseded search resolves with the newest result
  // rather than its own stale one, so a per-keystroke caller cannot render
  // an older list over a newer one.
  let searchSeq = 0;
  let latestSearch: { seq: number; promise: Promise<Profile[]> } | null = null;

  const runSearch = async (query: string): Promise<Profile[]> => {
    const reply = await ask<unknown>("search", [query]);
    if (!Array.isArray(reply)) return [];
    const out: Profile[] = [];
    for (const entry of reply) {
      const wire = readWireProfile(entry);
      if (!wire) continue;
      directory.set(wire.id, wire);
      out.push(toProfile(wire, config.id !== null && wire.id === config.id));
    }
    return out;
  };

  const search = pipe.wrap("search", async (input: unknown): Promise<Profile[]> => {
    const query = normalizeQuery(input);
    // An empty query supersedes too: clearing the box is the case where a
    // stale in-flight search must not repaint the list the page just emptied.
    const seq = ++searchSeq;
    if (query === "" || !config.profile) {
      latestSearch = null;
      return [];
    }
    const promise = runSearch(query);
    latestSearch = { seq, promise };
    const mine = await promise;
    if (seq === searchSeq) return mine;
    const newest = latestSearch;
    // Superseded: answer with the newest search's rows, or with nothing when
    // the newest call was the empty query that cleared them.
    if (!newest || newest.seq <= seq) return [];
    return newest.promise.catch(() => [] as Profile[]);
  });

  return {
    id,
    isOwner,
    canEdit,
    name,
    avatarUrl,
    email,
    me,
    profiles,
    search,
  };
}

export function install(ctx: FrameContext): void {
  ctx.mount(CAP, createUser(ctx));
}
