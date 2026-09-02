/** The declaration reader and the level comparison both halves share. */
import { describe, expect, it, vi } from "vitest";
import {
  isPeerId,
  mayEmit,
  mintPeerId,
  readTopics,
} from "../../src/capabilities/room/protocol.ts";

describe("readTopics", () => {
  it("reads the documented declaration shape", () => {
    const topics = readTopics({ topics: { reaction: "interact", clear: "admin" } });
    expect([...topics]).toEqual([
      ["reaction", "interact"],
      ["clear", "admin"],
    ]);
  });

  it("drops unknown levels rather than widening them", () => {
    const topics = readTopics({ topics: { a: "everyone", b: "interact", c: 1 } });
    expect([...topics.keys()]).toEqual(["b"]);
  });

  it("stops at sixteen topics", () => {
    const declared: Record<string, string> = {};
    for (let i = 0; i < 40; i++) declared[`t${i}`] = "interact";
    expect(readTopics({ topics: declared }).size).toBe(16);
  });

  it("survives a missing or malformed declaration", () => {
    expect(readTopics(undefined).size).toBe(0);
    expect(readTopics({}).size).toBe(0);
    expect(readTopics({ topics: ["reaction"] }).size).toBe(0);
    expect(readTopics(null).size).toBe(0);
  });
});

describe("mayEmit", () => {
  const topics = readTopics({ topics: { reaction: "interact", clear: "admin" } });

  it("treats an unlisted topic as admin-only", () => {
    expect(mayEmit("secret", "interact", topics)).toBe(false);
    expect(mayEmit("secret", "admin", topics)).toBe(true);
    expect(mayEmit("secret", "owner", topics)).toBe(true);
  });

  it("honours an opened topic from the interact level up", () => {
    expect(mayEmit("reaction", "view", topics)).toBe(false);
    expect(mayEmit("reaction", "interact", topics)).toBe(true);
    expect(mayEmit("reaction", "owner", topics)).toBe(true);
  });

  it("treats an unknown level as the floor", () => {
    expect(mayEmit("reaction", "nonsense", topics)).toBe(false);
  });
});

describe("peer ids", () => {
  it("mints ids in the shape the wire accepts", () => {
    for (let i = 0; i < 20; i++) expect(isPeerId(mintPeerId())).toBe(true);
    expect(isPeerId("short")).toBe(false);
    expect(isPeerId("UPPERCASE0000000")).toBe(false);
    expect(isPeerId(7)).toBe(false);
  });

  it("mints ids that are random all the way to the last character", () => {
    const ids = Array.from({ length: 64 }, () => mintPeerId());
    // Every position varies: a constant tail (the old "0000" suffix) would
    // collapse one of these sets to a single character.
    for (let i = 0; i < 16; i++) {
      const seen = new Set(ids.map((id) => id[i]));
      expect(seen.size).toBeGreaterThan(1);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses the whole alphabet", () => {
    const counts = new Set<string>();
    for (let i = 0; i < 2000; i++) for (const ch of mintPeerId()) counts.add(ch);
    expect(counts.size).toBe(36);
  });

  it("rejects the biased byte range rather than folding it", () => {
    // Statistics cannot settle this: `byte % 36` favours four characters by
    // only 8/7, which is inside the sampling noise of any tractable sample.
    // So drive the generator with a known byte stream instead. The first
    // chunk is nothing but the four biased bytes, which fold to `a`..`d`;
    // every later chunk is 100, which is `2`. A generator that folded would
    // answer "abcdabcdabcdabcd"; one that redraws answers "2222222222222222".
    let chunk = 0;
    const spy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        const bytes = array as unknown as Uint8Array;
        for (let i = 0; i < bytes.length; i++) bytes[i] = chunk === 0 ? 252 + (i % 4) : 100;
        chunk++;
        return array;
      });
    try {
      expect(252 % 36).toBe(0); // the fold this guards against
      expect(mintPeerId()).toBe("2".repeat(16));
      expect(chunk).toBe(2); // the whole first chunk really was discarded
    } finally {
      spy.mockRestore();
    }
  });
});
