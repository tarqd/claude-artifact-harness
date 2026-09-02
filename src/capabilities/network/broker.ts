/**
 * `network` — no broker calls exist.
 *
 * The namespace answers `origins()` from the config the shell already sent in
 * `__frame_init`, and the allowlist itself is enforced by the CSP the frame
 * origin serves. Neither needs the shell at request time, which is why
 * surface-area.md §11 lists "claude.ai reference endpoints: none" for this
 * capability.
 *
 * A `__frame_cap` addressed to `network` therefore only ever arrives from a
 * page (or a future runtime) calling a method this contract does not have.
 * The answer is `capability_disabled`, the same code an ungranted capability
 * gets from `src/shell/broker.ts`: a method that is not there and a
 * capability that is not there are indistinguishable to a page, and both mean
 * "do not retry, take the other branch".
 */
import { CAPABILITY_DISABLED } from "../../protocol/errors.ts";
import type { BrokerCall, BrokerContext } from "../../shell/types.ts";

export function handle(call: BrokerCall, _ctx: BrokerContext): Promise<never> {
  return Promise.reject(CAPABILITY_DISABLED(`${call.cap}.${call.method}`));
}
