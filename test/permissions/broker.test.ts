/**
 * The shell side of `permissions`: what each declaration reads as, the prompt
 * that `request()` puts up (ack first, one dialog per key, the answer stored
 * under the key `sample` reads), and the refusals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../../src/shell/broker.ts";
import type { BrokerContext, ShellBoot } from "../../src/shell/types.ts";
import { handle, resetForTest, stateMap, stateOf } from "../../src/capabilities/permissions/broker.ts";
import { consentKey } from "../../src/capabilities/permissions/protocol.ts";
import { serverConsentKey } from "../../src/capabilities/mcp/protocol.ts";

const ARTIFACT = "0123456789abcdef0123456789abcdef";

/* ------------------------------ fake storage ------------------------------ */

function installStorage(seed: Record<string, string> = {}): Map<string, string> {
  const data = new Map(Object.entries(seed));
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, String(value)),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage as unknown as Storage,
    configurable: true,
    writable: true,
  });
  return data;
}

function removeStorage(): void {
  Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, "localStorage");
}

/* -------------------------------- fixtures -------------------------------- */

function boot(capabilities: Record<string, { config?: unknown }>): ShellBoot {
  return {
    artifactId: ARTIFACT,
    version: "v1",
    title: "T",
    frameOrigin: "http://frame.test",
    frameUrl: "http://frame.test/_f/v1/",
    contract: "0.2.32",
    changes: [],
    flags: [],
    capabilities,
    viewer: { id: "u_00000000000000000000AA", level: "owner", canEdit: true, isOwner: true },
    versionPollMs: 5000,
  };
}

interface Ctx extends BrokerContext {
  acks: string[];
  asked: Array<{ title: string; ackedFirst: boolean }>;
}

function context(
  capabilities: Record<string, { config?: unknown }> = {
    permissions: { config: {} },
    sample: { config: {} },
    downloads: { config: {} },
  },
  answer: (n: number) => boolean | Promise<boolean> = () => true,
): Ctx {
  const acks: string[] = [];
  const asked: Array<{ title: string; ackedFirst: boolean }> = [];
  const ctx: Ctx = {
    acks,
    asked,
    boot: boot(capabilities),
    version: "v1",
    viewer: boot({}).viewer,
    flags: new Set(),
    toFrame: vi.fn(),
    ack: (id: string) => void acks.push(id),
    progress: vi.fn(),
    reloadView: vi.fn(),
    setVersion: vi.fn(),
    consent: async (request) => {
      asked.push({ title: request.title, ackedFirst: acks.length > 0 });
      return answer(asked.length);
    },
    api: vi.fn() as BrokerContext["api"],
  };
  return ctx;
}

beforeEach(() => {
  resetForTest();
  installStorage();
});
afterEach(() => {
  resetForTest();
  removeStorage();
});

/* ---------------------------------- state --------------------------------- */

