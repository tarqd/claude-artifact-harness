/**
 * Filesystem store under `DATA_DIR` (design.md "Backend storage").
 *
 *   artifacts/<id>/meta.json
 *   artifacts/<id>/versions/<ver>/<path...>
 *   artifacts/<id>/blobs/<id>            (assets slice)
 *   artifacts/<id>/db/                   (db slice)
 *
 * Publishing is compare-and-set on the current version id. Writes for one
 * artifact are serialised through a single-process lock.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { capError } from "../protocol/errors.ts";
import {
  isArtifactFilePath,
  isArtifactId,
  isVersionId,
  mintArtifactId,
  nextVersionId,
} from "../protocol/paths.ts";

export interface ArtifactMeta {
  id: string;
  title: string;
  favicon: string | null;
  /** The declaration: capability name → `{config}`. */
  capabilities: Record<string, { config?: unknown }>;
  currentVersion: string;
  owner: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublishInput {
  /** The version this view is running; the compare half of compare-and-set. */
  baseVersion: string;
  /** Full-page publish. */
  html?: string;
  /** Files publish: path → contents, or null to delete. */
  files?: Record<string, { content: Buffer; contentType: string } | null>;
  actor: string | null;
  /**
   * A `publish(html)` from a page must send a complete document (the
   * contract says so). Tooling may publish author body content, which the
   * serve-time envelope wraps.
   */
  requireDoctype?: boolean;
}

export interface PublishResult {
  version: string;
}

export interface StoredFile {
  body: Buffer;
  contentType: string;
}

const META = "meta.json";
const MAX_HTML_BYTES = 16 * 1024 * 1024;
/** One version's bytes, new and carried over together (artifact.d.ts `too_large`). */
const MAX_VERSION_BYTES = 16 * 1024 * 1024;

const TEXT_TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain",
  md: "text/markdown",
  xml: "application/xml",
  svg: "image/svg+xml",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
  wasm: "application/wasm",
};

export function contentTypeForPath(path: string): string | null {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  return TEXT_TYPES[ext] ?? null;
}

/** `<title>` from the first 8 KB, as the platform reads it. */
export function extractTitle(html: string): string | null {
  const head = html.slice(0, 8192);
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  if (!match?.[1]) return null;
  const title = match[1].replace(/\s+/g, " ").trim();
  return title.length ? title.slice(0, 200) : null;
}

export class Store {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  private artifactDir(id: string): string {
    if (!isArtifactId(id)) throw capError("invalid_content", "bad artifact id");
    return join(this.root, "artifacts", id);
  }

  private versionDir(id: string, version: string): string {
    if (!isVersionId(version)) throw capError("invalid_content", "bad version id");
    return join(this.artifactDir(id), "versions", version);
  }

