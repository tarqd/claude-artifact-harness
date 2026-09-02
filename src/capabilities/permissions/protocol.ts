/**
 * What the frame and the shell must agree on for `permissions`: the state
 * vocabulary, the two validation limits (surface-area.md §5.2) and the
 * `localStorage` key the shell stores a viewer's answer under.
 *
 * Both sides validate. The frame validates so a malformed call never costs a
 * round trip and the page sees the documented message; the shell validates
 * because a frame is not trusted to have done it.
 */
import { capError } from "../../protocol/errors.ts";
import { resolveCapability } from "../../protocol/capabilities.ts";

export const CAP = "permissions";

/** A single name may be at most this long (surface-area.md §5.2). */
export const MAX_NAME_LENGTH = 512;
/** `request()` takes at most this many names. */
export const MAX_NAMES = 32;

export type PermissionState = "granted" | "denied" | "prompt" | "unavailable";

export const PERMISSION_STATES: readonly PermissionState[] = [
  "granted",
  "denied",
  "prompt",
  "unavailable",
];

export function isPermissionState(v: unknown): v is PermissionState {
  return typeof v === "string" && (PERMISSION_STATES as readonly string[]).includes(v);
}

/**
 * Capabilities whose first use asks the viewer. On claude.ai these are the
 * "decide" capabilities — `sample` and `mcp.callTool`/`watchTool`
 * (docs/analysis/shell.md §"permissions"). `mcp` is out of scope for v0, so
 * `sample` is the only one that can ever read `"prompt"` here.
 */
export const CONSENT_CAPS: ReadonlySet<string> = new Set(["sample"]);

/**
 * The key the shell stores a decision under. Shared verbatim with the
 * `sample` slice's own first-call consent (`consent:<artifactId>:sample`), so
 * whichever surface asks first, the other honours the answer.
 */
export function consentKey(artifactId: string, cap: string): string {
  return `consent:${artifactId}:${cap}`;
}

/**
 * `self` is the legacy spelling of `artifact`; scoped names (`mcp:<server>`,
 * `mcp:host:<name>`) are left exactly as the page wrote them, because the
 * scope after the colon is the connector's identity, not ours to rewrite.
 */
export function normalizeName(name: string): string {
  if (name.includes(":")) return name;
  return resolveCapability(name) ?? name;
}

const INVALID_NAME = (): never => {
  throw capError("invalid_content", "a capability name must be a string");
};

/** Validate the optional argument of `state(name?)`. */
export function validateStateName(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "string") INVALID_NAME();
  const name = input as string;
  if (name.length === 0) {
    throw capError("invalid_content", "a capability name must not be empty");
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw capError(
      "invalid_content",
      `a capability name must be at most ${MAX_NAME_LENGTH} characters`,
    );
  }
  return name;
}

/**
 * Validate the optional argument of `request(names?)`. Duplicates are folded
 * (the answer is a map, so a repeated name could only overwrite itself) while
 * the order the page asked in is kept.
 */
export function validateRequestNames(input: unknown): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) {
    throw capError("invalid_content", "request takes an array of capability names");
  }
  if (input.length > MAX_NAMES) {
    throw capError("invalid_content", `request takes at most ${MAX_NAMES} names`);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const name = validateStateName(entry);
    if (name === undefined) {
      throw capError("invalid_content", "a capability name must be a string");
    }
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** The answer shape when nothing can be decided: every name `"unavailable"`. */
export function unavailableMap(names: readonly string[]): Record<string, PermissionState> {
  const out: Record<string, PermissionState> = {};
  for (const name of names) out[name] = "unavailable";
  return out;
}

/**
 * Whether this view has anything to hold a permission over. `permissions`
 * itself and `user` do not count: a page declaring only those has no
 * capability whose state could ever be anything but its own (surface-area.md
 * §5.2).
 */
export function hasGovernableCapability(capabilities: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(capabilities).some((name) => {
    const normalized = normalizeName(name);
    return normalized !== CAP && normalized !== "user";
  });
}