describe("state", () => {
  it("reads a consent capability as prompt until the viewer answers", async () => {
    const ctx = context();
    expect(stateOf("sample", ctx)).toBe("prompt");
    installStorage({ [consentKey(ARTIFACT, "sample")]: "granted" });
    expect(stateOf("sample", ctx)).toBe("granted");
    installStorage({ [consentKey(ARTIFACT, "sample")]: "denied" });
    expect(stateOf("sample", ctx)).toBe("denied");
    // Junk in storage is not a decision.
    installStorage({ [consentKey(ARTIFACT, "sample")]: "maybe" });
    expect(stateOf("sample", ctx)).toBe("prompt");
  });

  it("grants everything else this view declared", () => {
    const ctx = context();
    expect(stateOf("downloads", ctx)).toBe("granted");
    expect(stateOf("permissions", ctx)).toBe("granted");
  });

  it("answers unavailable for anything this view did not declare", () => {
    const ctx = context();
    expect(stateOf("db", ctx)).toBe("unavailable");
    expect(stateOf("nonesuch", ctx)).toBe("unavailable");
    // Scoped names name `mcp`, which this view did not declare.
    expect(stateOf("mcp:Google Calendar", ctx)).toBe("unavailable");
    expect(stateOf("mcp:host:filesystem", ctx)).toBe("unavailable");
    expect(stateOf("mcp", ctx)).toBe("unavailable");
    // Only `mcp` has scopes: a scope on anything else names nothing.
    expect(stateOf("sample:whatever", ctx)).toBe("unavailable");
  });

  it("answers for both spellings of artifact/self", () => {
    // The server rewrites a declared `self` to `artifact` before the boot
    // record reaches the shell (src/server/boot.ts), so only the page-side
    // spelling varies — and both spellings answer for the one capability.
    const ctx = context({ permissions: { config: {} }, artifact: { config: {} } });
    expect(stateOf("self", ctx)).toBe("granted");
    expect(stateOf("artifact", ctx)).toBe("granted");
    // ...and the map lists it once, under its canonical name.
    expect(stateMap(ctx)).toEqual({ artifact: "granted" });
  });

  it("lists every declared capability but permissions itself", async () => {
    const ctx = context();
    expect(await handle({ cap: "permissions", id: "p1", method: "state", args: [] }, ctx)).toEqual({
      sample: "prompt",
      downloads: "granted",
    });
    // A view that declared nothing else has an empty map.
    expect(stateMap(context({ permissions: { config: {} } }))).toEqual({});
  });

  it("never prompts", async () => {
    const ctx = context();
    await handle({ cap: "permissions", id: "p1", method: "state", args: [] }, ctx);
    await handle({ cap: "permissions", id: "p2", method: "state", args: ["sample"] }, ctx);
    expect(ctx.asked).toEqual([]);
    expect(ctx.acks).toEqual([]);
  });

  it("reads prompt when the browser has no storage at all", async () => {
    removeStorage();
    expect(stateOf("sample", context())).toBe("prompt");
  });
});

/* --------------------------------- request -------------------------------- */

describe("request", () => {
  it("acks, prompts once, and stores the answer where sample reads it", async () => {
    const ctx = context();
    const result = await handle(
      { cap: "permissions", id: "p7", method: "request", args: [["sample"]] },
      ctx,
    );
    expect(result).toEqual({ sample: "granted" });
    expect(ctx.acks).toEqual(["p7"]);
    expect(ctx.asked).toEqual([{ title: "Let this artifact ask Claude?", ackedFirst: true }]);
    expect(globalThis.localStorage.getItem(consentKey(ARTIFACT, "sample"))).toBe("granted");
    expect(stateOf("sample", ctx)).toBe("granted");
  });

  it("records a refusal and never asks again", async () => {
    const ctx = context(undefined, () => false);
    expect(
      await handle({ cap: "permissions", id: "p1", method: "request", args: [["sample"]] }, ctx),
    ).toEqual({ sample: "denied" });
    expect(
      await handle({ cap: "permissions", id: "p2", method: "request", args: [["sample"]] }, ctx),
    ).toEqual({ sample: "denied" });
    expect(ctx.asked).toHaveLength(1);
    expect(ctx.acks).toEqual(["p1"]);
  });

  it("decides a granted or unavailable name without a dialog", async () => {
    const ctx = context();
    expect(
      await handle(
        { cap: "permissions", id: "p1", method: "request", args: [["downloads", "db"]] },
        ctx,
      ),
    ).toEqual({ downloads: "granted", db: "unavailable" });
    expect(ctx.asked).toEqual([]);
    expect(ctx.acks).toEqual([]);
  });

  it("with no names, asks about everything this view could decide", async () => {
    const ctx = context();
    expect(
      await handle({ cap: "permissions", id: "p1", method: "request", args: [] }, ctx),
    ).toEqual({ sample: "granted", downloads: "granted" });
    expect(ctx.asked).toHaveLength(1);
  });

  it("shows one dialog when two calls ask at once", async () => {
    const ctx = context();
    const [a, b] = await Promise.all([
      handle({ cap: "permissions", id: "p1", method: "request", args: [["sample"]] }, ctx),
      handle({ cap: "permissions", id: "p2", method: "request", args: [["sample"]] }, ctx),
    ]);
    expect(a).toEqual({ sample: "granted" });
    expect(b).toEqual({ sample: "granted" });
    expect(ctx.asked).toHaveLength(1);
    // Both calls told their frame to wait.
    expect(ctx.acks).toEqual(["p1", "p2"]);
  });

  it("answers only for the names asked, in the order asked", async () => {
    const ctx = context();
    const result = (await handle(
      { cap: "permissions", id: "p1", method: "request", args: [["downloads", "sample"]] },
      ctx,
    )) as Record<string, string>;
    expect(Object.keys(result)).toEqual(["downloads", "sample"]);
  });
});

