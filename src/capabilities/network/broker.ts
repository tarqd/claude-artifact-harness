/**
 * network — STUB broker. Every call is refused with `capability_disabled`.
 */
import { CAPABILITY_DISABLED } from "../../protocol/errors.ts";
import type { BrokerCall, BrokerContext } from "../../shell/types.ts";

export function handle(call: BrokerCall, _ctx: BrokerContext): Promise<never> {
  return Promise.reject(CAPABILITY_DISABLED(`${call.cap}.${call.method}`));
}
