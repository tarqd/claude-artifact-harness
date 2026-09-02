/**
 * The mirror-and-ops model, both halves: the broker turns "these are the
 * rows now" into index-based splices, and the frame replays them against its
 * own mirror. Replaying a diff must reproduce the server's order exactly.
 */
import { describe, expect, it } from "vitest";
import { diffRows, type DocRow } from "../../src/capabilities/db/broker.ts";
import { applyOps, withMetadata, type MirrorEntry } from "../../src/capabilities/db/frame.ts";

const META = Object.freeze({ fromCache: false, hasPendingWrites: false });

function rows(...entries: Array<[string, unknown]>): DocRow[] {
  return entries.map(([id, value]) => ({ id, data: { v: value } as Record<string, unknown> }));
}

/** Apply a diff the way the frame does and read the mirror back out. */
function replay(mirror: MirrorEntry[], previous: DocRow[], next: DocRow[]) {
  const ops = diffRows(previous, next);
  const changes = applyOps(mirror, ops, META);
  return {
    ops,
    changes,
    ids: mirror.map((entry) => entry.id),
    values: mirror.map((entry) => (entry.snap.data() as { v: unknown }).v),
  };
}

describe("diff and replay", () => {
  it("reports the first delivery as all added", () => {
    const mirror: MirrorEntry[] = [];
    const next = rows(["a", 1], ["b", 2]);
    const result = replay(mirror, [], next);
    expect(result.ops).toEqual([
      { type: "added", id: "a", data: { v: 1 }, oldIndex: -1, newIndex: 0 },
      { type: "added", id: "b", data: { v: 2 }, oldIndex: -1, newIndex: 1 },
    ]);
    expect(result.ids).toEqual(["a", "b"]);
    expect(result.changes.every((c) => c.type === "added" && c.oldIndex === -1)).toBe(true);
  });

  it("emits nothing when nothing changed", () => {
    const previous = rows(["a", 1], ["b", 2]);
    expect(diffRows(previous, rows(["a", 1], ["b", 2]))).toEqual([]);
  });

  it("modifies in place without moving", () => {
    const mirror: MirrorEntry[] = [];
    const first = rows(["a", 1], ["b", 2]);
    replay(mirror, [], first);
    const result = replay(mirror, first, rows(["a", 1], ["b", 9]));
    expect(result.ops).toEqual([
      { type: "modified", id: "b", data: { v: 9 }, oldIndex: 1, newIndex: 1 },
    ]);
    expect(result.values).toEqual([1, 9]);
  });

  it("removes, adds and reorders in one delivery", () => {
    const mirror: MirrorEntry[] = [];
    const first = rows(["a", 1], ["b", 2], ["c", 3]);
    replay(mirror, [], first);
    const next = rows(["c", 3], ["d", 4], ["a", 1]);
    const result = replay(mirror, first, next);
    expect(result.ids).toEqual(["c", "d", "a"]);
    expect(result.values).toEqual([3, 4, 1]);
    const removed = result.changes.find((c) => c.type === "removed");
    expect(removed?.doc.id).toBe("b");
    // A removal still carries the last body the listener saw.
    expect(removed?.doc.exists).toBe(true);
    expect(removed?.doc.data()).toEqual({ v: 2 });
    expect(removed?.newIndex).toBe(-1);
  });

  it("keeps the identity of a document that did not change", () => {
    const mirror: MirrorEntry[] = [];
    const first = rows(["a", 1], ["b", 2]);
    replay(mirror, [], first);
    const before = mirror[0]!.snap;
    replay(mirror, first, rows(["a", 1], ["b", 3]));
    expect(mirror[0]!.snap).toBe(before);
    expect(mirror[1]!.snap).not.toBe(before);
  });

  it("hands the page frozen snapshots and frozen bodies", () => {
    const mirror: MirrorEntry[] = [];
    replay(mirror, [], rows(["a", { nested: 1 }]));
    const snap = mirror[0]!.snap;
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.data())).toBe(true);
    expect(Object.isFrozen((snap.data() as { v: object }).v)).toBe(true);
    expect(snap.data()).toBe(snap.data());
  });

  it("survives a fuzz of random row sets", () => {
    const mirror: MirrorEntry[] = [];
    let previous: DocRow[] = [];
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 60; round++) {
      const size = Math.floor(random() * 6);
      const ids = new Set<string>();
      while (ids.size < size) ids.add(String.fromCharCode(97 + Math.floor(random() * 8)));
      const next: DocRow[] = [...ids].map((id) => ({
        id,
        data: { v: Math.floor(random() * 3) } as Record<string, unknown>,
      }));
      const result = replay(mirror, previous, next);
      expect(result.ids).toEqual(next.map((row) => row.id));
      expect(result.values).toEqual(next.map((row) => row.data.v));
      previous = next;
    }
  });
});

describe("delivery metadata", () => {
  it("re-dresses an unchanged document without cloning its body", () => {
    const mirror: MirrorEntry[] = [];
    const cached = Object.freeze({ fromCache: true, hasPendingWrites: false });
    applyOps(mirror, diffRows([], rows(["a", 1])), cached);
    const first = mirror[0]!.snap;
    expect(first.metadata.fromCache).toBe(true);

    // The next delivery says the same document is now server-definitive: the
    // page must see that, and still get the SAME body object.
    const fresh = withMetadata(first, META);
    expect(fresh.metadata).toBe(META);
    expect(fresh.data()).toBe(first.data());
    expect(fresh.id).toBe("a");
    expect(fresh.exists).toBe(true);
    // Nothing to re-dress when the metadata is already this delivery's.
    expect(withMetadata(fresh, META)).toBe(fresh);
  });
});
