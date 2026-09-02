/**
 * The grammars a page can observe directly: topics, presence merging and its
 * 4 KiB cap, and the strict `ToClaude` walker with its format-character
 * table and emoji joiner exceptions.
 */
import { describe, expect, it } from "vitest";
import {
  checkString,
  isPlainJson,
  isTopic,
  mergePresence,
  validateEmit,
  validateToClaude,
} from "../../src/capabilities/room/validate.ts";

/** Written as escapes on purpose: these characters are invisible in source. */
const SOFT_HYPHEN = "\u00ad";
const ZERO_WIDTH_SPACE = "\u200b";
const RTL_OVERRIDE = "\u202e";
const BELL = "\u0007";
const ZWJ = "\u200d";
const VS16 = "\ufe0f";
const THUMB = "\u{1f44d}";
const MAN = "\u{1f468}";
const WOMAN = "\u{1f469}";
const GIRL = "\u{1f467}";
const SKIN = "\u{1f3fd}";
const HEART = "\u2764";
const KEYCAP = "\u20e3";

function code(fn: () => unknown): string {
  try {
    fn();
    return "ok";
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return `${e.code}: ${e.message}`;
  }
}

describe("topics", () => {
  it("accepts the documented grammar", () => {
    expect(isTopic("reaction")).toBe(true);
    expect(isTopic("chat.room-1_a")).toBe(true);
    expect(isTopic("a".repeat(48))).toBe(true);
  });

  it("refuses colons, capitals, leading digits and over-long names", () => {
    expect(isTopic("claude:internal")).toBe(false);
    expect(isTopic("Reaction")).toBe(false);
    expect(isTopic("1up")).toBe(false);
    expect(isTopic("a".repeat(49))).toBe(false);
    expect(isTopic("")).toBe(false);
    expect(isTopic(7)).toBe(false);
  });
});

describe("plain JSON", () => {
  it("accepts data and refuses everything a JSON round trip would lose", () => {
    expect(isPlainJson({ a: [1, "two", null, true] })).toBe(true);
    expect(isPlainJson(() => 1)).toBe(false);
    expect(isPlainJson(new Uint8Array(2))).toBe(false);
    expect(isPlainJson(new Date())).toBe(false);
    expect(isPlainJson(new Map())).toBe(false);
    expect(isPlainJson(Number.NaN)).toBe(false);
    expect(isPlainJson(10n)).toBe(false);
  });

  it("refuses runaway depth", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { deep };
    expect(isPlainJson(deep)).toBe(false);
  });
});

describe("presence merge", () => {
  it("merges per field and deletes on a top-level null", () => {
    const one = mergePresence({}, { who: "ada", cursor: { x: 1 } }, 4096);
    expect(one).toEqual({ who: "ada", cursor: { x: 1 } });
    const two = mergePresence(one, { cursor: null, mode: "edit" }, 4096);
    expect(two).toEqual({ who: "ada", mode: "edit" });
  });

  it("drops undefined values through the JSON round trip", () => {
    const merged = mergePresence({}, { a: 1, b: undefined }, 4096);
    expect(Object.keys(merged)).toEqual(["a"]);
  });

  it("never lets a patch introduce a prototype key", () => {
    const patch = JSON.parse('{"__proto__": {"bad": 1}, "ok": 1}') as Record<string, unknown>;
    const merged = mergePresence({}, patch, 4096);
    expect(Object.keys(merged)).toEqual(["ok"]);
  });

  it("refuses a non-object patch", () => {
    expect(code(() => mergePresence({}, [1], 4096))).toBe(
      "invalid_argument: room.presence takes one object of fields to merge",
    );
    expect(code(() => mergePresence({}, null, 4096))).toContain("invalid_argument");
  });

  it("refuses a merged object over the byte cap and does not apply it", () => {
    const current = { keep: 1 };
    expect(code(() => mergePresence(current, { big: "x".repeat(5000) }, 4096))).toBe(
      "invalid_argument: your merged presence object serializes over 4096 bytes - the patch was not applied",
    );
    expect(current).toEqual({ keep: 1 });
  });

  it("refuses values a JSON round trip would lose", () => {
    expect(code(() => mergePresence({}, { fn: () => 1 }, 4096))).toBe(
      "invalid_argument: presence fields must be plain JSON data - the patch was not applied",
    );
  });
});