/* --------------------- storage the browser refuses ------------------------ */

describe("when the browser cannot persist", () => {
  function breakWrites(): void {
    const real = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        ...real,
        getItem: (key: string) => real.getItem(key),
        setItem: () => {
          throw new Error("SecurityError");
        },
      } as unknown as Storage,
      configurable: true,
      writable: true,
    });
  }

  it("remembers the answer for this view instead of asking again", async () => {
    installStorage();
    breakWrites();
    const ctx = context(undefined, () => false);
    expect(
      await handle({ cap: "permissions", id: "p1", method: "request", args: [["sample"]] }, ctx),
    ).toEqual({ sample: "denied" });
    expect(
      await handle({ cap: "permissions", id: "p2", method: "request", args: [["sample"]] }, ctx),
    ).toEqual({ sample: "denied" });
    expect(ctx.asked).toHaveLength(1);
    expect(stateOf("sample", ctx)).toBe("denied");
  });

  it("caps the dialogs a page can put up in a minute", async () => {
    // Nothing is ever recorded when the dialog itself fails, so without a cap
    // a page could loop `request()` into an unbounded stream of modals.
    const ctx = context();
    ctx.consent = async (request) => {
      ctx.asked.push({ title: request.title, ackedFirst: ctx.acks.length > 0 });
      throw new Error("dialog torn down");
    };
    const outcomes: string[] = [];
    for (let i = 0; i < 8; i++) {
      outcomes.push(
        await handle(
          { cap: "permissions", id: `p${i}`, method: "request", args: [["sample"]] },
          ctx,
        ).then((r) => JSON.stringify(r), () => "rejected"),
      );
    }
    expect(ctx.asked).toHaveLength(5);
    // Past the cap the page is answered without the viewer being disturbed.
    expect(outcomes.slice(5)).toEqual(new Array(3).fill('{"sample":"denied"}'));
  });
});

/* ------------------------ a decision made elsewhere ----------------------- */

describe("a decision another surface recorded", () => {
  it("is honoured rather than overwritten by a late answer", async () => {
    const ctx = context(undefined, () => false);
    const key = consentKey(ARTIFACT, "sample");
    const pending = handle(
      { cap: "permissions", id: "p1", method: "request", args: [["sample"]] },
      ctx,
    );
    // The `sample` slice's own first-call dialog is answered "Allow" while
    // this one is still open, and writes the shared key.
    globalThis.localStorage.setItem(key, "granted");
    expect(await pending).toEqual({ sample: "granted" });
    expect(globalThis.localStorage.getItem(key)).toBe("granted");
  });
});

/* -------------------------------- refusals -------------------------------- */

