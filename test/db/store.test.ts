/**
 * The filesystem document store: last-writer-wins writes, merge updates,
 * leases, queries and the documented limits.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DbStore,
  docFileName,
  DEFAULT_TTL_MS,
  MAX_DOC_DEPTH,
  MAX_TTL_MS,
  MIN_TTL_MS,
  jsonDepth,
  mergeDeep,
  matchesWhere,
  orderRows,
  validateBody,
  validateQuerySpec,
} from "../../src/capabilities/db/store.ts";

const ARTIFACT = "0123456789abcdef0123456789abcdef";
let dataDir: string;
let store: DbStore;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "db-store-"));
  store = new DbStore(dataDir);
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const invalid = expect.objectContaining({ code: "invalid_argument" });

describe("documents", () => {
  it("writes, reads back and replaces wholesale", async () => {
    await store.set(ARTIFACT, "tasks/t1", { title: "one", done: false });
    expect((await store.read(ARTIFACT, "tasks/t1"))?.data).toEqual({ title: "one", done: false });
    await store.set(ARTIFACT, "tasks/t1", { title: "two" });
    expect((await store.read(ARTIFACT, "tasks/t1"))?.data).toEqual({ title: "two" });
    expect(await store.read(ARTIFACT, "tasks/nope")).toBeNull();
  });

  it("merges nested objects on update and replaces everything else", async () => {
    await store.set(ARTIFACT, "tasks/t2", { a: { x: 1, y: 2 }, list: [1, 2] });
    await store.update(ARTIFACT, "tasks/t2", { a: { y: 9, z: 3 }, list: [7] });
    expect((await store.read(ARTIFACT, "tasks/t2"))?.data).toEqual({
      a: { x: 1, y: 9, z: 3 },
      list: [7],
    });
  });

  it("refuses an update on a document that does not exist", async () => {
    await expect(store.update(ARTIFACT, "tasks/ghost", { a: 1 })).rejects.toThrow(invalid);
  });

  it("deletes idempotently and leaves nested documents alone", async () => {
    await store.set(ARTIFACT, "boards/b1", { name: "board" });
    await store.set(ARTIFACT, "boards/b1/cards/c1", { name: "card" });
    await store.delete(ARTIFACT, "boards/b1");
    await store.delete(ARTIFACT, "boards/b1");
    expect(await store.read(ARTIFACT, "boards/b1")).toBeNull();
    expect(await store.read(ARTIFACT, "boards/b1/cards/c1")).not.toBeNull();
  });

  it("refuses paths that are not document paths", async () => {
    await expect(store.set(ARTIFACT, "tasks", { a: 1 })).rejects.toThrow(invalid);
    await expect(store.read(ARTIFACT, "a/b/c")).rejects.toThrow(invalid);
  });

  it("survives a restart by rebuilding the index from disk", async () => {
    const second = new DbStore(dataDir);
    expect((await second.read(ARTIFACT, "tasks/t1"))?.data).toEqual({ title: "two" });
    const files = await readdir(join(dataDir, "artifacts", ARTIFACT, "db"));
    expect(files.some((f) => f.endsWith(".json"))).toBe(true);
  });

  it("notifies listeners about the paths that changed", async () => {
    const seen: string[] = [];
    const off = store.onChange((id, paths) => {
      if (id === ARTIFACT) seen.push(...paths);
    });
    await store.set(ARTIFACT, "tasks/t3", { a: 1 });
    await store.delete(ARTIFACT, "tasks/t3");
    off();
    await store.set(ARTIFACT, "tasks/t4", { a: 1 });
    expect(seen).toEqual(["tasks/t3", "tasks/t3"]);
  });
});

describe("bodies", () => {
  it("takes plain objects only", () => {
    expect(() => validateBody([1, 2])).toThrow(invalid);
    expect(() => validateBody("text")).toThrow(invalid);
    expect(() => validateBody(null)).toThrow(invalid);
    expect(() => validateBody({ ok: true })).not.toThrow();
  });

  it("enforces the depth and size caps", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < MAX_DOC_DEPTH + 2; i++) deep = { next: deep };
    expect(jsonDepth({ a: { b: 1 } })).toBe(3);
    expect(() => validateBody(deep)).toThrow(invalid);
    expect(() => validateBody({ big: "x".repeat(300 * 1024) })).toThrow(invalid);
  });

  it("merges deeply", () => {
    expect(mergeDeep({ a: { b: 1 }, c: 1 }, { a: { d: 2 }, c: 2 })).toEqual({
      a: { b: 1, d: 2 },
      c: 2,
    });
  });
});

describe("queries", () => {
  const QID = "1111111111111111111111111111aaaa";

  beforeAll(async () => {
    await store.set(QID, "items/a", { n: 3, tag: "x", tags: ["red", "blue"] });
    await store.set(QID, "items/b", { n: 1, tag: "y", tags: ["red"] });
    await store.set(QID, "items/c", { n: 2, tag: "x" });
    await store.set(QID, "items/d", { tag: "z" });
    await store.set(QID, "items/c/notes/n1", { deep: true });
  });

  async function run(spec: Parameters<typeof validateQuerySpec>[0]) {
    const valid = validateQuerySpec(spec);
    const docs = await store.collect(QID, valid.collection);
    const rows = docs
      .filter((doc) => !valid.where?.some((clause) => !matchesWhere(doc.data, clause)))
      .map((doc) => ({ id: doc.path.split("/").pop() as string, data: doc.data }));
    return orderRows(rows, valid).map((row) => row.id);
  }

  it("returns only direct children of the collection", async () => {
    expect(await run({ collection: "items" })).toEqual(["a", "b", "c", "d"]);
  });

  it("orders by id when no orderBy is given", async () => {
    expect(await run({ collection: "items", orderBy: { f: "n", dir: "desc" } })).toEqual([
      "a",
      "c",
      "b",
      "d", // missing the field: last, in both directions
    ]);
  });

  it("filters with the documented operators", async () => {
    expect(await run({ collection: "items", where: [{ f: "tag", op: "==", v: "x" }] })).toEqual([
      "a",
      "c",
    ]);
    expect(await run({ collection: "items", where: [{ f: "n", op: ">=", v: 2 }] })).toEqual([
      "a",
      "c",
    ]);
    expect(
      await run({ collection: "items", where: [{ f: "tag", op: "in", v: ["y", "z"] }] }),
    ).toEqual(["b", "d"]);
    expect(
      await run({ collection: "items", where: [{ f: "tags", op: "array-contains", v: "blue" }] }),
    ).toEqual(["a"]);
    // A document without the field never matches.
    expect(await run({ collection: "items", where: [{ f: "n", op: "!=", v: 1 }] })).toEqual([
      "a",
      "c",
    ]);
  });

  it("windows with limit", async () => {
    expect(await run({ collection: "items", orderBy: { f: "n" }, limit: 2 })).toEqual(["b", "c"]);
  });

  it("refuses a malformed query", () => {
    expect(() => validateQuerySpec({ collection: "items/a" })).toThrow(invalid);
    expect(() => validateQuerySpec({ collection: "items", limit: 5000 })).toThrow(invalid);
    expect(() => validateQuerySpec({ collection: "items", orderBy: { f: "n", dir: "up" } })).toThrow(
      invalid,
    );
    expect(() =>
      validateQuerySpec({ collection: "items", where: [{ f: "n", op: "like", v: 1 }] }),
    ).toThrow(invalid);
  });
});

describe("leases", () => {
  const LID = "2222222222222222222222222222bbbb";

  it("grants, refuses a second holder, and renews for the same one", async () => {
    const first = await store.acquire(LID, "locks/turn", { holder: "tab-1", ttlMs: 5000 });
    expect(first.acquired).toBe(true);
    expect(first.holder).toBe("tab-1");
    expect(typeof first.version).toBe("number");

    const second = await store.acquire(LID, "locks/turn", { holder: "tab-2", ttlMs: 5000 });
    expect(second.acquired).toBe(false);
    // Busy reveals the expiry, never who holds it.
    expect(second.holder).toBeUndefined();
    expect(Date.parse(second.expiresAt as string)).toBeGreaterThan(Date.now());

    const renewed = await store.acquire(LID, "locks/turn", { holder: "tab-1", ttlMs: 5000 });
    expect(renewed.acquired).toBe(true);
  });

  it("clamps the ttl instead of rejecting it", async () => {
    const short = await store.acquire(LID, "locks/short", { holder: "h", ttlMs: 1 });
    const long = await store.acquire(LID, "locks/long", { holder: "h", ttlMs: 10 * MAX_TTL_MS });
    const bare = await store.acquire(LID, "locks/bare", { holder: "h" });
    const at = (r: { expiresAt?: string }) => Date.parse(r.expiresAt as string) - Date.now();
    expect(at(short)).toBeGreaterThan(MIN_TTL_MS - 500);
    expect(at(short)).toBeLessThanOrEqual(MIN_TTL_MS + 100);
    expect(at(long)).toBeGreaterThan(MAX_TTL_MS - 500);
    expect(at(bare)).toBeGreaterThan(DEFAULT_TTL_MS - 500);
  });

  it("lets a new holder in once the lease has lapsed", async () => {
    await store.acquire(LID, "locks/lapse", { holder: "first", ttlMs: MIN_TTL_MS });
    await new Promise((resolve) => setTimeout(resolve, MIN_TTL_MS + 60));
    const next = await store.acquire(LID, "locks/lapse", { holder: "second" });
    expect(next.acquired).toBe(true);
  });

  it("merges its data into the document and needs a holder", async () => {
    await store.acquire(LID, "locks/data", { holder: "h", data: { by: "h" } });
    expect((await store.read(LID, "locks/data"))?.data).toEqual({ by: "h" });
    await expect(store.acquire(LID, "locks/data", { holder: "" })).rejects.toThrow(invalid);
  });
});

describe("on-disk names", () => {
  const DISK = "3333333333333333333333333333cccc";
  const VIEWER = "u_AAAAAAAAAAAAAAAAAAAAAA";
  /** How documents were named before the name became a hash of the path. */
  const legacyName = (path: string) =>
    `${path.split("/").map(encodeURIComponent).join("__")}.json`;

  it("gives every path in the grammar its own file", () => {
    // "_" and "/" both live inside the segment grammar, so a separator-joined
    // encoding cannot separate these paths; the hash must.
    expect(docFileName("data/users/u_1/profile")).not.toBe(docFileName("data__users__u_1/profile"));
    const alphabet = ["a", "_", "__", "-", ".", "~", ":", "@", "+", "x_y"];
    const paths = new Set<string>();
    for (const a of alphabet) {
      for (const b of alphabet) {
        paths.add(`${a}/${b}`);
        paths.add(`${a}${b}/a`);
        paths.add(`${a}/${b}/a/b`);
      }
    }
    const names = new Set([...paths].map(docFileName));
    expect(names.size).toBe(paths.size);
  });

  it("keeps a private document out of reach of a colliding public path", async () => {
    const store = new DbStore(dataDir);
    const secret = `data/users/${VIEWER}/profile`;
    const collides = `data__users__${VIEWER}/profile`;
    await store.set(DISK, secret, { email: "victim@example.com" });
    await store.set(DISK, collides, { owned: true });
    await store.delete(DISK, collides);
    // The attacker's write and delete touched only their own file.
    store.forget(DISK);
    expect((await store.read(DISK, secret))?.data).toEqual({ email: "victim@example.com" });
    expect(await store.read(DISK, collides)).toBeNull();
  });

  it("persists a path too long to spell out in a file name", async () => {
    const store = new DbStore(dataDir);
    const long = [1, 2, 3, 4].map((n) => `${String(n).repeat(200)}`).join("/");
    await store.set(DISK, long, { ok: true });
    store.forget(DISK);
    expect((await store.read(DISK, long))?.data).toEqual({ ok: true });
  });

  it("adopts a legacy-named file, so a later delete really removes it", async () => {
    const legacyDir = await mkdtemp(join(tmpdir(), "db-legacy-"));
    try {
      const dir = join(legacyDir, "artifacts", DISK, "db");
      const path = "tasks/legacy";
      const doc = { path, data: { title: "written by an older build" }, rev: 1, updatedAt: "2026-01-01T00:00:00.000Z" };
      await rm(dir, { recursive: true, force: true });
      await new DbStore(legacyDir).set(DISK, "tasks/seed", { a: 1 });
      await writeFile(join(dir, legacyName(path)), JSON.stringify(doc));

      const store = new DbStore(legacyDir);
      expect((await store.read(DISK, path))?.data).toEqual({ title: "written by an older build" });
      const afterLoad = await readdir(dir);
      expect(afterLoad).toContain(docFileName(path));
      expect(afterLoad).not.toContain(legacyName(path));
      expect(JSON.parse(await readFile(join(dir, docFileName(path)), "utf8")).path).toBe(path);

      await store.delete(DISK, path);
      expect(await readdir(dir)).not.toContain(docFileName(path));
      // And it stays gone once the index is rebuilt from disk.
      expect(await new DbStore(legacyDir).read(DISK, path)).toBeNull();
    } finally {
      await rm(legacyDir, { recursive: true, force: true });
    }
  });
});
