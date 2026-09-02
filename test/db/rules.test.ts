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
    // The refusal closes the view, so not even a viewer's own subtree is
    // writable below `owner` until the declaration is fixed.
    expect(can(half, `data/users/${B}/profile`, "write", viewer(B, "interact"))).toBe(false);
    expect(can(half, `data/users/${B}/profile`, "write", viewer(B, "owner"))).toBe(true);
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
    // A refused declaration closes the view, never falls back to the
    // defaults: the defaults are looser than the declaration asked for.
    expect(can(half, `votes/${A}`, "write", viewer(A, "interact"))).toBe(false);
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

describe("a declaration that does not compile", () => {
  // One typo used to discard the whole declaration and run the DEFAULTS, so
  // a locked-down author ended up with root `write: "interact"` for every
  // anonymous viewer. A refused declaration is closed, not default.
  const oneTypo = {
    rules: [
      { path: "", read: "view", write: "owner" },
      { path: "bad path!", read: "view" },
    ],
  };

  it("closes every path instead of falling back to the defaults", () => {
    expect(compileRules(oneTypo).errors[0]).toMatch(/is not a rule path/);
    expect(can(oneTypo, "t/1", "write", viewer(A, "interact"))).toBe(false);
    expect(can(oneTypo, "t/1", "write", viewer(null, "interact"))).toBe(false);
    expect(can(oneTypo, "t/1", "read", viewer(A, "admin"))).toBe(false);
    // The owner can still reach the store to repair it.
    expect(can(oneTypo, "t/1", "read", viewer(A, "owner"))).toBe(true);
    expect(can(oneTypo, "t/1", "write", viewer(A, "owner"))).toBe(true);
  });

  it("keeps {self} privacy while closed", () => {
    expect(can(oneTypo, `data/users/${A}/profile`, "read", viewer(B, "owner"))).toBe(false);
    expect(can(oneTypo, `data/users/${A}/profile`, "read", viewer(A, "owner"))).toBe(true);
  });

  it("closes on a rule list over the cap too", () => {
    const many = { rules: Array.from({ length: 65 }, (_, i) => ({ path: `c${i}`, read: "view" })) };
    expect(can(many, "t/1", "write", viewer(A, "interact"))).toBe(false);
  });

  it("leaves a declaration that does compile on exactly what it asked for", () => {
    const fixed = { rules: [{ path: "", read: "view", write: "owner" }] };
    expect(compileRules(fixed).errors).toEqual([]);
    expect(can(fixed, "t/1", "read", viewer(null, "interact"))).toBe(true);
    expect(can(fixed, "t/1", "write", viewer(A, "interact"))).toBe(false);
    expect(can(fixed, "t/1", "write", viewer(A, "owner"))).toBe(true);
  });

  it("keeps the {self} prefixes the author declared, so the owner stays out", () => {
    // The level gate alone locks out everyone below `owner`; `{self}` is the
    // gate the owner does not pass either, and a closure must not hand the
    // owner subtrees the author promised were private.
    const broken = {
      rules: [
        { path: "", read: "view", write: "owner" },
        { path: "votes/{self}", write: "interact" },
        { path: "bad path!", read: "view" },
      ],
    };
    expect(compileRules(broken).errors[0]).toMatch(/is not a rule path/);
    expect(can(broken, `votes/${B}/x`, "read", viewer(A, "owner"))).toBe(false);
    expect(can(broken, `votes/${B}/x`, "write", viewer(A, "owner"))).toBe(false);
    // The viewer's own subtree is still gated on the closed level, so only
    // the owner reads their own, and nobody below `owner` reads anything.
    expect(can(broken, `votes/${A}/x`, "read", viewer(A, "owner"))).toBe(true);
    expect(can(broken, `votes/${A}/x`, "read", viewer(A, "interact"))).toBe(false);
  });
});

describe("a rules declaration that is not a list of rules", () => {
  // The shape double-encoding gives you: `rules` survives as a JSON STRING.
  // It used to read as "no declaration", so the permissive defaults ran
  // under a declaration whose whole point was to lock the store down.
  const encoded = { rules: '[{"path":"","read":"view","write":"owner"}]' };

  it("is an error, not an absence", () => {
    expect(compileRules(encoded).errors).toEqual(["rules must be an array of rule objects"]);
    expect(compileRules({ rules: { 0: { path: "", write: "owner" } } }).errors).toEqual([
      "rules must be an array of rule objects",
    ]);
    expect(compileRules({ rules: null }).errors).toEqual([
      "rules must be an array of rule objects",
    ]);
    expect(compileRules("{}").errors).toEqual(["config must be an object"]);
    expect(compileRules([]).errors).toEqual(["config must be an object"]);
  });

  it("closes the view instead of running the defaults", () => {
    expect(can(encoded, "t/1", "write", viewer(A, "interact"))).toBe(false);
    expect(can(encoded, "t/1", "write", viewer(null, "interact"))).toBe(false);
    expect(can(encoded, "t/1", "read", viewer(A, "interact"))).toBe(false);
    expect(can(encoded, "t/1", "write", viewer(A, "owner"))).toBe(true);
  });

  it("still treats an absent rules list as the defaults", () => {
    for (const config of [{}, undefined, null, { rules: undefined }, { other: 1 }]) {
      expect(compileRules(config).errors).toEqual([]);
      expect(can(config, "t/1", "write", viewer(A, "interact"))).toBe(true);
    }
  });
});

describe("a rule that sets no level", () => {
  // `raed` instead of `read`: the author believes the root is locked down,
  // and every level below it is inherited from the permissive defaults.
  const typo = { rules: [{ path: "", raed: "owner" }] };

  it("is refused, and closes the view", () => {
    expect(compileRules(typo).errors).toEqual(["rule 0: a rule must set read, write, or both"]);
    expect(can(typo, "t/1", "write", viewer(A, "interact"))).toBe(false);
    expect(can(typo, "t/1", "read", viewer(null, "view"))).toBe(false);
  });

  it("still accepts a rule that sets only one level", () => {
    const one = { rules: [{ path: "notes", write: "admin" }] };
    expect(compileRules(one).errors).toEqual([]);
    expect(can(one, "notes/n1", "read", viewer(A, "view"))).toBe(true);
    expect(can(one, "notes/n1", "write", viewer(A, "interact"))).toBe(false);
    expect(can(one, "notes/n1", "write", viewer(A, "admin"))).toBe(true);
  });
});

describe("the errors a bad declaration reports", () => {
  it("bounds and escapes the path it echoes back", () => {
    // The message reaches a server console and a `POST /api/artifacts` 400
    // body, so a path may not smuggle newlines into either, or dump a
    // megabyte on first touch.
    const nasty = { rules: [{ path: `x\ny/${"z".repeat(5000)}` }] };
    const [message] = compileRules(nasty).errors;
    expect(message).toMatch(/is not a rule path/);
    expect(message).not.toContain("\n");
    expect((message as string).length).toBeLessThan(120);
  });
});