describe("refusals", () => {
  it("refuses a method it does not serve", async () => {
    await expect(
      handle({ cap: "permissions", id: "p1", method: "revoke", args: [] }, context()),
    ).rejects.toEqual({
      code: "capability_disabled",
      message: "permissions.revoke is not available in this view",
    });
  });

  it("re-validates what the frame sent", async () => {
    const ctx = context();
    await expect(
      handle({ cap: "permissions", id: "p1", method: "state", args: ["x".repeat(513)] }, ctx),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      handle(
        { cap: "permissions", id: "p2", method: "request", args: [new Array(33).fill("db")] },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "bad_request", message: "request takes at most 32 names" });
    await expect(
      handle({ cap: "permissions", id: "p3", method: "request", args: ["sample"] }, ctx),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});

/* ------------------------------ through dispatch --------------------------- */

describe("through the shell dispatcher", () => {
  it("serves a view that declared permissions", async () => {
    const reply = await dispatch(
      { cap: "permissions", id: "p1", method: "state", args: [] },
      context(),
    );
    expect(reply).toEqual({
      __frame_cap_r: true,
      id: "p1",
      result: { sample: "prompt", downloads: "granted" },
    });
  });

  it("refuses a view that never declared permissions", async () => {
    const reply = await dispatch(
      { cap: "permissions", id: "p1", method: "state", args: [] },
      context({ sample: { config: {} } }),
    );
    expect(reply.error).toMatchObject({ code: "capability_disabled" });
  });

  it("turns a validation failure into one reply, never a throw", async () => {
    const reply = await dispatch(
      { cap: "permissions", id: "p1", method: "state", args: [42] },
      context(),
    );
    expect(reply.error).toEqual({
      code: "bad_request",
      message: "a capability name must be a string",
    });
  });
});

/* ----------------------------------- mcp ---------------------------------- */

describe("mcp scoped names", () => {
  const MANIFEST = {
    servers: [
      { server: "Fake Tools", tools: ["echo", "write"] },
      { server: "host:filesystem", tools: ["read_file"] },
    ],
  };
  const DECLARED = { permissions: { config: {} }, sample: { config: {} }, mcp: { config: MANIFEST } };
  const KEY = serverConsentKey(ARTIFACT, "Fake Tools");
  const HOST_KEY = serverConsentKey(ARTIFACT, "host:filesystem");
  const request = (id: string, args: unknown[]) => ({ cap: "permissions", id, method: "request", args });

  it("reads a declared server as prompt until decided, and an undeclared one as unavailable", () => {
    const ctx = context(DECLARED);
    expect(stateOf("mcp:Fake Tools", ctx)).toBe("prompt");
    expect(stateOf("mcp:host:filesystem", ctx)).toBe("prompt");
    expect(stateOf("mcp:Google Calendar", ctx)).toBe("unavailable");
    installStorage({ [KEY]: "granted" });
    expect(stateOf("mcp:Fake Tools", ctx)).toBe("granted");
    installStorage({ [KEY]: "denied" });
    expect(stateOf("mcp:Fake Tools", ctx)).toBe("denied");
  });

  it("aggregates the bare name over the manifest", () => {
    const ctx = context(DECLARED);
    expect(stateOf("mcp", ctx)).toBe("prompt");
    installStorage({ [KEY]: "granted" });
    expect(stateOf("mcp", ctx)).toBe("prompt");
    installStorage({ [KEY]: "granted", [HOST_KEY]: "denied" });
    expect(stateOf("mcp", ctx)).toBe("denied");
    installStorage({ [KEY]: "granted", [HOST_KEY]: "granted" });
    expect(stateOf("mcp", ctx)).toBe("granted");
    // An empty manifest has nothing to decide.
    const empty = context({ permissions: { config: {} }, mcp: { config: { servers: [] } } });
    expect(stateOf("mcp", empty)).toBe("granted");
    expect(stateOf("mcp:Fake Tools", empty)).toBe("unavailable");
  });

  it("lists the aggregate and every server in the map", () => {
    installStorage({ [KEY]: "granted" });
    expect(stateMap(context(DECLARED))).toEqual({
      sample: "prompt",
      mcp: "prompt",
      "mcp:Fake Tools": "granted",
      "mcp:host:filesystem": "prompt",
    });
  });

  it("request asks per server with the mcp slice's copy, and the bare name asks for all", async () => {
    const data = installStorage();
    const ctx = context(DECLARED);
    expect(await handle(request("p1", [["mcp:Fake Tools"]]), ctx)).toEqual({ "mcp:Fake Tools": "granted" });
    expect(ctx.asked).toEqual([{ title: "Let this artifact use Fake Tools?", ackedFirst: true }]);
    expect(data.get(KEY)).toBe("granted");

    expect(await handle(request("p2", [["mcp"]]), ctx)).toEqual({ mcp: "granted" });
    expect(ctx.asked.map((a) => a.title)).toEqual([
      "Let this artifact use Fake Tools?",
      "Let this artifact use host:filesystem?",
    ]);
    expect(data.get(HOST_KEY)).toBe("granted");
  });

  it("a denied server makes the aggregate denied without re-asking", async () => {
    const ctx = context(DECLARED, (n) => n === 3);
    expect(await handle(request("p1", []), ctx)).toEqual({
      sample: "denied",
      mcp: "denied",
      "mcp:Fake Tools": "denied",
      "mcp:host:filesystem": "granted",
    });
    expect(ctx.asked.map((a) => a.title)).toEqual([
      "Let this artifact ask Claude?",
      "Let this artifact use Fake Tools?",
      "Let this artifact use host:filesystem?",
    ]);
    expect(await handle(request("p2", [["mcp"]]), ctx)).toEqual({ mcp: "denied" });
    expect(ctx.asked).toHaveLength(3);
  });
});
