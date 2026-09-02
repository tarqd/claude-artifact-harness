/**
 * The shared grammar: manifest, identity, plain-JSON rule, cache policy,
 * error vocabulary and result shapes (reference/contract/0.2.32/mcp.d.ts).
 */
import { describe, expect, it } from "vitest";
import { CAP_BUDGETS } from "../../src/protocol/messages.ts";
import {
  DEFAULT_GC_TIME_MS,
  MAX_GC_TIME_MS,
  MAX_STALE_TIME_MS,
  MIN_REFETCH_INTERVAL_MS,
  asMcpError,
  callIdentity,
  canonicalJson,
  derivePayload,
  inManifest,
  isFrameMcpWatch,
  isHostServer,
  isPlainJson,
  mcpError,
  normalizeAuthStatus,
  normalizeResult,
  readCacheOption,
  readListToolsReply,
  readManifest,
  readRefetchInterval,
  replyBudget,
  resolveCachePolicy,
  serverConsentKey,
  validateCallArgs,
} from "../../src/capabilities/mcp/protocol.ts";

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("manifest", () => {
  it("reads {servers: [{server, tools}]} and drops what it cannot use", () => {
    const manifest = readManifest({
      servers: [
        { server: "Google Calendar", tools: ["list_events", "create_event"] },
        { server: "Empty", tools: [] },
        { server: "", tools: ["x"] },
        { server: "Bad", tools: "x" },
        { tools: ["x"] },
        "nonsense",
        { server: "Google Calendar", tools: ["delete_event", "list_events"] },
        { server: "host:filesystem", tools: ["read_file", 7, ""] },
      ],
    });
    expect(manifest.servers).toEqual([
      { server: "Google Calendar", tools: ["list_events", "create_event", "delete_event"] },
      { server: "host:filesystem", tools: ["read_file"] },
    ]);
    expect(inManifest(manifest, "Google Calendar", "delete_event")).toBe(true);
    expect(inManifest(manifest, "Google Calendar", "nope")).toBe(false);
    expect(inManifest(manifest, "Empty", "x")).toBe(false);
    expect(isHostServer("host:filesystem")).toBe(true);
    expect(isHostServer("Google Calendar")).toBe(false);
  });

  it("reads nothing from a missing or malformed config", () => {
    expect(readManifest(undefined).servers).toEqual([]);
    expect(readManifest({}).servers).toEqual([]);
    expect(readManifest({ servers: "x" }).servers).toEqual([]);
    expect(readManifest([]).servers).toEqual([]);
  });
});

describe("call identity", () => {
  it("ignores property order at every level", () => {
    const a = callIdentity("S", "t", { b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } });
    const b = callIdentity("S", "t", { a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 });
    expect(a).toBe(b);
    expect(callIdentity("S", "t", { a: 1 })).not.toBe(callIdentity("S", "t", { a: 2 }));
    expect(callIdentity("S", "t", { a: 1 })).not.toBe(callIdentity("S", "u", { a: 1 }));
  });

  it("treats undefined, null and {} as the one input-less call", () => {
    expect(callIdentity("S", "t", undefined)).toBe(callIdentity("S", "t", null));
    expect(callIdentity("S", "t", null)).toBe(callIdentity("S", "t", {}));
    expect(callIdentity("S", "t", [])).not.toBe(callIdentity("S", "t", {}));
  });

  it("drops undefined properties like JSON does", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined, 1])).toBe("[null,1]");
  });
});

describe("plain JSON", () => {
  it("accepts JSON and refuses everything else", () => {
    expect(isPlainJson({ a: [1, "x", true, null, { b: 2 }] })).toBe(true);
    expect(isPlainJson(null)).toBe(true);
    expect(isPlainJson("s")).toBe(true);
    expect(isPlainJson({ a: undefined })).toBe(true);
    expect(isPlainJson(undefined)).toBe(false);
    expect(isPlainJson(new Map())).toBe(false);
    expect(isPlainJson(new Set())).toBe(false);
    expect(isPlainJson(new Date())).toBe(false);
    expect(isPlainJson(new Uint8Array(2))).toBe(false);
    expect(isPlainJson(10n)).toBe(false);
    expect(isPlainJson(Number.NaN)).toBe(false);
    expect(isPlainJson(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isPlainJson(() => 1)).toBe(false);
    expect(isPlainJson(Symbol("s"))).toBe(false);
    expect(isPlainJson({ nested: { fn: () => 1 } })).toBe(false);
    expect(isPlainJson(Object.create(null))).toBe(true);
    class Thing {}
    expect(isPlainJson(new Thing())).toBe(false);
  });

  it("bounds nesting", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 45; i++) deep = [deep];
    expect(isPlainJson(deep)).toBe(false);
  });
});

