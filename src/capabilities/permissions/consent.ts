/**
 * The viewer's consent decisions, shared by every slice that asks: the
 * `permissions` broker's `request()`, the `sample` slice's first-call
 * dialog, and the `mcp` slice's per-server dialog all read and write the
 * same keys (`consent:<artifactId>:<cap>`, `consent:<artifactId>:mcp:<server>`)
 * through this one module, so whichever surface asks first the others
 * honour the answer — with `localStorage` and without it.
 *
 * One dialog per key, however many callers wait on it, and one dialog at a
 * time across every key: two slices asking in the same tick queue rather
 * than stack two modals over an inert frame. A hard cap of five dialogs per
 * artifact per minute stops a page turning an unstorable decision into a
 * stream of modals; a caller the cap refuses learns nothing (`null`) — the
 * viewer was not asked, so nothing is stored.
 */
import type { BrokerContext, ConsentRequest } from "../../shell/types.ts";

export type Decision = "granted" | "denied";

/**
 * Decisions this session could not persist. `localStorage` throws in a
 * private window and is absent in some embeddings; without this the viewer
 * would be asked again on every call, so an answer is at least remembered
 * for as long as the shell page is open.
 */
const remembered = new Map<string, Decision>();

export function readDecision(key: string): Decision | null {
  try {
    const stored = globalThis.localStorage?.getItem(key);
    if (stored === "granted" || stored === "denied") return stored;
  } catch {
    /* falls through to what this session remembers */
  }
  return remembered.get(key) ?? null;
}

export function writeDecision(key: string, decision: Decision): void {
  remembered.set(key, decision);
  try {
    globalThis.localStorage?.setItem(key, decision);
  } catch {
    /* private mode, or no storage at all: this session remembers it instead */
  }
}

/* ------------------------------- prompt cap ------------------------------- */

const MAX_PROMPTS_PER_WINDOW = 5;
const PROMPT_WINDOW_MS = 60_000;
const promptTimes = new Map<string, number[]>();

/** Whether one more dialog may open for this artifact right now (and count it). */
export function promptAllowed(artifactId: string): boolean {
  const now = Date.now();
  const recent = (promptTimes.get(artifactId) ?? []).filter((at) => now - at < PROMPT_WINDOW_MS);
  if (recent.length >= MAX_PROMPTS_PER_WINDOW) {
    promptTimes.set(artifactId, recent);
    return false;
  }
  recent.push(now);
  promptTimes.set(artifactId, recent);
  return true;
}

/* --------------------------------- asking --------------------------------- */

const inFlight = new Map<string, Promise<Decision | null>>();
/** Dialogs open one after another, whichever slice asks. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * The viewer's decision for `key`: the stored one, or the answer to one
 * dialog (`copy` is read only when a dialog really opens). Callers ack the
 * frame before calling this. Resolves `null` when the viewer could not be
 * asked because the prompt cap is spent.
 */
export function askOnce(
  ctx: BrokerContext,
  key: string,
  copy: () => ConsentRequest,
): Promise<Decision | null> {
  const settled = readDecision(key);
  if (settled) return Promise.resolve(settled);
  let dialog = inFlight.get(key);
  if (!dialog) {
    const turn = queue.then(async (): Promise<Decision | null> => {
      // Decided while this key waited its turn (the same question from the
      // other slice, answered just now): the viewer's first answer stands.
      const raced = readDecision(key);
      if (raced) return raced;
      if (!promptAllowed(ctx.boot.artifactId)) return null;
      const granted = await ctx.consent(copy());
      const later = readDecision(key);
      if (later) return later;
      const decision: Decision = granted ? "granted" : "denied";
      writeDecision(key, decision);
      return decision;
    });
    dialog = turn.finally(() => {
      if (inFlight.get(key) === dialog) inFlight.delete(key);
    });
    inFlight.set(key, dialog);
    queue = dialog.catch(() => undefined);
  }
  return dialog;
}

/** Only for tests: the module-level state outlives a single view. */
export function resetConsentForTest(): void {
  remembered.clear();
  promptTimes.clear();
  inFlight.clear();
  queue = Promise.resolve();
}
