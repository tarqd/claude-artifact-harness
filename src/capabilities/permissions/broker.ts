/**
 * `permissions` broker: the shell answers, because only the shell knows what
 * this view was granted and what the viewer has already decided.
 *
 * The rules (surface-area.md §5.2, docs/analysis/shell.md §"permissions"):
 *
 * - a capability this view did not declare is `"unavailable"` — the same
 *   answer a page gets for a capability that does not exist at all, so a
 *   permissions read never reveals the roster;
 * - a capability whose first use asks the viewer (`sample`) reads the
 *   viewer's stored answer under `consent:<artifactId>:<cap>`: `"granted"`,
 *   `"denied"`, and otherwise `"prompt"`;
 * - everything else this view declared is `"granted"`.
 *
 * `state()` never prompts. `request()` prompts once per undecided name: it
 * sends `__frame_cap_ack` first (which extends the frame's budget from 130 s
 * to 900 s), shows `ctx.consent`, and stores the answer under the same key
 * the `sample` slice reads, so a viewer is asked once per artifact whichever
 * surface asked. A stored `"denied"` is returned as-is and never re-prompts —
 * the same rule browsers apply to `Notification.requestPermission`, and the
 * reason a page cannot nag by looping on `request()`. When the browser cannot
 * persist at all the answer is remembered in memory for the life of the view,
 * and a hard cap of five dialogs per artifact per minute stops a page turning
 * an unstorable decision into a stream of modals over the shell.
 */
import { CAPABILITY_DISABLED } from "../../protocol/errors.ts";
import { resolveCapability } from "../../protocol/capabilities.ts";
import type { BrokerCall, BrokerContext, ConsentRequest } from "../../shell/types.ts";
import {
  CAP,
  CONSENT_CAPS,
  consentKey,
  normalizeName,
  validateRequestNames,
  validateStateName,
  type PermissionState,
} from "./protocol.ts";

/* ------------------------------ stored answers ---------------------------- */

/**
 * Decisions this session could not persist. `localStorage` throws in a
 * private window and is absent in some embeddings; without this the viewer
 * would be asked again on every single call, so an answer is at least
 * remembered for as long as the view is open.
 */
const remembered = new Map<string, string>();

function readStored(key: string): string | null {
  try {
    const stored = globalThis.localStorage?.getItem(key);
    if (stored !== undefined && stored !== null) return stored;
  } catch {
    /* falls through to what this session remembers */
  }
  return remembered.get(key) ?? null;
}

function writeStored(key: string, value: string): void {
  remembered.set(key, value);
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* private mode, or no storage at all: this session remembers it instead */
  }
}

/** A stored answer, or `null` if the viewer has not decided this key yet. */
function storedState(key: string): PermissionState | null {
  const stored = readStored(key);
  return stored === "granted" || stored === "denied" ? stored : null;
}

/**
 * One dialog per key, however many calls are waiting on it. Keyed by the
 * storage key, so two views of the same artifact in one page share it.
 */
const consentInFlight = new Map<string, Promise<PermissionState>>();

/* ------------------------------- prompt cap ------------------------------- */

/**
 * A dialog makes the iframe inert and blocks the shell, so a page that can
 * keep reaching `"prompt"` (storage blocked, every answer refused) must not
 * be able to loop one up forever. Same shape as the `downloads` cap:
 * 5 per artifact per minute, then the last answer — or `"denied"`.
 */
const MAX_PROMPTS_PER_WINDOW = 5;
const PROMPT_WINDOW_MS = 60_000;
const promptTimes = new Map<string, number[]>();

function promptAllowed(artifactId: string): boolean {
  const now = Date.now();
  const recent = (promptTimes.get(artifactId) ?? []).filter(
    (at) => now - at < PROMPT_WINDOW_MS,
  );
  if (recent.length >= MAX_PROMPTS_PER_WINDOW) {
    promptTimes.set(artifactId, recent);
    return false;
  }
  recent.push(now);
  promptTimes.set(artifactId, recent);
  return true;
}

/* ------------------------------- state rules ------------------------------ */

/**
 * Every spelling this view answers to. Only names this build actually serves
 * count: a declaration the roster does not know (`mcp`, `comments`) reaches
 * `__frame_init` verbatim but mounts no module, so `use()` resolves `null`
 * for it and a permissions read must say `"unavailable"` rather than promise
 * something no page can call. The set holds canonical slice names only: the
 * legacy spelling `self` is resolved away here and by `normalizeName`, so
 * either spelling — from the page or from the declaration — answers for
 * `artifact`.
 */
