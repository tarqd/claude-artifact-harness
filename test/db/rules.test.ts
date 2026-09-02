/**
 * Access rules: sharing levels, inheritance, `{self}` privacy and the
 * `data/users/` default (db.d.ts "ACCESS RULES").
 */
import { describe, expect, it } from "vitest";
import { checkAccess, compileRules, parseRulePath, type Level } from "../../src/capabilities/db/rules.ts";

const A = "u_aaaaaaaaaaaaaaaaaaaaaa";
const B = "u_bbbbbbbbbbbbbbbbbbbbbb";

function viewer(id: string | null, level: Level) {
  return { id, level };
}

function can(config: unknown, path: string, action: "read" | "write", who: { id: string | null; level: Level }) {
  return checkAccess(compileRules(config).rules, path, action, who).allowed;
}

describe("defaults", () => {
  const defaults = {};

  it("lets every viewer read and write shared documents", () => {
    expect(can(defaults, "tasks/t1", "read", viewer(A, "view"))).toBe(true);
    expect(can(defaults, "tasks/t1", "write", viewer(A, "interact"))).toBe(true);
    // `view` is below the default write level.
    expect(can(defaults, "tasks/t1", "write", viewer(A, "view"))).toBe(false);
  });

  it("keeps each viewer's data/users subtree private", () => {
    expect(can(defaults, `data/users/${A}/profile`, "read", viewer(A, "interact"))).toBe(true);
    expect(can(defaults, `data/users/${A}/profile`, "write", viewer(A, "interact"))).toBe(true);
    expect(can(defaults, `data/users/${A}/profile`, "read", viewer(B, "interact"))).toBe(false);
    expect(can(defaults, `data/users/${A}/profile`, "write", viewer(B, "interact"))).toBe(false);
  });

  it("hides a sibling's subtree from the owner too", () => {
    expect(can(defaults, `data/users/${A}/profile`, "read", viewer(B, "owner"))).toBe(false);
    expect(can(defaults, `data/users/${B}/profile`, "read", viewer(B, "owner"))).toBe(true);
  });

  it("gives an anonymous view no private subtree at all", () => {
    expect(can(defaults, `data/users/${A}/profile`, "read", viewer(null, "interact"))).toBe(false);
    expect(can(defaults, "tasks/t1", "read", viewer(null, "interact"))).toBe(true);
  });
});

describe("declared levels", () => {
  const config = {
    rules: [
      { path: "", read: "interact", write: "admin" },
      { path: "data/users/{self}", write: "interact" },
    ],
  };

  it("applies a rule to its path and everything below", () => {
    expect(can(config, "tasks/t1", "write", viewer(A, "interact"))).toBe(false);
    expect(can(config, "tasks/t1", "write", viewer(A, "admin"))).toBe(true);
    expect(can(config, "boards/b1/cards/c1", "write", viewer(A, "interact"))).toBe(false);
  });

  it("lets a deeper rule loosen the one above it", () => {
    expect(can(config, `data/users/${A}/profile`, "write", viewer(A, "interact"))).toBe(true);
    expect(can(config, `data/users/${B}/profile`, "write", viewer(A, "interact"))).toBe(false);
  });

  it("never limits the owner by level", () => {
    const strict = { rules: [{ path: "", read: "owner", write: "owner" }] };
    expect(can(strict, "tasks/t1", "read", viewer(A, "admin"))).toBe(false);
    expect(can(strict, "tasks/t1", "read", viewer(A, "owner"))).toBe(true);
  });

  it("reads a write level below its read level as the read level", () => {
    const backwards = { rules: [{ path: "notes", read: "admin", write: "view" }] };
    expect(can(backwards, "notes/n1", "write", viewer(A, "interact"))).toBe(false);
    expect(can(backwards, "notes/n1", "write", viewer(A, "admin"))).toBe(true);
  });
});

describe("{self} under any prefix", () => {
  const votes = {
    rules: [
      { path: "votes", read: "view", write: "admin" },
      { path: "votes/{self}", write: "interact" },
    ],
  };

  it("opens siblings for reading at the prefix rule's level", () => {
    expect(compileRules(votes).errors).toEqual([]);
    expect(can(votes, `votes/${A}`, "read", viewer(B, "interact"))).toBe(true);
    expect(can(votes, `votes/${A}`, "write", viewer(B, "interact"))).toBe(false);
    expect(can(votes, `votes/${B}`, "write", viewer(B, "interact"))).toBe(true);
  });

  it("keeps siblings private when no rule is declared at the prefix", () => {
    const sealed = { rules: [{ path: "picks/{self}", write: "interact" }] };
    expect(can(sealed, `picks/${A}`, "read", viewer(B, "interact"))).toBe(false);
    expect(can(sealed, `picks/${B}`, "read", viewer(B, "interact"))).toBe(true);
  });

  it("refuses a half-declared rule at the platform's own data/users prefix", () => {
    // `data/users/{self}` is a rule the platform always supplies, so a
    // declaration at its prefix is held to the same pairing rule - otherwise
    // every viewer would inherit write access into every other subtree.
    const half = { rules: [{ path: "data/users", read: "view" }] };
    expect(compileRules(half).errors[0]).toMatch(/must set both read and write/);
    expect(can(half, `data/users/${A}/profile`, "read", viewer(B, "interact"))).toBe(false);
    expect(can(half, `data/users/${A}/profile`, "write", viewer(B, "interact"))).toBe(false);
    expect(can(half, `data/users/${B}/profile`, "write", viewer(B, "interact"))).toBe(true);
  });

  it("opens data/users when the declaration sets both levels", () => {
    const both = { rules: [{ path: "data/users", read: "view", write: "admin" }] };
    expect(compileRules(both).errors).toEqual([]);
    expect(can(both, `data/users/${A}/profile`, "read", viewer(B, "interact"))).toBe(true);
    expect(can(both, `data/users/${A}/profile`, "write", viewer(B, "interact"))).toBe(false);
  });

  it("refuses a prefix rule that sets only one level", () => {
    const half = {
      rules: [
        { path: "votes", read: "view" },
        { path: "votes/{self}", write: "interact" },
      ],
    };
    const compiled = compileRules(half);
    expect(compiled.errors[0]).toMatch(/must set both read and write/);
    // A refused declaration falls back to the defaults, never to something
    // looser than what was asked for.
    expect(can(half, `votes/${A}`, "write", viewer(A, "interact"))).toBe(true);
    expect(can(half, `data/users/${A}/x`, "read", viewer(B, "interact"))).toBe(false);
  });
});

describe("declaration validation", () => {
  it("parses rule paths", () => {
    expect(parseRulePath("")).toEqual({ segs: [], self: false });
    expect(parseRulePath("data/users/{self}")).toEqual({ segs: ["data", "users"], self: true });
    expect(parseRulePath("{self}")).toEqual({ segs: [], self: true });
    expect(parseRulePath("{self}/deeper")).toBeNull();
    expect(parseRulePath("bad segment")).toBeNull();
  });

  it("refuses more than 64 rules and unknown levels", () => {
    const many = { rules: Array.from({ length: 65 }, (_, i) => ({ path: `c${i}`, read: "view" })) };
    expect(compileRules(many).errors[0]).toMatch(/at most 64 rules/);
    expect(compileRules({ rules: [{ path: "a", read: "everyone" }] }).errors[0]).toMatch(/read must be one of/);
    expect(compileRules({ rules: [{ read: "view" }] }).errors[0]).toMatch(/has no path/);
  });

  it("treats {db: {}} as the defaults", () => {
    expect(compileRules({}).rules).toEqual(compileRules({ rules: [] }).rules);
  });
});
