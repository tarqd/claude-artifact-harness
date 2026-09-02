/**
 * `network` has no wire methods; the broker exists only to refuse.
 */
import { describe, expect, it } from "vitest";
import { handle } from "../../src/capabilities/network/broker.ts";
import type { BrokerCall, BrokerContext } from "../../src/shell/types.ts";

const ctx = {} as BrokerContext;
const call = (method: string): BrokerCall => ({ cap: "network", id: "w1", method, args: [] });

describe("handle", () => {
  it("rejects every method with capability_disabled, as plain data", async () => {
    for (const method of ["origins", "fetch", "anything"]) {
      await expect(handle(call(method), ctx)).rejects.toMatchObject({
        code: "capability_disabled",
        message: `network.${method} is not available in this view`,
      });
      await expect(handle(call(method), ctx)).rejects.not.toBeInstanceOf(Error);
    }
  });
});
