/**
 * The two documented limits and the shared vocabulary. Validation lives in
 * `protocol.ts` because both sides run it: the frame so a bad call costs no
 * round trip, the shell because a frame is never trusted to have validated.
 */
import { describe, expect, it } from "vitest";
import {
  CONSENT_CAPS,
  MAX_NAMES,
  MAX_NAME_LENGTH,
  consentKey,
  hasGovernableCapability,
  isPermissionState,
  normalizeName,
  unavailableMap,
  validateRequestNames,
  validateStateName,
} from "../../src/capabilities/permissions/protocol.ts";

function thrown(fn: () => unknown): { code?: string; message?: string } {
  try {
    fn();
    return { code: "no throw" };
  } catch (err) {
    return err as { code?: string; message?: string };
  }
}

describe("state(name?) validation", () => {
  it("accepts no name, a name, and a name of exactly the limit", () => {
    expect(validateStateName(undefined)).toBeUndefined();
    expect(validateStateName(null)).toBeUndefined();
    expect(validateStateName("sample")).toBe("sample");
    expect(validateStateName("x".repeat(MAX_NAME_LENGTH))).toHaveLength(MAX_NAME_LENGTH);
  });

  it("refuses a non-string, an empty name and an over-long name", () => {
    expect(thrown(() => validateStateName(7))).toEqual({
      code: "invalid_content",
      message: "a capability name must be a string",
    });
    expect(thrown(() => validateStateName(""))).toMatchObject({ code: "invalid_content" });
    expect(thrown(() => validateStateName("x".repeat(MAX_NAME_LENGTH + 1)))).toEqual({
      code: "invalid_content",
      message: "a capability name must be at most 512 characters",
    });
  });

  it("keeps a scoped name exactly as the page wrote it", () => {
    expect(validateStateName("mcp:Google Calendar")).toBe("mcp:Google Calendar");
    expect(normalizeName("mcp:host:filesystem")).toBe("mcp:host:filesystem");
    // `self` is the legacy spelling of one capability, so it folds.
    expect(normalizeName("self")).toBe("artifact");
    expect(normalizeName("nonesuch")).toBe("nonesuch");
  });
});

describe("request(names?) validation", () => {
  it("accepts no names and a list at the limit", () => {
    expect(validateRequestNames(undefined)).toBeUndefined();
    const many = Array.from({ length: MAX_NAMES }, (_, i) => `cap${i}`);
    expect(validateRequestNames(many)).toHaveLength(MAX_NAMES);
  });

  it("refuses a non-array, too many names and a non-string entry", () => {
    expect(thrown(() => validateRequestNames("sample"))).toEqual({
      code: "invalid_content",
      message: "request takes an array of capability names",
    });
    expect(thrown(() => validateRequestNames(new Array(MAX_NAMES + 1).fill("db")))).toEqual({
      code: "invalid_content",
      message: "request takes at most 32 names",
    });
    expect(thrown(() => validateRequestNames(["db", 3]))).toMatchObject({
      code: "invalid_content",
    });
    // `null` inside the array is a name, not "no name".
    expect(thrown(() => validateRequestNames(["db", null]))).toMatchObject({
      code: "invalid_content",
    });
  });

  it("folds duplicates but keeps the order asked", () => {
    expect(validateRequestNames(["sample", "db", "sample"])).toEqual(["sample", "db"]);
  });
});

describe("vocabulary and helpers", () => {
  it("knows the four states", () => {
    for (const state of ["granted", "denied", "prompt", "unavailable"]) {
      expect(isPermissionState(state)).toBe(true);
    }
    expect(isPermissionState("maybe")).toBe(false);
    expect(isPermissionState(undefined)).toBe(false);
  });

  it("uses the same storage key the sample slice reads", () => {
    expect(consentKey("abc", "sample")).toBe("consent:abc:sample");
    expect([...CONSENT_CAPS]).toEqual(["sample"]);
  });

  it("maps every asked name to unavailable", () => {
    expect(unavailableMap(["db", "sample"])).toEqual({ db: "unavailable", sample: "unavailable" });
    expect(unavailableMap([])).toEqual({});
  });

  it("counts only capabilities other than permissions and user as governable", () => {
    expect(hasGovernableCapability({})).toBe(false);
    expect(hasGovernableCapability({ permissions: {} })).toBe(false);
    expect(hasGovernableCapability({ permissions: {}, user: {} })).toBe(false);
    expect(hasGovernableCapability({ permissions: {}, sample: {} })).toBe(true);
    // the legacy spelling counts, and so does a name we do not serve
    expect(hasGovernableCapability({ self: {} })).toBe(true);
    expect(hasGovernableCapability({ mcp: {} })).toBe(true);
  });
});
