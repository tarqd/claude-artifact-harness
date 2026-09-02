/**
 * The pure half of the slice: the deterministic colour and avatar every side
 * derives from an id, and the argument normalisers both sides share.
 */
import { describe, expect, it } from "vitest";
import {
  avatarDataUri,
  colorForId,
  hashId,
  MAX_NAME_CHARS,
  MAX_PROFILE_IDS,
  normalizeIds,
  normalizeName,
  normalizeQuery,
  readWireProfile,
  SWATCHES,
} from "../../src/capabilities/user/identity.ts";

const ID = "u_0123456789abcdefghijkl";

describe("colour", () => {
  it("is one of the six swatches, and the same one every time", () => {
    expect(SWATCHES).toHaveLength(6);
    const first = colorForId(ID);
    expect(SWATCHES).toContain(first);
    expect(colorForId(ID)).toBe(first);
  });

  it("spreads ids over every swatch", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(colorForId(`u_${String(i).padStart(22, "0")}`));
    expect(seen.size).toBe(SWATCHES.length);
  });

  it("gives the empty id a colour too (a viewer with no id still renders)", () => {
    expect(SWATCHES).toContain(colorForId(""));
  });

  it("hashes to a non-negative 32-bit value", () => {
    for (const id of ["", ID, "ÿþ", "a".repeat(500)]) {
      const h = hashId(id);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("avatarDataUri", () => {
  it("is a self-contained SVG circle in the id's colour", () => {
    const uri = avatarDataUri(ID);
    expect(uri.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    const svg = decodeURIComponent(uri.slice("data:image/svg+xml;charset=utf-8,".length));
    expect(svg).toContain("<circle");
    expect(svg).toContain(colorForId(ID));
    // It must be safe to drop straight into an `src` attribute.
    expect(uri).not.toContain('"');
    expect(uri).not.toContain("<");
    expect(uri).not.toContain(" ");
  });

  it("is stable for one id and different for another", () => {
    expect(avatarDataUri(ID)).toBe(avatarDataUri(ID));
    expect(avatarDataUri(ID)).not.toBe(avatarDataUri("u_zzzzzzzzzzzzzzzzzzzzzz"));
  });
});

describe("normalizeIds", () => {
  it("keeps order, drops non-strings and duplicates", () => {
    expect(normalizeIds(["b", "a", "b", 7, null, "", "c"])).toEqual(["b", "a", "c"]);
  });

  it("caps the list and refuses non-arrays", () => {
    const many = Array.from({ length: MAX_PROFILE_IDS + 50 }, (_, i) => `u_${i}`);
    expect(normalizeIds(many)).toHaveLength(MAX_PROFILE_IDS);
    expect(normalizeIds("nope")).toEqual([]);
    expect(normalizeIds(undefined)).toEqual([]);
  });
});

describe("normalizeQuery", () => {
  it("trims and caps at 100 characters", () => {
    expect(normalizeQuery("  ada  ")).toBe("ada");
    expect(normalizeQuery("x".repeat(300))).toHaveLength(100);
    expect(normalizeQuery(42)).toBe("");
  });
});

describe("normalizeName", () => {
  it("collapses whitespace, strips control characters and bounds the length", () => {
    expect(normalizeName("  Ada   Lovelace ")).toBe("Ada Lovelace");
    expect(normalizeName("Ada\u0000\u001fLovelace")).toBe("Ada Lovelace");
    expect(normalizeName("n".repeat(200))).toHaveLength(MAX_NAME_CHARS);
    expect(normalizeName("")).toBe("");
    expect(normalizeName(7)).toBeNull();
  });
});

describe("readWireProfile", () => {
  it("accepts a minimal row and fills the rest", () => {
    expect(readWireProfile({ id: ID })).toEqual({
      id: ID,
      name: "",
      avatarUrl: null,
      email: null,
    });
  });

  it("refuses anything without a usable id", () => {
    expect(readWireProfile({ id: "" })).toBeNull();
    expect(readWireProfile({ name: "Ada" })).toBeNull();
    expect(readWireProfile(null)).toBeNull();
    expect(readWireProfile("Ada")).toBeNull();
  });
});
