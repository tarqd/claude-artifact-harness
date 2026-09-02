/**
 * The page-facing half of `network` (surface-area.md §5.6): one method that
 * echoes the declared allowlist, resolves rather than throws, and answers
 * `[]` for every shape of absent or malformed declaration.
 */
import { describe, expect, it } from "vitest";
import { CAP_BUDGETS } from "../../src/protocol/messages.ts";
import type { CapPipe, FrameContext } from "../../src/frame/types.ts";
import { createNetwork, install, readOrigins } from "../../src/capabilities/network/frame.ts";

/**
 * A `FrameContext` that behaves like the preamble's: `pipe.wrap` turns a
 * synchronous throw into a rejection, `mount` hardens the namespace the way
 * `harden()` does in `src/frame/preamble.ts`.
 */
function fakeCtx(capabilities: Record<string, { config?: unknown }>): {
  ctx: FrameContext;
  mounted: Map<string, Record<string, (...args: never[]) => Promise<unknown>>>;
} {
  const mounted = new Map<string, Record<string, (...args: never[]) => Promise<unknown>>>();
  const pipe = (cap: string): CapPipe => ({
    wrap<A extends unknown[], R>(method: string, fn: (...args: A) => R | Promise<R>) {
      return (...args: A): Promise<R> => {
        try {
          return Promise.resolve(fn(...args));
        } catch (err) {
          return Promise.reject({ code: "transform_error", message: `${cap}.${method}: ${err}` });
        }
      };
    },
  });
  const ctx: FrameContext = {
    shellOrigin: "http://shell.test",
    capabilities,
    capBudgets: CAP_BUDGETS,
    changes: new Set<string>(),
    flags: new Set<string>(),
    hooks: {},
    mount(name, namespace) {
      mounted.set(
        name,
        Object.freeze(
          Object.assign(Object.create(null) as object, namespace),
        ) as Record<string, (...args: never[]) => Promise<unknown>>,
      );
    },
    pipe,
  };
  return { ctx, mounted };
}

function ns(capabilities: Record<string, { config?: unknown }>) {
  const { ctx, mounted } = fakeCtx(capabilities);
  install(ctx);
  const namespace = mounted.get("network");
  if (!namespace) throw new Error("network was not mounted");
  return namespace as unknown as { origins(): Promise<string[]> };
}

describe("readOrigins", () => {
  it("echoes the declared origins", () => {
    expect(readOrigins({ origins: ["https://a.example", "https://b.example"] })).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("echoes the declaration verbatim, including what the CSP will refuse", () => {
    // The page is told what it declared; the browser is told only what is a
    // valid absolute https origin (see server.ts). Same strings, back.
    expect(readOrigins({ origins: ["http://a.example", "https://b.example/path"] })).toEqual([
      "http://a.example",
      "https://b.example/path",
    ]);
  });

  it("answers [] for an optional declaration", () => {
    expect(readOrigins({ optional: true, origins: ["https://a.example"] })).toEqual([]);
  });

  it("answers [] for every malformed config", () => {
    for (const bad of [undefined, null, 7, "https://a.example", [], { origins: "x" }, {}]) {
      expect(readOrigins(bad as unknown)).toEqual([]);
    }
  });

  it("drops non-string entries rather than the whole list", () => {
    expect(readOrigins({ origins: ["https://a.example", 7, null, { x: 1 }] })).toEqual([
      "https://a.example",
    ]);
  });
});

describe("the namespace", () => {
  it("mounts exactly one method, and it is a function", () => {
    const namespace = ns({ network: { config: { origins: ["https://a.example"] } } });
    expect(Object.keys(namespace)).toEqual(["origins"]);
    expect(typeof namespace.origins).toBe("function");
    expect(Object.isFrozen(namespace)).toBe(true);
  });

  it("resolves the declared origins", async () => {
    const namespace = ns({ network: { config: { origins: ["https://a.example"] } } });
    await expect(namespace.origins()).resolves.toEqual(["https://a.example"]);
  });

  it("resolves [] when the declaration carried nothing usable", async () => {
    await expect(ns({ network: {} }).origins()).resolves.toEqual([]);
    await expect(ns({ network: { config: {} } }).origins()).resolves.toEqual([]);
    await expect(ns({}).origins()).resolves.toEqual([]);
  });

  it("hands out a fresh array each call", async () => {
    const namespace = ns({ network: { config: { origins: ["https://a.example"] } } });
    const first = await namespace.origins();
    first.push("https://injected.example");
    await expect(namespace.origins()).resolves.toEqual(["https://a.example"]);
  });

  it("ignores arguments and never throws", async () => {
    const namespace = ns({ network: { config: { origins: ["https://a.example"] } } });
    const call = namespace.origins as (...args: unknown[]) => Promise<string[]>;
    expect(() => call("nonsense", 1)).not.toThrow();
    await expect(call("nonsense", 1)).resolves.toEqual(["https://a.example"]);
  });

  it("makes no wire call: origins() settles with no shell present", async () => {
    // `createNetwork` is the same namespace without a `FrameContext`; if the
    // method needed the shell this would hang rather than resolve.
    await expect(createNetwork({ origins: ["https://a.example"] }).origins()).resolves.toEqual([
      "https://a.example",
    ]);
  });
});