describe("validateCallArgs", () => {
  it("checks names and input", () => {
    expect(validateCallArgs("S", "t", undefined)).toEqual({ server: "S", tool: "t", input: {} });
    expect(validateCallArgs("S", "t", { a: 1 })).toEqual({ server: "S", tool: "t", input: { a: 1 } });
    expect(thrown(() => validateCallArgs(1, "t", {}))).toMatchObject({ code: "bad_request" });
    expect(thrown(() => validateCallArgs("S", "", {}))).toMatchObject({ code: "bad_request" });
    expect(thrown(() => validateCallArgs("S", "t", new Map()))).toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("plain JSON"),
    });
    // Arguments are an object: a bare array or scalar is a caller bug.
    expect(thrown(() => validateCallArgs("S", "t", [1]))).toMatchObject({ code: "bad_request" });
    expect(thrown(() => validateCallArgs("S", "t", 5))).toMatchObject({ code: "bad_request" });
    expect(validateCallArgs("S", "t", null)).toEqual({ server: "S", tool: "t", input: {} });
    expect(thrown(() => validateCallArgs("S", "t", { big: "x".repeat(300_000) }))).toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("256 KiB"),
    });
  });
});

describe("cache policy", () => {
  it("validates the option", () => {
    expect(readCacheOption(undefined, "call")).toBeUndefined();
    expect(readCacheOption(null, "call")).toBeUndefined();
    expect(readCacheOption(false, "call")).toBe(false);
    expect(readCacheOption({ staleTime: 5, gcTime: 6, refresh: true }, "call")).toEqual({
      staleTime: 5,
      gcTime: 6,
      refresh: true,
    });
    // `refresh` is not a watch option.
    expect(readCacheOption({ refresh: true }, "watch")).toEqual({});
    expect(thrown(() => readCacheOption("yes", "call"))).toMatchObject({ code: "bad_request" });
    expect(thrown(() => readCacheOption({ staleTime: "5" }, "call"))).toMatchObject({ code: "bad_request" });
    expect(thrown(() => readCacheOption({ refresh: 1 }, "call"))).toMatchObject({ code: "bad_request" });
  });

  it("follows the readOnlyHint floor and the defaults", () => {
    // A declared write is never cached, whatever the page asks.
    expect(resolveCachePolicy({ staleTime: 1000 }, false)).toMatchObject({ read: false, write: false });
    expect(resolveCachePolicy(undefined, false)).toMatchObject({ read: false, write: false });
    // Omitted: a declared read caches with staleTime 0 and gcTime 5 min.
    expect(resolveCachePolicy(undefined, true)).toEqual({
      read: true,
      write: true,
      staleTime: 0,
      gcTime: DEFAULT_GC_TIME_MS,
    });
    // Omitted on an unannotated tool: nothing is cached.
    expect(resolveCachePolicy(undefined, undefined)).toMatchObject({ read: false, write: false });
    // `false` never caches, even a declared read.
    expect(resolveCachePolicy(false, true)).toMatchObject({ read: false, write: false });
    // An object opts an unannotated tool in.
    expect(resolveCachePolicy({}, undefined)).toEqual({
      read: true,
      write: true,
      staleTime: 0,
      gcTime: DEFAULT_GC_TIME_MS,
    });
  });

  it("clamps staleTime and gcTime and reads refresh", () => {
    expect(resolveCachePolicy({ staleTime: 10 * 60_000 }, true).staleTime).toBe(MAX_STALE_TIME_MS);
    expect(resolveCachePolicy({ staleTime: -5 }, true).staleTime).toBe(0);
    expect(resolveCachePolicy({ gcTime: 2 * MAX_GC_TIME_MS }, true).gcTime).toBe(MAX_GC_TIME_MS);
    expect(resolveCachePolicy({ gcTime: 0 }, true)).toMatchObject({ read: false, write: false });
    expect(resolveCachePolicy({ refresh: true }, true)).toMatchObject({ read: false, write: true });
  });

  it("clamps refetchInterval to the 30 s floor", () => {
    expect(readRefetchInterval(undefined)).toBeNull();
    expect(readRefetchInterval(1000)).toBe(MIN_REFETCH_INTERVAL_MS);
    expect(readRefetchInterval(45_000)).toBe(45_000);
    expect(thrown(() => readRefetchInterval(0))).toMatchObject({ code: "bad_request" });
    expect(thrown(() => readRefetchInterval("soon"))).toMatchObject({ code: "bad_request" });
  });
});

