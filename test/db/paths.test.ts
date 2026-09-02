/**
 * The page-facing grammar: `doc()` and `collection()` throw a `TypeError`
 * synchronously, and argument validation happens before anything is posted.
 */
import { describe, expect, it } from "vitest";
import {
  assertPath,
  buildQueryDesc,
  checkArgument,
  MAX_ARG_BYTES,
  pathProblem,
} from "../../src/capabilities/db/frame.ts";

describe("path grammar", () => {
  it("accepts the shapes the contract documents", () => {
    expect(pathProblem("tasks/t1", "document")).toBeNull();
    expect(pathProblem("boards/b1/columns/c2", "document")).toBeNull();
    expect(pathProblem("tasks", "collection")).toBeNull();
    expect(pathProblem("boards/b1/columns", "collection")).toBeNull();
    expect(pathProblem("data/users/u_abc", "collection")).toBeNull();
    expect(pathProblem("data/users/u_abc/profile", "document")).toBeNull();
    expect(pathProblem("a.b~c:d@e+f-g_h", "collection")).toBeNull();
  });

  it("names the segment count on a parity failure", () => {
    expect(pathProblem("tasks", "document")).toMatch(
      /document path has an even number of segments; "tasks" has 1/,
    );
    expect(pathProblem("tasks/t1", "collection")).toMatch(
      /collection path has an odd number of segments; "tasks\/t1" has 2/,
    );
  });

  it("names the broken rule for every other refusal", () => {
    expect(pathProblem(7, "document")).toMatch(/must be a string/);
    expect(pathProblem("", "document")).toMatch(/must not be empty/);
    expect(pathProblem("a//b/c", "document")).toMatch(/segment 2 of 4 is empty/);
    expect(pathProblem("a/../b/c", "document")).toMatch(/segment 2 of 4 is "\.\."/);
    expect(pathProblem("a/b c", "document")).toMatch(/may use only letters, digits/);
    expect(pathProblem(`a/${"x".repeat(201)}`, "document")).toMatch(/longer than 200 bytes/);
    expect(pathProblem(Array.from({ length: 18 }, (_, i) => `s${i}`).join("/"), "document")).toMatch(
      /at most 16 segments; this one has 18/,
    );
    expect(pathProblem(`${"x".repeat(200)}/${"y".repeat(200)}/${"z".repeat(700)}`, "document")).toMatch(
      /at most 1000 bytes/,
    );
  });

  it("throws a TypeError naming the call site", () => {
    expect(() => assertPath("db.doc", "tasks", "document")).toThrow(TypeError);
    try {
      assertPath("db.doc", "tasks", "document");
      expect.unreachable();
    } catch (err) {
      expect((err as TypeError).message).toContain("db.doc:");
      expect((err as TypeError).name).toBe("TypeError");
    }
    expect(assertPath("db.doc", "tasks/t1", "document")).toBe("tasks/t1");
  });
});

describe("argument validation", () => {
  it("accepts plain JSON", () => {
    expect(() => checkArgument({ a: [1, "two", null, { b: true }] }, "body")).not.toThrow();
  });

  it("refuses what the shell could never carry", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 45; i++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(() => checkArgument(deep, "body")).toThrow(
      expect.objectContaining({ code: "invalid_argument" }),
    );
    expect(() => checkArgument({ fn: () => 1 }, "body")).toThrow(
      expect.objectContaining({ code: "invalid_argument" }),
    );
    expect(() => checkArgument({ n: Number.NaN }, "body")).toThrow(
      expect.objectContaining({ code: "invalid_argument" }),
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => checkArgument(cyclic, "body")).toThrow(
      expect.objectContaining({ code: "invalid_argument" }),
    );
    expect(() => checkArgument({ big: "x".repeat(MAX_ARG_BYTES) }, "body")).toThrow(
      expect.objectContaining({ code: "invalid_argument" }),
    );
  });
});

describe("query builders", () => {
  it("describes a query on the wire", () => {
    expect(
      buildQueryDesc("tasks", {
        where: [{ field: "done", op: "==", value: false }],
        order: [{ field: "at", dir: "desc" }],
        limit: 10,
      }),
    ).toEqual({
      collection: "tasks",
      where: [{ f: "done", op: "==", v: false }],
      orderBy: { f: "at", dir: "desc" },
      limit: 10,
    });
  });

  it("defaults the direction and omits what was not asked for", () => {
    expect(buildQueryDesc("tasks", { where: [], order: [{ field: "at" }] })).toEqual({
      collection: "tasks",
      orderBy: { f: "at", dir: "asc" },
    });
    expect(buildQueryDesc("tasks", { where: [], order: [] })).toEqual({ collection: "tasks" });
  });

  it("refuses a query the store would refuse", () => {
    const invalid = expect.objectContaining({ code: "invalid_argument" });
    expect(() => buildQueryDesc("tasks", { where: [], order: [], limit: 0 })).toThrow(invalid);
    expect(() => buildQueryDesc("tasks", { where: [], order: [], limit: 1001 })).toThrow(invalid);
    expect(() =>
      buildQueryDesc("tasks", { where: [{ field: "a", op: "~=", value: 1 }], order: [] }),
    ).toThrow(invalid);
    expect(() =>
      buildQueryDesc("tasks", { where: [{ field: "a", op: "in", value: 1 }], order: [] }),
    ).toThrow(invalid);
    expect(() =>
      buildQueryDesc("tasks", {
        where: [{ field: "a", op: "in", value: Array.from({ length: 31 }, (_, i) => i) }],
        order: [],
      }),
    ).toThrow(invalid);
    expect(() =>
      buildQueryDesc("tasks", {
        where: Array.from({ length: 11 }, () => ({ field: "a", op: "==", value: 1 })),
        order: [],
      }),
    ).toThrow(invalid);
    expect(() =>
      buildQueryDesc("tasks", { where: [], order: [{ field: "a" }, { field: "b" }] }),
    ).toThrow(invalid);
    expect(() =>
      buildQueryDesc("tasks", { where: [], order: [{ field: "a", dir: "sideways" }] }),
    ).toThrow(invalid);
  });
});