  /** Serialise writes per artifact so compare-and-set is actually atomic. */
  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.locks.set(
      id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async readMeta(id: string): Promise<ArtifactMeta | null> {
    try {
      const raw = await readFile(join(this.artifactDir(id), META), "utf8");
      return JSON.parse(raw) as ArtifactMeta;
    } catch {
      return null;
    }
  }

  private async writeMeta(meta: ArtifactMeta): Promise<void> {
    const dir = this.artifactDir(meta.id);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${META}.tmp`);
    await writeFile(tmp, JSON.stringify(meta, null, 2));
    await rename(tmp, join(dir, META));
  }

  async createArtifact(input: {
    html: string;
    capabilities?: Record<string, { config?: unknown }>;
    title?: string;
    favicon?: string | null;
    owner?: string | null;
  }): Promise<ArtifactMeta> {
    if (typeof input.html !== "string" || input.html.length === 0) {
      throw capError("invalid_content", "html is required");
    }
    if (Buffer.byteLength(input.html) > MAX_HTML_BYTES) {
      throw capError("too_large", "the submitted HTML exceeds the size limit");
    }
    const id = mintArtifactId();
    const version = nextVersionId(null);
    const now = new Date().toISOString();
    const meta: ArtifactMeta = {
      id,
      title: input.title ?? extractTitle(input.html) ?? "Artifact",
      favicon: input.favicon ?? null,
      capabilities: input.capabilities ?? {},
      currentVersion: version,
      owner: input.owner ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeVersionFile(id, version, "index.html", Buffer.from(input.html, "utf8"));
    await this.writeMeta(meta);
    return meta;
  }

  private async writeVersionFile(
    id: string,
    version: string,
    path: string,
    body: Buffer,
  ): Promise<void> {
    if (!isArtifactFilePath(path)) throw capError("invalid_content", `bad file path: ${path}`);
    const target = join(this.versionDir(id, version), path);
    const base = resolve(this.versionDir(id, version));
    if (!resolve(target).startsWith(base + sep)) {
      throw capError("invalid_content", `bad file path: ${path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  /** Bytes one stored file occupies, 0 when it has gone missing. */
  private async fileSize(id: string, version: string, path: string): Promise<number> {
    try {
      const info = await stat(join(this.versionDir(id, version), path));
      return info.isFile() ? info.size : 0;
    } catch {
      return 0;
    }
  }

  async listVersionFiles(id: string, version: string): Promise<string[]> {
    const base = this.versionDir(id, version);
    const out: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
        else out.push(rel);
      }
    };
    await walk(base, "");
    return out.sort();
  }

  async readVersionFile(id: string, version: string, path: string): Promise<StoredFile | null> {
    if (!isArtifactFilePath(path)) return null;
    const base = resolve(this.versionDir(id, version));
    const target = resolve(join(base, path));
    if (target !== base && !target.startsWith(base + sep)) return null;
    try {
      const info = await stat(target);
      if (!info.isFile()) return null;
      const body = await readFile(target);
      const sidecar = await readFile(`${target}.type`, "utf8").catch(() => null);
      // Lowercased even for a sidecar written before this normalisation
      // landed, so the serve path's document check stays a plain-string test.
      const contentType = (
        sidecar?.trim() ||
        contentTypeForPath(path) ||
        "application/octet-stream"
      ).toLowerCase();
      return { body, contentType };
    } catch {
      return null;
    }
  }

  /**
   * Compare-and-set publish. Rejects `conflict` (carrying the live version)
   * when another writer got there first.
   */
  async publish(id: string, input: PublishInput): Promise<PublishResult> {
    return this.withLock(id, async () => {
      const meta = await this.readMeta(id);
      if (!meta) throw capError("not_declared", "no such artifact");
      if (input.baseVersion !== meta.currentVersion) {
        throw capError("conflict", "a newer version was published first", {
          live: meta.currentVersion,
        });
      }
      const version = nextVersionId(meta.currentVersion);
      const carried = await this.listVersionFiles(id, meta.currentVersion);

      // Validate and measure everything before a single byte is written, so
      // an oversized publish leaves no half-built version behind.
      const replaced = new Set<string>();
      const deleted = new Set<string>();
      let bytes = 0;
      if (typeof input.html === "string") {
        bytes = Buffer.byteLength(input.html);
        if (bytes > MAX_HTML_BYTES) {
          throw capError("too_large", "the submitted HTML exceeds the size limit");
        }
        if (input.requireDoctype && !/^\s*<!doctype html/i.test(input.html)) {
          throw capError("invalid_content", "the submitted string is not an HTML page");
        }
        replaced.add("index.html");
      }
      const files = Object.entries(input.files ?? {});
      for (const [path, file] of files) {
        if (!isArtifactFilePath(path)) {
          throw capError("invalid_content", `${path}: not a storable path`);
        }
        if (file === null) {
          deleted.add(path);
          continue;
        }
        bytes += file.content.byteLength + Buffer.byteLength(file.contentType);
        replaced.add(path);
      }
      // Files carried over from the previous version count against the same
      // budget: the limit is on a version, not on one call's payload.
      for (const path of carried) {
        const base = path.endsWith(".type") ? path.slice(0, -5) : path;
        if (replaced.has(base) || deleted.has(base) || replaced.has(path)) continue;
        bytes += await this.fileSize(id, meta.currentVersion, path);
      }
      if (bytes > MAX_VERSION_BYTES) {
        throw capError("too_large", "the submitted files together exceed the size limit");
      }

      if (typeof input.html === "string") {
        await this.writeVersionFile(id, version, "index.html", Buffer.from(input.html, "utf8"));
      }
      for (const [path, file] of files) {
        if (file === null) continue;
        await this.writeVersionFile(id, version, path, file.content);
        await this.writeVersionFile(
          id,
          version,
          `${path}.type`,
          Buffer.from(file.contentType, "utf8"),
        );
      }

      for (const path of carried) {
        const base = path.endsWith(".type") ? path.slice(0, -5) : path;
        if (replaced.has(base) || deleted.has(base) || replaced.has(path)) continue;
        const existing = await this.readVersionFile(id, meta.currentVersion, path);
        if (existing) await this.writeVersionFile(id, version, path, existing.body);
      }

      meta.currentVersion = version;
      meta.updatedAt = new Date().toISOString();
      const indexFile = await this.readVersionFile(id, version, "index.html");
      if (indexFile) {
        const title = extractTitle(indexFile.body.toString("utf8"));
        if (title) meta.title = title;
      }
      await this.writeMeta(meta);
      return { version };
    });
  }

  async deleteArtifact(id: string): Promise<void> {
    await rm(this.artifactDir(id), { recursive: true, force: true });
  }
}

export function createStore(dataDir: string): Store {
  return new Store(dataDir);
}
