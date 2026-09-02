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
 * to 900 s), then asks through the shared `consent.ts`, which stores the
 * answer under the same key the `sample` and `mcp` slices read, so a viewer
 * is asked once per artifact whichever surface asked. A stored `"denied"` is
 * returned as-is and never re-prompts — the same rule browsers apply to
 * `Notification.requestPermission`, and the reason a page cannot nag by
 * looping on `request()`. When the browser cannot persist at all the answer
 * is remembered in memory for the life of the shell page, and a hard cap of
 * five dialogs per artifact per minute stops a page turning an unstorable
 * decision into a stream of modals over the shell.
 */
import { CAPABILITY_DISABLED } from "../../protocol/errors.ts";
import { resolveCapability } from "../../protocol/capabilities.ts";
import type { BrokerCall, BrokerContext, ConsentRequest } from "../../shell/types.ts";
import { consentCopy as mcpConsentCopy, manifestOf } from "../mcp/broker.ts";
import { isHostServer, manifestServer, serverConsentKey } from "../mcp/protocol.ts";
import { askOnce, readDecision, resetConsentForTest } from "./consent.ts";
import {
  CAP,
  CONSENT_CAPS,
  baseName,
  consentKey,
  normalizeName,
  scopeOf,
  validateRequestNames,
  validateStateName,
  type PermissionState,
} from "./protocol.ts";

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

/** The stored decision under `key`, or `"prompt"` when the viewer has not decided. */
function decidedState(key: string): PermissionState {
  return readDecision(key) ?? "prompt";
}

/**
 * The servers a viewer can be asked about: the manifest minus `host:`
 * entries, which name a server on the viewer's device that this surface
 * cannot reach (the `mcp` slice omits them from `listTools()` and refuses
 * every call), so there is nothing to consent to.
 */
function askableServers(ctx: BrokerContext): string[] {
  return manifestOf(ctx)
    .servers.map((entry) => entry.server)
    .filter((server) => !isHostServer(server));
}

/**
 * `mcp` is decided per declared server. A scoped name answers for its
 * server (`"unavailable"` for one the manifest does not declare, or a
 * `host:` one); the bare name is the aggregate over the askable servers:
 * `"prompt"` while any is undecided, else `"denied"` if any was refused,
 * else `"granted"` — which is what "granted only when every declared server
 * is covered" (mcp.d.ts) comes to, and vacuously true of an empty manifest.
 */
function mcpState(name: string, ctx: BrokerContext): PermissionState {
  if (name === "mcp") {
    const states = askableServers(ctx).map((server) =>
      decidedState(serverConsentKey(ctx.boot.artifactId, server)),
    );
    if (states.includes("prompt")) return "prompt";
    if (states.includes("denied")) return "denied";
    return "granted";
  }
  const server = scopeOf(name);
  if (isHostServer(server) || !manifestServer(manifestOf(ctx), server)) return "unavailable";
  return decidedState(serverConsentKey(ctx.boot.artifactId, server));
}

export function stateOf(name: string, ctx: BrokerContext): PermissionState {
  const normalized = normalizeName(name);
  const base = baseName(normalized);
  if (!declaredNames(ctx).has(base)) return "unavailable";
  // Only `mcp` has scoped names (`mcp:<server>`, `mcp:host:<name>`).
  if (base === "mcp") return mcpState(normalized, ctx);
  if (normalized !== base) return "unavailable";
  // `permissions` is not a capability one asks permission for.
  if (normalized === CAP) return "granted";
  if (!CONSENT_CAPS.has(normalized)) return "granted";
  return decidedState(consentKey(ctx.boot.artifactId, normalized));
}

/**
 * The whole map: every capability this view declared and this build serves,
 * minus `permissions` itself — it is always present and can never be decided,
 * so listing it would only invite `request(["permissions"])`. `mcp` lists
 * its aggregate and one `mcp:<server>` entry per declared server.
 */
export function stateMap(ctx: BrokerContext): Record<string, PermissionState> {
  const out: Record<string, PermissionState> = {};
  for (const declared of declaredNames(ctx)) {
    if (declared === CAP) continue;
    out[declared] = stateOf(declared, ctx);
    if (declared === "mcp") {
      for (const server of askableServers(ctx)) {
        const scoped = `mcp:${server}`;
        out[scoped] = stateOf(scoped, ctx);
      }
    }
  }
  return out;
}

/* --------------------------------- prompts -------------------------------- */

/**
 * The copy the viewer reads. `sample` matches the `sample` slice's own
 * dialog, and `mcp:<server>` the `mcp` slice's, so the viewer sees the same
 * question whichever surface asks first.
 */
function consentCopy(name: string, ctx: BrokerContext): ConsentRequest {
  if (baseName(name) === "mcp") {
    const server = scopeOf(name);
    return mcpConsentCopy(server, manifestServer(manifestOf(ctx), server)?.tools ?? []);
  }
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
  // The bare `mcp` is the whole manifest: asking it asks for every server,
  // one dialog after another, and answers with the aggregate.
  if (normalized === "mcp") {
    for (const server of askableServers(ctx)) {
      await decide(`mcp:${server}`, ctx, ack);
    }
    return stateOf("mcp", ctx);
  }
  const key =
    baseName(normalized) === "mcp"
      ? serverConsentKey(ctx.boot.artifactId, scopeOf(normalized))
      : consentKey(ctx.boot.artifactId, normalized);
  // The viewer is about to be asked, or to wait on a dialog already up: tell
  // the frame before it opens, so its 130 s budget becomes 900 s while
  // somebody reads the question.
  ack();
  // One dialog per key across every slice, one at a time, and the first
  // answer stands (consent.ts). A viewer the prompt cap kept from being
  // asked has decided nothing: the name still reads "prompt".
  const decision = await askOnce(ctx, key, () => consentCopy(normalized, ctx));
  return decision ?? "prompt";
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

/** Only for tests: the shared consent state outlives a single view. */
export function resetForTest(): void {
  resetConsentForTest();
}
