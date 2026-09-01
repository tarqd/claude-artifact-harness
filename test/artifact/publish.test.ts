import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "../../src/server/store.ts";
import { isCapError } from "../../src/protocol/errors.ts";
import { validateFiles } from "../../src/capabilities/artifact/frame.ts";

const PAGE = (n: number): string =>
  `<!doctype html><html><head><title>v${n}</title></head><body>${n}</body></html>`;

describe("compare-and-set publish", () => {
  let dir: string;
  let store: Store;
  let id: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artifact-store-"));
    store = createStore(dir);
    const meta = await store.createArtifact({
      html: "<h1>hello</h1>",
      capabilities: { artifact: { config: {} } },
      owner: "u_00000000000000000000AA",
    });
    id = meta.id;
    expect(meta.currentVersion).toBe("v1");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("mints a new version and updates the title", async () => {
    const result = await store.publish(id, { baseVersion: "v1", html: PAGE(2), actor: null });
    expect(result.version).toBe("v2");
    const meta = await store.readMeta(id);
    expect(meta?.currentVersion).toBe("v2");
    expect(meta?.title).toBe("v2");
    const file = await store.readVersionFile(id, "v2", "index.html");
    expect(file?.body.toString("utf8")).toBe(PAGE(2));
    // older versions stay addressable
    expect((await store.readVersionFile(id, "v1", "index.html"))?.body.toString()).toBe(
      "<h1>hello</h1>",
    );
  });

  it("rejects a stale base version with conflict and the live version", async () => {
    await store.publish(id, { baseVersion: "v1", html: PAGE(2), actor: null });
    const failure = await store.publish(id, { baseVersion: "v1", html: PAGE(3), actor: null })
      .then(() => null)
      .catch((err: unknown) => err);
    expect(isCapError(failure)).toBe(true);
    expect(failure).toMatchObject({ code: "conflict", live: "v2" });
    expect((await store.readMeta(id))?.currentVersion).toBe("v2");
  });

  it("serialises concurrent publishes: exactly one wins", async () => {
    const results = await Promise.allSettled([
      store.publish(id, { baseVersion: "v1", html: PAGE(2), actor: null }),
      store.publish(id, { baseVersion: "v1", html: PAGE(3), actor: null }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: "conflict" });
  });

  it("refuses a page publish that is not a document, but lets tooling wrap one", async () => {
    await expect(
      store.publish(id, {
        baseVersion: "v1",
        html: "<h1>no doctype</h1>",
        actor: null,
        requireDoctype: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_content" });
    // the admin API and the CLI publish author body content
    await expect(
      store.publish(id, { baseVersion: "v1", html: "<h1>no doctype</h1>", actor: null }),
    ).resolves.toEqual({ version: "v2" });
  });

  it("carries unchanged files across a files publish and deletes on null", async () => {
    await store.publish(id, {
      baseVersion: "v1",
      files: {
        "data/doc.json": { content: Buffer.from('{"a":1}'), contentType: "application/json" },
        "notes.md": { content: Buffer.from("# notes"), contentType: "text/markdown" },
      },
      actor: null,
    });
    const afterFirst = await store.readMeta(id);
    expect(afterFirst?.currentVersion).toBe("v2");
    // index.html carried over untouched
    expect((await store.readVersionFile(id, "v2", "index.html"))?.body.toString()).toBe(
      "<h1>hello</h1>",
    );

    await store.publish(id, {
      baseVersion: "v2",
      files: { "notes.md": null },
      actor: null,
    });
    expect(await store.readVersionFile(id, "v3", "notes.md")).toBeNull();
    const carried = await store.readVersionFile(id, "v3", "data/doc.json");
    expect(carried?.body.toString()).toBe('{"a":1}');
    expect(carried?.contentType).toBe("application/json");
  });

  it("refuses a files publish past the version byte budget", async () => {
    await expect(
      store.publish(id, {
        baseVersion: "v1",
        files: {
          "big.bin": {
            content: Buffer.alloc(17 * 1024 * 1024),
            contentType: "application/octet-stream",
          },
        },
        actor: null,
      }),
    ).rejects.toMatchObject({ code: "too_large" });
    // nothing was written: the version is still the one it was
    expect((await store.readMeta(id))?.currentVersion).toBe("v1");
    expect(await store.readVersionFile(id, "v2", "big.bin")).toBeNull();
  });

  it("refuses a traversal path", async () => {
    await expect(
      store.publish(id, {
        baseVersion: "v1",
        files: { "../escape.txt": { content: Buffer.from("x"), contentType: "text/plain" } },
        actor: null,
      }),
    ).rejects.toMatchObject({ code: "invalid_content" });
  });
});

describe("files-form validation in the frame", () => {
  it("rejects the form when the artifact_files flag is absent", () => {
    expect(() => validateFiles({ "a.txt": "x" }, false)).toThrowError();
    try {
      validateFiles({ "a.txt": "x" }, false);
    } catch (err) {
      expect(err).toMatchObject({
        code: "capability_disabled",
        message: "publishing files is not available in this view",
      });
    }
  });

  it("infers content types from the extension", () => {
    const out = validateFiles({ "data/doc.json": "{}", "notes.md": "# hi" }, true);
    expect(out["data/doc.json"]).toEqual({ content: "{}", contentType: "application/json" });
    expect(out["notes.md"]).toEqual({ content: "# hi", contentType: "text/markdown" });
    expect(Object.getPrototypeOf(out)).toBeNull();
  });

  it("keeps null (delete) entries and refuses unknown extensions", () => {
    expect(validateFiles({ "gone.txt": null }, true)["gone.txt"]).toBeNull();
    expect(() => validateFiles({ mystery: "x" }, true)).toThrowError();
  });

  it("refuses a content type with parameters", () => {
    try {
      validateFiles({ "a.txt": { content: "x", contentType: "text/plain;charset=utf-8" } }, true);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toMatchObject({ code: "invalid_content" });
    }
  });

  it("refuses a non-object argument and an empty map", () => {
    expect(() => validateFiles([], true)).toThrowError();
    expect(() => validateFiles({}, true)).toThrowError();
  });
});
