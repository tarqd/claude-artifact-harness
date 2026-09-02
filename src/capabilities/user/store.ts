/**
 * The viewer directory: display names, and which artifacts a viewer has been
 * seen on. Small, boring, on the filesystem like the rest of the backend.
 *
 *   <DATA_DIR>/users/profiles/<viewerId>.json   {id, name, updatedAt}
 *   <DATA_DIR>/users/peers/<artifactId>.json    {ids: [viewerId, ...]}  (LRU)
 *
 * The peer list is the privacy boundary: `search` only ever sees viewers who
 * have themselves opened the artifact doing the searching, so one artifact
 * can never enumerate another's audience.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isArtifactId, isUserId } from "../../protocol/paths.ts";
import { MAX_NAME_CHARS } from "./identity.ts";

export interface StoredProfile {
  id: string;
  name: string;
  updatedAt: string;
}

/** How many peers one artifact remembers; the least recently seen fall off. */
export const MAX_PEERS = 1000;
/** How many rows one `search` returns. */
export const SEARCH_LIMIT = 20;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export class UserStore {
  private readonly root: string;
  /** Serialises writes per file, so two viewers cannot lose each other's row. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(dataDir: string) {
    this.root = join(dataDir, "users");
  }

  private profilePath(viewerId: string): string {
    return join(this.root, "profiles", `${viewerId}.json`);
  }

  private peersPath(artifactId: string): string {
    return join(this.root, "peers", `${artifactId}.json`);
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.locks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, path);
  }

  private async readJson(path: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      return null;
    }
  }

  /** One viewer's stored row, or null when they have never been named. */
  async profile(viewerId: string): Promise<StoredProfile | null> {
    if (!isUserId(viewerId)) return null;
    const raw = await this.readJson(this.profilePath(viewerId));
    if (!isRecord(raw) || raw.id !== viewerId) return null;
    return {
      id: viewerId,
      name: typeof raw.name === "string" ? raw.name.slice(0, MAX_NAME_CHARS) : "",
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    };
  }

  /** Set (or clear, with `""`) a viewer's display name. */
  async setName(viewerId: string, name: string): Promise<StoredProfile> {
    if (!isUserId(viewerId)) throw new Error("bad viewer id");
    const row: StoredProfile = {
      id: viewerId,
      name: name.slice(0, MAX_NAME_CHARS),
      updatedAt: new Date().toISOString(),
    };
    await this.withLock(`p:${viewerId}`, () => this.writeJson(this.profilePath(viewerId), row));
    return row;
  }

  /**
   * Record that this viewer has opened this artifact, most recently seen
   * last. Eviction is therefore least-recently-seen first: a burst of new
   * viewers cannot push an active one (the owner, say) out of the window.
   */
  async touch(artifactId: string, viewerId: string): Promise<void> {
    if (!isArtifactId(artifactId) || !isUserId(viewerId)) return;
    await this.withLock(`a:${artifactId}`, async () => {
      const ids = await this.readPeers(artifactId);
      // Already the most recent: nothing to reorder, and no write.
      if (ids[ids.length - 1] === viewerId) return;
      const kept = ids.filter((id) => id !== viewerId);
      kept.push(viewerId);
      const trimmed = kept.length > MAX_PEERS ? kept.slice(kept.length - MAX_PEERS) : kept;
      await this.writeJson(this.peersPath(artifactId), { ids: trimmed });
    });
  }

  private async readPeers(artifactId: string): Promise<string[]> {
    const raw = await this.readJson(this.peersPath(artifactId));
    if (!isRecord(raw) || !Array.isArray(raw.ids)) return [];
    return raw.ids.filter((id): id is string => isUserId(id));
  }

  /** Everyone who has opened this artifact, least recently seen first. */
  async peers(artifactId: string): Promise<string[]> {
    if (!isArtifactId(artifactId)) return [];
    return this.readPeers(artifactId);
  }

  async isPeer(artifactId: string, viewerId: string): Promise<boolean> {
    const ids = await this.peers(artifactId);
    return ids.includes(viewerId);
  }

  /**
   * Resolve ids a viewer of `artifactId` may see: peers of that artifact,
   * plus the caller themselves. Anything else is simply absent from the
   * answer — the frame then draws its deterministic placeholder.
   */
  async resolve(
    artifactId: string,
    callerId: string | null,
    ids: readonly string[],
  ): Promise<StoredProfile[]> {
    const visible = new Set(await this.peers(artifactId));
    if (callerId) visible.add(callerId);
    const out: StoredProfile[] = [];
    for (const id of ids) {
      if (!visible.has(id)) continue;
      const row = await this.profile(id);
      if (row) out.push(row);
    }
    return out;
  }

  /** Case-insensitive substring match over the artifact's peers, by name. */
  async search(artifactId: string, query: string, limit = SEARCH_LIMIT): Promise<StoredProfile[]> {
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    const out: StoredProfile[] = [];
    for (const id of await this.peers(artifactId)) {
      const row = await this.profile(id);
      if (!row || row.name === "") continue;
      if (!row.name.toLowerCase().includes(needle)) continue;
      out.push(row);
      if (out.length >= limit) break;
    }
    return out;
  }
}