describe("emit payloads", () => {
  it("checks the topic first, then the data", () => {
    expect(code(() => validateEmit("Bad:Topic", undefined, 4096))).toBe(
      "invalid_argument: emit topic must match ^[a-z][a-z0-9_.-]{0,47}$ (colon-free)",
    );
    expect(code(() => validateEmit("ok", { a: 1 }, 4096))).toBe("ok");
    expect(code(() => validateEmit("ok", undefined, 4096))).toBe("ok");
    expect(code(() => validateEmit("ok", new Map(), 4096))).toBe(
      "invalid_argument: emit data must be plain JSON data",
    );
    expect(code(() => validateEmit("ok", { s: "x".repeat(5000) }, 4096))).toBe(
      "invalid_argument: emit data serializes over 4096 bytes",
    );
  });
});

describe("the ToClaude walker", () => {
  it("accepts an ordinary artifact object", () => {
    const data = { label: "Q3 revenue chart", chartId: "c1", series: ["a", "b"] };
    expect(validateToClaude(data)).toEqual(data);
  });

  it("refuses anything that is not a plain object", () => {
    expect(code(() => validateToClaude([1]))).toContain(
      "takes one plain object the artifact defines",
    );
    expect(code(() => validateToClaude("hi"))).toContain("takes one plain object");
    expect(code(() => validateToClaude({}))).toBe(
      "invalid_argument: nothing to send: the object has no fields",
    );
  });

  it("names the offending path", () => {
    expect(code(() => validateToClaude({ items: [{ label: Number.POSITIVE_INFINITY }] }))).toBe(
      "invalid_argument: room.sendToClaudeSession: data.items[0].label is not a finite number",
    );
  });

  it("enforces depth, key count, entry count and key grammar", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 9; i++) deep = { deep };
    expect(code(() => validateToClaude(deep))).toContain("nests deeper than 8");

    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 65; i++) wide[`k${i}`] = i;
    expect(code(() => validateToClaude(wide))).toContain("has more than 64 keys");

    const long = { list: Array.from({ length: 65 }, (_, i) => i) };
    expect(code(() => validateToClaude(long))).toContain("has more than 64 entries");

    expect(code(() => validateToClaude({ "not-ok!": 1 }))).toContain(
      "has a key that is not an identifier",
    );
    expect(code(() => validateToClaude({ prototype: 1 }))).toContain("reserved name");
    expect(code(() => validateToClaude({ toString: 1 }))).toContain("reserved name");
  });

  it("refuses class instances but accepts null-prototype objects", () => {
    class Point {
      x = 1;
    }
    expect(code(() => validateToClaude({ p: new Point() }))).toContain("is not a plain object");
    const bare = Object.create(null) as Record<string, unknown>;
    bare.x = 1;
    expect(code(() => validateToClaude({ p: bare }))).toBe("ok");
  });

  it("refuses the byte cap", () => {
    expect(code(() => validateToClaude({ s: "x".repeat(4090) }))).toContain(
      "may be at most 4096 bytes of JSON text; it is",
    );
  });

  it("refuses format and invisible characters", () => {
    expect(code(() => validateToClaude({ s: `soft${SOFT_HYPHEN}hyphen` }))).toContain(
      "has a control, private-use, format or invisible character",
    );
    expect(code(() => validateToClaude({ s: `zero${ZERO_WIDTH_SPACE}width` }))).toContain(
      "control, private-use, format or invisible",
    );
    expect(code(() => validateToClaude({ s: `bidi${RTL_OVERRIDE}mark` }))).toContain(
      "invisible character",
    );
    expect(code(() => validateToClaude({ s: `bell${BELL}` }))).toContain("control");
    expect(code(() => validateToClaude({ s: "tabs\tand\nnewlines\rare fine" }))).toBe("ok");
  });

  it("allows emoji joiners where a character carries them", () => {
    expect(checkString(`${MAN}${ZWJ}${WOMAN}${ZWJ}${GIRL}`)).toBeNull();
    expect(checkString(`${HEART}${VS16}`)).toBeNull();
    expect(checkString(`${THUMB}${SKIN}`)).toBeNull();
    expect(checkString(`1${VS16}${KEYCAP}`)).toBeNull();
    // The standard pictograph + VS16 + ZWJ shape stays legal.
    expect(checkString(`${HEART}${VS16}${ZWJ}${MAN}`)).toBeNull();
  });

  it("refuses a joiner with nothing to carry it, and refuses runs", () => {
    expect(checkString(ZWJ)).toContain("no character to carry it");
    expect(checkString(`a${VS16}`)).toContain("no character to carry it");
    expect(checkString(`${THUMB}${ZWJ}${ZWJ}`)).toContain("no character to carry it");
  });

  it("refuses more than eight joiners in one string", () => {
    expect(checkString(`${THUMB}${ZWJ}${THUMB}${ZWJ}${THUMB}${ZWJ}${THUMB}`)).toBeNull();
    const many = Array.from({ length: 10 }, () => `${THUMB}${ZWJ}`).join("") + THUMB;
    expect(checkString(many)).toContain("more than 8");
  });
});