export function declaredNames(ctx: BrokerContext): Set<string> {
  const out = new Set<string>();
  for (const declared of Object.keys(ctx.boot.capabilities)) {
    const slice = resolveCapability(declared);
    if (!slice) continue;
    out.add(slice);
  }
  return out;
}

export function stateOf(name: string, ctx: BrokerContext): PermissionState {
  const normalized = normalizeName(name);
  // A scoped name (`mcp:<server>`, `mcp:host:<name>`) is never in the set:
  // its base capability is `mcp`, which v0 does not serve at all.
  if (!declaredNames(ctx).has(normalized)) return "unavailable";
  // `permissions` is not a capability one asks permission for.
  if (normalized === CAP) return "granted";
  if (!CONSENT_CAPS.has(normalized)) return "granted";
  const stored = readStored(consentKey(ctx.boot.artifactId, normalized));
  if (stored === "granted" || stored === "denied") return stored;
  return "prompt";
}

/**
 * The whole map: every capability this view declared and this build serves,
 * minus `permissions` itself — it is always present and can never be decided,
 * so listing it would only invite `request(["permissions"])`.
 */
export function stateMap(ctx: BrokerContext): Record<string, PermissionState> {
  const out: Record<string, PermissionState> = {};
  for (const declared of declaredNames(ctx)) {
    if (declared === CAP) continue;
    out[declared] = stateOf(declared, ctx);
  }
  return out;
}

/* --------------------------------- prompts -------------------------------- */

/** The copy the viewer reads. `sample` matches the `sample` slice's own dialog. */
function consentCopy(name: string): ConsentRequest {
  if (name === "sample") {
    return {
      title: "Let this artifact ask Claude?",
      body: "This page wants to send text you give it to Claude on your account, and show the answer. It can do this whenever you use the page.",
      confirmLabel: "Allow",
      cancelLabel: "Not now",
    };
  }
  return {
    title: `Let this artifact use ${name}?`,
    body: `This page is asking for the "${name}" capability. It can use it whenever you have the page open.`,
    confirmLabel: "Allow",
    cancelLabel: "Not now",
  };
}

async function decide(
  name: string,
  ctx: BrokerContext,
  ack: () => void,
): Promise<PermissionState> {
  const current = stateOf(name, ctx);
  if (current !== "prompt") return current;

  const normalized = normalizeName(name);
  const key = consentKey(ctx.boot.artifactId, normalized);
  // The viewer is about to be asked, or to wait on a dialog already up: tell
  // the frame before it opens, so its 130 s budget becomes 900 s while
  // somebody reads the question.
  ack();

  let dialog = consentInFlight.get(key);
  if (!dialog) {
    // Read the key again rather than trusting `stateOf`'s: a slice that keeps
    // its own first-call dialog for the same key (`sample`) may have been
    // answered while an earlier name in this same `request()` was decided.
    const settled = storedState(key);
    if (settled) return settled;
    if (!promptAllowed(ctx.boot.artifactId)) return storedState(key) ?? "denied";
    dialog = ctx
      .consent(consentCopy(normalized))
      .then((granted): PermissionState => {
        // Same reason, one step later: a decision that landed while this
        // dialog was open is the viewer's first answer, and a stale one must
        // not overwrite it.
        const raced = storedState(key);
        if (raced) return raced;
        const answer: PermissionState = granted ? "granted" : "denied";
        writeStored(key, answer);
        return answer;
      })
      .finally(() => consentInFlight.delete(key));
    consentInFlight.set(key, dialog);
  }
  return await dialog;
}

/* -------------------------------- dispatch -------------------------------- */

export async function handle(call: BrokerCall, ctx: BrokerContext): Promise<unknown> {
  if (call.method === "state") {
    const name = validateStateName(call.args[0]);
    return name === undefined ? stateMap(ctx) : stateOf(name, ctx);
  }

  if (call.method === "request") {
    const asked = validateRequestNames(call.args[0]);
    // No names: everything this view could decide.
    const names = asked ?? Object.keys(stateMap(ctx));
    let acked = false;
    const ack = (): void => {
      if (acked) return;
      acked = true;
      ctx.ack(call.id);
    };
    const out: Record<string, PermissionState> = {};
    // Sequential on purpose: two dialogs at once would stack over each other.
    for (const name of names) {
      out[name] = await decide(name, ctx, ack);
    }
    return out;
  }

  throw CAPABILITY_DISABLED(`${CAP}.${call.method}`);
}

/** Only for tests: the module-level maps outlive a single view. */
export function resetForTest(): void {
  consentInFlight.clear();
  remembered.clear();
  promptTimes.clear();
}
