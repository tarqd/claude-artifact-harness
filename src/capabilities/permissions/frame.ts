/**
 * `permissions` — the page-facing namespace: `state(name?)` and
 * `request(names?)` (surface-area.md §5.2, and the scoped-name notes in
 * `reference/contract/0.2.32/mcp.d.ts`).
 *
 * The frame decides nothing. It validates the two documented limits (a name
 * of at most 512 characters, at most 32 names), then asks the shell, whose
 * broker knows what this view was granted and what the viewer has already
 * answered. The one exception is the "nothing to govern" view — a page that
 * declared no capability other than `permissions`/`user`: there the namespace
 * still mounts, but answers `"unavailable"` locally without a round trip,
 * exactly as the platform's degraded responder does.
 *
 * Both methods go through `ctx.pipe().wrap`, so a validation failure is a
 * rejection and never a synchronous throw.
 */
import { browserRpcHost, createRpc, type RpcHost } from "../../frame/rpc.ts";
import type { FrameContext } from "../../frame/types.ts";
import {
  CAP,
  hasGovernableCapability,
  isPermissionState,
  unavailableMap,
  validateRequestNames,
  validateStateName,
  type PermissionState,
} from "./protocol.ts";

export interface PermissionsNamespace {
  /** No name: the whole map. One name: just its state. */
  state(name?: string): Promise<PermissionState | Record<string, PermissionState>>;
  /** No names: everything this view can decide. Returns the states after the ask. */
  request(names?: string[]): Promise<Record<string, PermissionState>>;
}

export interface PermissionsClientOptions {
  /** Test seam: stands in for `parent.postMessage` (see `frame/rpc.ts`). */
  host?: RpcHost;
}

/** Anything the shell sends that is not a documented state reads as absent. */
function readState(value: unknown): PermissionState {
  return isPermissionState(value) ? value : "unavailable";
}

function readMap(value: unknown): Record<string, PermissionState> {
  const out: Record<string, PermissionState> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [name, state] of Object.entries(value as Record<string, unknown>)) {
    out[name] = readState(state);
  }
  return out;
}

export function createPermissions(
  ctx: FrameContext,
  options: PermissionsClientOptions = {},
): PermissionsNamespace {
  const pipe = ctx.pipe(CAP);
  const brokered = hasGovernableCapability(ctx.capabilities);
  // A view with nothing to govern never opens a channel to the shell.
  const rpc = brokered
    ? createRpc({
        cap: CAP,
        shellOrigin: ctx.shellOrigin,
        host: options.host ?? browserRpcHost(ctx.shellOrigin),
        // The reply budget is the shared 130 s, extended to 900 s by
        // `__frame_cap_ack` while a viewer has the dialog open; a call that
        // never comes back is `upstream_error` (surface-area.md §4).
      })
    : null;

  const state = pipe.wrap("state", async (name?: unknown) => {
    const validated = validateStateName(name);
    if (!rpc) return validated === undefined ? {} : ("unavailable" as PermissionState);
    const result = await rpc.call<unknown>("state", validated === undefined ? [] : [validated]);
    return validated === undefined ? readMap(result) : readState(result);
  });

  const request = pipe.wrap("request", async (names?: unknown) => {
    const validated = validateRequestNames(names);
    if (!rpc) return unavailableMap(validated ?? []);
    const result = await rpc.call<unknown>(
      "request",
      validated === undefined ? [] : [validated],
    );
    return readMap(result);
  });

  return { state, request } as PermissionsNamespace;
}

export function install(ctx: FrameContext): void {
  ctx.mount(CAP, createPermissions(ctx));
}
