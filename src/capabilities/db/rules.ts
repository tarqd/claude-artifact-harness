/**
 * db access rules (db.d.ts "ACCESS RULES").
 *
 * A rule names a path prefix and the minimum sharing level for reading and
 * writing at that path and below. A path ending in `{self}` names each
 * viewer's own subtree under that prefix: nobody else - the owner included -
 * sees a sibling's subtree unless a rule declared AT the prefix opens it.
 *
 * Two rules always exist before the declaration is read: the root
 * (`read: "view"`, `write: "interact"`) and the platform's private
 * `data/users/{self}`. `{db: {}}` therefore restores exactly the defaults.
 *
 * A declaration that does not compile is never run and never falls back to
 * those defaults: the view closes to `owner`/`owner` (see `closed()`), and
 * the caller reports the errors. `POST /api/artifacts` refuses such a
 * declaration outright, so an author sees the typo at publish.
 *
 * Pure module: no I/O, so the server and the tests share one implementation.
 */
import {
  byteLength,
  isPathSegment,
  MAX_PATH_BYTES,
  MAX_PATH_SEGMENTS,
} from "../../protocol/paths.ts";

export const LEVELS = ["view", "interact", "admin", "owner"] as const;
export type Level = (typeof LEVELS)[number];

export type Action = "read" | "write";

/** The marker segment: "each viewer's own subtree under this prefix". */
export const SELF = "{self}";

/** At most 64 rules may be declared (db.d.ts). */
export const MAX_RULES = 64;

const RANK: Readonly<Record<Level, number>> = Object.freeze({
  view: 0,
  interact: 1,
  admin: 2,
  owner: 3,
});

export function isLevel(v: unknown): v is Level {
  return typeof v === "string" && (LEVELS as readonly string[]).includes(v);
}

export function levelRank(level: Level): number {
  return RANK[level];
}

export interface CompiledRule {
  /** Literal prefix segments; the `{self}` marker is not part of them. */
  segs: readonly string[];
  /** True when the declared path ended in `{self}`. */
  self: boolean;
  read: Level | null;
  write: Level | null;
  /** False for the two rules the platform supplies. */
  declared: boolean;
}

export interface CompiledRules {
  rules: CompiledRule[];
  /** Why a declaration was refused. A non-empty list means the closed rules ran. */
  errors: string[];
}

export interface RuleViewer {
  /** `null` for a request that carried no identity. */
  id: string | null;
  level: Level;
}

function defaults(): CompiledRule[] {
  return [
    { segs: [], self: false, read: "view", write: "interact", declared: false },
    // The `data/users/` prefix is private per viewer, platform-side.
    { segs: ["data", "users"], self: true, read: null, write: null, declared: false },
  ];
}

/**
 * What a declaration that could not be compiled runs under: nothing below
 * `owner` reads or writes anything. The defaults are NOT the safe answer
 * here — root `write: "interact"` is what `{db: {}}` asks for, not what a
 * typo in one rule of a locked-down declaration asks for, and falling back
 * to them turns a mistake into an open database. The `data/users/{self}`
 * privacy rule stays, so a fallback never widens that prefix either.
 */
function closed(): CompiledRule[] {
  return [
    { segs: [], self: false, read: "owner", write: "owner", declared: false },
    { segs: ["data", "users"], self: true, read: null, write: null, declared: false },
  ];
}

/** The rules a view runs under, or the closed rules when the declaration is bad. */
export function compileRules(config: unknown): CompiledRules {
  const rules = defaults();
  const errors: string[] = [];

  const declared = readRuleList(config);
  if (declared === null) return { rules, errors };
  if (declared.length > MAX_RULES) {
    return { rules: closed(), errors: [`at most ${MAX_RULES} rules may be declared`] };
  }

  const added: CompiledRule[] = [];
  for (const [index, entry] of declared.entries()) {
    const rule = compileRule(entry, index, errors);
    if (rule) added.push(rule);
  }

  // A `{self}` rule under a prefix the author also rules on must be paired
  // with a prefix rule that sets BOTH levels, or the intent ("siblings are
  // visible at these levels") is ambiguous. The platform's own
  // `data/users/{self}` counts here: a declaration at `data/users` that sets
  // only one level would otherwise open every viewer's private subtree at the
  // level inherited from the root.
  const seenPrefix = new Set<string>();
  for (const rule of [...rules, ...added]) {
    if (!rule.self || rule.segs.length === 0) continue;
    const key = rule.segs.join("/");
    if (seenPrefix.has(key)) continue;
    seenPrefix.add(key);
    const prefix = added.find((other) => !other.self && samePath(other.segs, rule.segs));
    if (prefix && (prefix.read === null || prefix.write === null)) {
      errors.push(
        `the rule at "${key}" is the prefix of a {self} rule, so it must set both read and write`,
      );
    }
  }

  if (errors.length > 0) return { rules: closed(), errors };

  for (const rule of added) {
    const existing = rules.findIndex((r) => r.self === rule.self && samePath(r.segs, rule.segs));
    if (existing >= 0) rules[existing] = rule;
    else rules.push(rule);
  }
  return { rules, errors };
}

