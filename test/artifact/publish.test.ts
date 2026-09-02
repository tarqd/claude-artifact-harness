import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("normalises a stored contentType sidecar to lowercase on read", async () => {
    // The capability endpoint normalises going forward, but a sidecar
    // written before that (or by some other writer) must still compare
    // correctly against the lowercase document-type check at serve time.
    await store.publish(id, {
      baseVersion: "v1",
      files: {
        "y.html": { content: Buffer.from("<p>y</p>"), contentType: "TEXT/HTML" },
      },
      actor: null,
    });
    const file = await store.readVersionFile(id, "v2", "y.html");
    expect(file?.contentType).toBe("text/html");
  });

  it("refuses a files publish that targets a <path>.type sidecar directly", async () => {
    // Without this, `files: {"index.html.type": {...}}` would write straight
    // to the sidecar `readVersionFile` reads back as index.html's declared
    // content type — bypassing `contentType` validation for that path
    // entirely, since the sidecar's own bytes were never checked as a media
    // type at all.
    await expect(
      store.publish(id, {
        baseVersion: "v1",
        files: {
          "index.html.type": {
            content: Buffer.from("text/plain\r\nx-evil: 1"),
            contentType: "text/plain",
          },
        },
        actor: null,
      }),
    ).rejects.toMatchObject({ code: "invalid_content" });
    // nothing was written: index.html still serves its normal, sane type
    expect((await store.readMeta(id))?.currentVersion).toBe("v1");
    const file = await store.readVersionFile(id, "v1", "index.html");
    expect(file?.contentType).toBe("text/html");
  });

  it("refuses a <path>.TYPE sidecar path case-insensitively too", async () => {
    // A case-insensitive filesystem would collide `index.html.TYPE` with the
    // real `index.html.type` sidecar just as surely as the lowercase form.
    await expect(
      store.publish(id, {
        baseVersion: "v1",
        files: {
          "index.html.TYPE": {
            content: Buffer.from("text/plain\r\nx-evil: 1"),
            contentType: "text/plain",
          },
        },
        actor: null,
      }),
    ).rejects.toMatchObject({ code: "invalid_content" });
    expect((await store.readMeta(id))?.currentVersion).toBe("v1");
  });

  it("heals a sidecar already poisoned on disk instead of handing it to a header verbatim", async () => {
    // Simulates a version published by a pre-fix build (or any other writer
    // of the versions directory): the sidecar on disk is not a valid media
    // type at all.
    await writeFile(
      join(dir, "artifacts", id, "versions", "v1", "index.html.type"),
      "text/plain\r\nx-evil: 1",
    );
    const file = await store.readVersionFile(id, "v1", "index.html");
    // Falls back to the extension guess rather than propagating the invalid
    // sidecar value (which `Headers.set` would throw on at serve time).
    expect(file?.contentType).toBe("text/html");
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

  // These four exercise the shared `isMediaType` grammar (protocol/paths.ts)
  // through the frame's own validator, not just the server's: a check that
  // only lived in `contentType.includes(";")` would miss all but the last.
  it("refuses a content type carrying CR/LF", () => {
    try {
      validateFiles({ "a.txt": { content: "x", contentType: "text/plain\r\nx-evil: 1" } }, true);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toMatchObject({ code: "invalid_content" });
    }
  });

  it("refuses a content type with a comma", () => {
    try {
      validateFiles({ "a.txt": { content: "x", contentType: "text/plain, x-evil" } }, true);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toMatchObject({ code: "invalid_content" });
    }
  });

  it("refuses a content type longer than the grammar allows", () => {
    const tooLong = `text/${"x".repeat(200)}`;
    try {
      validateFiles({ "a.txt": { content: "x", contentType: tooLong } }, true);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toMatchObject({ code: "invalid_content" });
    }
  });

  it("accepts a content type after trim-and-lowercase normalisation", () => {
    const out = validateFiles({ "a.txt": { content: "x", contentType: " TEXT/Plain " } }, true);
    expect(out["a.txt"]).toMatchObject({ content: "x", contentType: " TEXT/Plain " });
  });
});