describe("errors", () => {
  it("stamps retryable only as true and clamps retryAfterMs", () => {
    expect(mcpError("server_unavailable", "down", { retryAfterMs: 120_000 })).toEqual({
      code: "server_unavailable",
      message: "down",
      retryable: true,
      retryAfterMs: 60_000,
    });
    expect(mcpError("needs_reauth", "lapsed", { server: "S" })).toEqual({
      code: "needs_reauth",
      message: "lapsed",
      server: "S",
    });
    expect("retryable" in mcpError("upstream_error", "x")).toBe(false);
  });

  it("folds anything into the page's vocabulary", () => {
    expect(asMcpError({ code: "tool_error", message: "m", result: { isError: true } })).toEqual({
      code: "tool_error",
      message: "m",
      result: { isError: true },
    });
    expect(asMcpError({ code: "nonesuch", message: "m" })).toEqual({ code: "upstream_error", message: "m" });
    expect(asMcpError({ code: "invalid_content", message: "clone" })).toEqual({
      code: "bad_request",
      message: "clone",
    });
    expect(asMcpError(new Error("boom"))).toEqual({ code: "upstream_error", message: "boom" });
    expect(asMcpError({ code: "capability_disabled", message: "m" }).code).toBe("capability_disabled");
    // A newer code the producing layer stamped retryable keeps the stamp.
    expect(asMcpError({ code: "rate_limited", message: "m", retryable: true }).retryable).toBe(true);
  });
});

describe("results", () => {
  it("derives payload from structuredContent, then JSON text, then text", () => {
    expect(derivePayload([{ type: "text", text: '{"a":1}' }], { b: 2 })).toEqual({ b: 2 });
    expect(derivePayload([{ type: "text", text: '{"a":1}' }], undefined)).toEqual({ a: 1 });
    expect(derivePayload([{ type: "image", data: "x" }, { type: "text", text: "plain" }], undefined)).toBe(
      "plain",
    );
    expect(derivePayload([{ type: "image", data: "x" }], undefined)).toBeUndefined();
  });

  it("normalises an upstream result and strips what only the shell may stamp", () => {
    const { result, isError } = normalizeResult({
      content: [{ type: "text", text: "oops" }, "junk", { text: "no type" }],
      isError: true,
      cache: { storedAt: 1, revalidating: false },
    });
    expect(isError).toBe(true);
    expect(result).toEqual({ content: [{ type: "text", text: "oops" }], payload: "oops" });
    expect(normalizeResult(null)).toEqual({ result: { content: [] }, isError: false });
  });

  it("normalises auth statuses to the closed set", () => {
    expect(normalizeAuthStatus("authenticated")).toBe("connected");
    expect(normalizeAuthStatus("not_required")).toBe("connected");
    expect(normalizeAuthStatus("connected")).toBe("connected");
    expect(normalizeAuthStatus("token_invalid")).toBe("needs_reauth");
    expect(normalizeAuthStatus("auth_required")).toBe("needs_reauth");
    expect(normalizeAuthStatus("refresh_failed")).toBe("needs_reauth");
    expect(normalizeAuthStatus("managed_auth_failed")).toBe("needs_reauth");
    expect(normalizeAuthStatus("needs_reauth")).toBe("needs_reauth");
    expect(normalizeAuthStatus("weird")).toBe("unknown");
    expect(normalizeAuthStatus(undefined)).toBe("unknown");
  });

  it("reads the listTools reply in either envelope", () => {
    const rows = [
      {
        server: "A",
        authStatus: "authenticated",
        tools: [{ name: "t", description: "d", annotations: { readOnlyHint: true, other: 1 } }, { name: 3 }],
      },
      { server: 5 },
    ];
    const expected = {
      servers: [
        { server: "A", authStatus: "connected", tools: [{ name: "t", description: "d", annotations: { readOnlyHint: true } }] },
      ],
    };
    expect(readListToolsReply(rows)).toEqual(expected);
    expect(readListToolsReply({ servers: rows })).toEqual(expected);
    expect(readListToolsReply("x")).toEqual({ servers: [] });
  });
});

describe("wire", () => {
  it("recognises the watch push", () => {
    expect(isFrameMcpWatch({ __frame_mcp_watch: true, watchId: "w1", ev: { type: "data", result: {} } })).toBe(true);
    expect(
      isFrameMcpWatch({ __frame_mcp_watch: true, watchId: "w1", ev: { type: "error", error: { code: "x", message: "m" } } }),
    ).toBe(true);
    expect(isFrameMcpWatch({ __frame_mcp_watch: true, watchId: "w1", ev: { type: "other" } })).toBe(false);
    expect(isFrameMcpWatch({ __frame_mcp_watch: true, ev: { type: "data", result: {} } })).toBe(false);
    expect(isFrameMcpWatch({ __frame_db_ev: true })).toBe(false);
  });

  it("derives the reply budget from capBudgets, clamped and with grace", () => {
    expect(replyBudget(CAP_BUDGETS, "callTool")).toBe(132_000);
    expect(replyBudget({ mcp: { callTool: 900_000 } }, "callTool")).toBe(602_000);
    expect(replyBudget({}, "listTools")).toBe(130_000);
    expect(replyBudget(undefined, "listTools")).toBe(130_000);
  });

  it("keys a server's consent under the permissions slice's scoped name", () => {
    expect(serverConsentKey("abc", "Google Calendar")).toBe("consent:abc:mcp:Google Calendar");
  });
});
