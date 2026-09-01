/**
 * The `__frame_cap` dispatcher. Origin and source have already been checked
 * by the host; this layer validates the envelope, resolves the capability
 * (aliases included), refuses anything this view does not serve, and turns
 * every outcome into exactly one `__frame_cap_r`.
 */
import { resolveCapability } from "../protocol/capabilities.ts";
import { CAPABILITY_DISABLED, toCapError, type CapError } from "../protocol/errors.ts";
import { isFrameCapCall } from "../protocol/messages.ts";
import { BROKERS } from "./registry.ts";
import type { BrokerCall, BrokerContext } from "./types.ts";

export interface BrokerReply {
  __frame_cap_r: true;
  id: string;
  result?: unknown;
  error?: CapError;
}

/** Validate an inbound message as a capability call, or return null. */
export function readCapCall(data: unknown): BrokerCall | null {
  if (!isFrameCapCall(data)) return null;
  return { cap: data.cap, id: data.id, method: data.method, args: data.args };
}

/** The slices this view was granted, with every declared alias resolved. */
function grantedSlices(ctx: BrokerContext): Set<string> {
  const granted = new Set<string>();
  for (const name of Object.keys(ctx.boot.capabilities)) {
    const slice = resolveCapability(name);
    if (slice) granted.add(slice);
  }
  return granted;
}

export async function dispatch(call: BrokerCall, ctx: BrokerContext): Promise<BrokerReply> {
  try {
    const slice = resolveCapability(call.cap);
    if (!slice) throw CAPABILITY_DISABLED(`the capability "${call.cap}"`);
    // A capability the view was not granted is indistinguishable from one
    // that does not exist: both are `capability_disabled`. The gate is on the
    // slice, not the spelling: a page that declared `self` calls `artifact`.
    if (!grantedSlices(ctx).has(slice)) {
      throw CAPABILITY_DISABLED(`the capability "${call.cap}"`);
    }
    const broker = BROKERS[slice];
    if (!broker || typeof broker.handle !== "function") {
      throw CAPABILITY_DISABLED(`the capability "${call.cap}"`);
    }
    const result = await broker.handle(call, ctx);
    return { __frame_cap_r: true, id: call.id, result };
  } catch (err) {
    return { __frame_cap_r: true, id: call.id, error: toCapError(err) };
  }
}

/** Tear down every broker's per-view state when the frame is remounted. */
export function disposeBrokers(ctx: BrokerContext): void {
  for (const broker of Object.values(BROKERS)) {
    try {
      broker.dispose?.(ctx);
    } catch {
      /* a slice's teardown must not stop the remount */
    }
  }
}