function readRuleList(config: unknown): unknown[] | null {
  if (typeof config !== "object" || config === null) return null;
  const rules = (config as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return null;
  return rules;
}

function compileRule(entry: unknown, index: number, errors: string[]): CompiledRule | null {
  if (typeof entry !== "object" || entry === null) {
    errors.push(`rule ${index} is not an object`);
    return null;
  }
  const raw = entry as { path?: unknown; read?: unknown; write?: unknown };
  if (typeof raw.path !== "string") {
    errors.push(`rule ${index} has no path`);
    return null;
  }
  const parsed = parseRulePath(raw.path);
  if (!parsed) {
    errors.push(`rule ${index}: "${raw.path}" is not a rule path`);
    return null;
  }
  let read: Level | null = null;
  let write: Level | null = null;
  if (raw.read !== undefined) {
    if (!isLevel(raw.read)) {
      errors.push(`rule ${index}: read must be one of ${LEVELS.join(", ")}`);
      return null;
    }
    read = raw.read;
  }
  if (raw.write !== undefined) {
    if (!isLevel(raw.write)) {
      errors.push(`rule ${index}: write must be one of ${LEVELS.join(", ")}`);
      return null;
    }
    write = raw.write;
  }
  // "Writing implies reading: a rule's write level is never below its read
  // level" - a declaration that says otherwise is read the sane way.
  if (read !== null && write !== null && RANK[write] < RANK[read]) write = read;
  return { segs: parsed.segs, self: parsed.self, read, write, declared: true };
}

/** A rule path: the document-path grammar, plus a trailing `{self}`. */
export function parseRulePath(path: string): { segs: string[]; self: boolean } | null {
  if (path === "") return { segs: [], self: false };
  if (byteLength(path) > MAX_PATH_BYTES) return null;
  const segs = path.split("/");
  if (segs.length > MAX_PATH_SEGMENTS) return null;
  let self = false;
  if (segs[segs.length - 1] === SELF) {
    self = true;
    segs.pop();
  }
  // `{self}` must be the LAST segment.
  if (segs.some((s) => s === SELF)) return null;
  if (segs.some((s) => !isPathSegment(s))) return null;
  return { segs, self };
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

function isPrefix(prefix: readonly string[], segs: readonly string[]): boolean {
  if (prefix.length > segs.length) return false;
  return prefix.every((seg, i) => seg === segs[i]);
}

export interface AccessDecision {
  allowed: boolean;
  /** True when the path lives in another viewer's `{self}` subtree. */
  foreign: boolean;
  /** The level the path required, when the refusal was a level refusal. */
  required: Level | null;
}

/**
 * May this viewer read (or write) this document path?
 *
 * Two independent gates: `{self}` privacy (which even the owner does not
 * pass) and the level minimum (which the owner always passes, being the top
 * level). A refused read must look like a missing document to the caller; a
 * refused write is `invalid_argument`.
 */
export function checkAccess(
  rules: readonly CompiledRule[],
  path: string,
  action: Action,
  viewer: RuleViewer,
): AccessDecision {
  const segs = path.split("/");

  for (const rule of rules) {
    if (!rule.self) continue;
    if (segs.length <= rule.segs.length) continue;
    if (!isPrefix(rule.segs, segs)) continue;
    const ownerSegment = segs[rule.segs.length];
    if (viewer.id !== null && ownerSegment === viewer.id) continue;
    // Somebody else's subtree: only a rule declared AT the prefix opens it.
    const opened = rules.some((r) => r.declared && !r.self && samePath(r.segs, rule.segs));
    if (!opened) return { allowed: false, foreign: true, required: null };
  }

  let read: Level = "view";
  let write: Level = "interact";
  // Longest matching prefix wins; shorter prefixes are inherited through.
  const matching = rules
    .filter((rule) => {
      const effective = rule.self ? [...rule.segs, viewer.id ?? " "] : rule.segs;
      return isPrefix(effective, segs);
    })
    .sort((a, b) => a.segs.length + (a.self ? 1 : 0) - (b.segs.length + (b.self ? 1 : 0)));
  for (const rule of matching) {
    if (rule.read !== null) read = rule.read;
    if (rule.write !== null) write = rule.write;
    if (RANK[write] < RANK[read]) write = read;
  }

  const required = action === "read" ? read : write;
  return {
    allowed: RANK[viewer.level] >= RANK[required],
    foreign: false,
    required,
  };
}
