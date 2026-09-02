/**
 * The pure half of the store: document merging, filter matching and
 * ordering. It touches no filesystem and no identity, so both the server
 * (`store.ts`, `server.ts`) and the browser-side broker can run it — the
 * broker needs exactly these semantics to apply a page's own write to its
 * subscription mirrors before the round trip completes.
 */
import type { DocRow, QuerySpec, WhereClause } from "./store.ts";

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** `update` semantics: nested objects merge, everything else replaces. */
export function mergeDeep(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      out[key] = mergeDeep(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Type ordering for mixed-type fields, so a sort is always total. */
function typeRank(v: unknown): number {
  if (v === null) return 0;
  if (typeof v === "boolean") return 1;
  if (typeof v === "number") return 2;
  if (typeof v === "string") return 3;
  if (Array.isArray(v)) return 4;
  return 5;
}

export function compareValues(a: unknown, b: unknown): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "string" && typeof b === "string") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  if (a === null && b === null) return 0;
  const sa = JSON.stringify(a) ?? "";
  const sb = JSON.stringify(b) ?? "";
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * Does one document match one filter? A document that does not carry the
 * field never matches - including `!=`, so a filter is always a positive
 * statement about a field that exists.
 */
export function matchesWhere(data: Record<string, unknown>, clause: WhereClause): boolean {
  if (!Object.prototype.hasOwnProperty.call(data, clause.f)) return false;
  const value = data[clause.f];
  switch (clause.op) {
    case "==":
      return valueEquals(value, clause.v);
    case "!=":
      return !valueEquals(value, clause.v);
    case "<":
      return compareValues(value, clause.v) < 0;
    case "<=":
      return compareValues(value, clause.v) <= 0;
    case ">":
      return compareValues(value, clause.v) > 0;
    case ">=":
      return compareValues(value, clause.v) >= 0;
    case "in":
      return (clause.v as unknown[]).some((entry) => valueEquals(value, entry));
    case "not-in":
      return !(clause.v as unknown[]).some((entry) => valueEquals(value, entry));
    case "array-contains":
      return Array.isArray(value) && value.some((entry) => valueEquals(entry, clause.v));
    default:
      return false;
  }
}

/** Order, then window. Documents missing the `orderBy` field sort last. */
export function orderRows(rows: DocRow[], spec: QuerySpec): DocRow[] {
  const sorted = [...rows];
  const order = spec.orderBy;
  if (order) {
    const dir = order.dir === "desc" ? -1 : 1;
    sorted.sort((a, b) => {
      const hasA = Object.prototype.hasOwnProperty.call(a.data, order.f);
      const hasB = Object.prototype.hasOwnProperty.call(b.data, order.f);
      if (!hasA || !hasB) {
        if (hasA === hasB) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        return hasA ? -1 : 1; // missing sorts last, in both directions
      }
      const cmp = compareValues(a.data[order.f], b.data[order.f]);
      if (cmp !== 0) return cmp * dir;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  } else {
    sorted.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return spec.limit === undefined ? sorted : sorted.slice(0, spec.limit);
}
