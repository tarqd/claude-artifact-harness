/**
 * `network` — the page-facing half of the fetch allowlist (surface-area.md
 * §5.6). One method:
 *
 *     origins(): Promise<string[]>
 *
 * It echoes `capabilities.network.config.origins` from `__frame_init` and
 * nothing else: there is no wire call, no backend, no round trip. The
 * enforcement half is the CSP `connect-src` the frame origin serves
 * (`server.ts` in this directory); this namespace only lets a page ask what
 * it was granted, so it can pick an endpoint or degrade before it fetches.
 *
 * There is no `network.d.ts` in `reference/contract/0.2.32/`, so §5.6 is the
 * whole contract. The rules it names, and what this file does with them:
 *
 * - `optional: true` declarations are not echoed → `[]`. (The spine's
 *   `buildInitCapabilities` already drops optional declarations before
 *   `__frame_init`, so `install` would not even run; the check is kept here
 *   so the module behaves the same under a shell that forwards them.)
 * - A malformed config (missing, not an object, `origins` not an array) → `[]`.
 *   Absence is never an error: a page that declared nothing still gets `[]`.
 * - Non-string entries are dropped rather than poisoning the whole list. §5.6
 *   says "echoing `config.origins`", so this is a deviation: the method is
 *   typed `Promise<string[]>` and a JSON-declared config can hold a number or
 *   an object, and handing one back would break the type the page is
 *   promised. A page that declared a non-string sees a shorter array than it
 *   wrote; `README.md` lists it with the other deviations.
 *
 * The array is echoed verbatim — the declaration as written, not the
 * validated subset the CSP ends up carrying. That is deliberate: on
 * claude.ai `origins()` reports the config, and a page that compares its own
 * declaration against the answer must see the same strings back. Entries the
 * CSP refuses (a `http://` origin, a URL with a path) are still reported
 * here; `README.md` documents the divergence.
 */
import type { FrameContext } from "../../frame/types.ts";

export const CAP = "network";

export interface NetworkNamespace {
  /** The declared fetch allowlist, or `[]` when nothing usable was declared. */
  origins(): Promise<string[]>;
}

/**
 * `config` → the origins to report. Total: every malformed shape answers
 * `[]`, because a page asking "what may I reach?" must never be handed an
 * exception for a declaration it did not write.
 */
export function readOrigins(config: unknown): string[] {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return [];
  const record = config as { optional?: unknown; origins?: unknown };
  if (record.optional === true) return [];
  if (!Array.isArray(record.origins)) return [];
  return record.origins.filter((o): o is string => typeof o === "string");
}

/**
 * The namespace on its own, for tests: `install` is the only caller in the
 * browser, but the shape is worth exercising without a `FrameContext`.
 */
export function createNetwork(config: unknown): NetworkNamespace {
  const declared = readOrigins(config);
  // A fresh array per call: the page owns what it is handed, and mutating it
  // must not edit the next caller's answer.
  return { origins: () => Promise.resolve(declared.slice()) };
}

export function install(ctx: FrameContext): void {
  const pipe = ctx.pipe(CAP);
  const declared = readOrigins(ctx.capabilities[CAP]?.config);
  const origins = pipe.wrap("origins", () => declared.slice());
  ctx.mount(CAP, { origins });
}
