/**
 * The broker: which backend path each verb hits, what it refuses to pass on,
 * and the fact that the artifact it asks about is always the one this view
 * is showing — never one the frame named.
 */
import { describe, expect, it } from "vitest";
import { handle } from "../../src/capabilities/user/broker.ts";
import type { BrokerCall, BrokerContext, ShellBoot } from "../../src/shell/types.ts";

const ARTIFACT = "0123456789abcdef0123456789abcdef";
/** Stands in for the signed asset token the shell page put in the boot record. */
const TOKEN = "nonce.u_ownerownerownerownerab.0123456789abcdef0123456789abcdef.999.sig";
const OWNER = "u_ownerownerownerownerab";
const PEER = "u_peerpeerpeerpeerpeerpp";

interface Captured {
  path: string;
  init?: RequestInit;
}

function ctx(reply: unknown, options: { throws?: unknown } = {}): BrokerContext & {
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const boot = {
    artifactId: ARTIFACT,
    version: "v1",
    frameUrl: `http://frame.test/_f/v1/?__frame_t=${encodeURIComponent(TOKEN)}`,
    capabilities: { user: { config: { id: OWNER, owner: true, canEdit: true } } },
  } as unknown as ShellBoot;
  return {
    calls,
    boot,
    version: "v1",
    viewer: { id: OWNER, level: "owner", canEdit: true, isOwner: true },
    flags: new Set<string>(),
    toFrame: () => undefined,
    ack: () => undefined,
    progress: () => undefined,
    reloadView: () => undefined,
    setVersion: () => undefined,
    consent: () => Promise.resolve(false),
    api: async <T,>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      if (options.throws) throw options.throws;
      return reply as T;
    },
  } as BrokerContext & { calls: Captured[] };
}

const call = (method: string, args: unknown[] = []): BrokerCall => ({
  cap: "user",
  id: "u1",
  method,
  args,
});

function body(init: RequestInit | undefined): unknown {
  return JSON.parse(String(init?.body ?? "null"));
}

describe("profile", () => {
  it("reads the account, scoped to this view's artifact", async () => {
    const c = ctx({ account: { id: OWNER, name: "Ada", avatarUrl: null } });
    await expect(handle(call("profile"), c)).resolves.toEqual({
      id: OWNER,
      name: "Ada",
      avatarUrl: null,
      email: null,
    });
    expect(c.calls[0]!.path).toBe(`/api/account?slug=${ARTIFACT}`);
  });

  it("passes a missing account through as null, not as a broken row", async () => {
    const c = ctx({});
    await expect(handle(call("profile"), c)).resolves.toBeNull();
  });
});

describe("email", () => {
  it("posts to the per-artifact endpoint and normalises the answer", async () => {
    const c = ctx({ email: null });
    await expect(handle(call("email"), c)).resolves.toEqual({ email: null });
    expect(c.calls[0]!.path).toBe(`/api/frame/user/email/${ARTIFACT}`);
    expect(c.calls[0]!.init?.method).toBe("POST");
    expect(body(c.calls[0]!.init)).toEqual({});
  });

  it("carries a real address when the backend has one", async () => {
    const c = ctx({ email: "ada@example.test" });
    await expect(handle(call("email"), c)).resolves.toEqual({ email: "ada@example.test" });
  });
});

describe("profiles", () => {
  it("normalises the ids before they leave the shell", async () => {
    const c = ctx({ profiles: { [PEER]: { id: PEER, name: "Grace", avatarUrl: null } } });
    const result = await handle(call("profiles", [[PEER, PEER, 7, "", "x"]]), c);
    expect(body(c.calls[0]!.init)).toEqual({ ids: [PEER, "x"] });
    expect(result).toEqual({ [PEER]: { id: PEER, name: "Grace", avatarUrl: null, email: null } });
  });

  it("never asks the backend when there is nothing to resolve", async () => {
    const c = ctx({ profiles: {} });
    await expect(handle(call("profiles", [[]]), c)).resolves.toEqual({});
    await expect(handle(call("profiles", ["not-an-array"]), c)).resolves.toEqual({});
    expect(c.calls).toEqual([]);
  });

  it("drops rows the frame never asked about", async () => {
    const c = ctx({
      profiles: {
        [PEER]: { id: PEER, name: "Grace", avatarUrl: null },
        [OWNER]: { id: OWNER, name: "Ada", avatarUrl: null },
      },
    });
    const result = (await handle(call("profiles", [[PEER]]), c)) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual([PEER]);
  });
});

describe("search", () => {
  it("trims the query and reads back a list", async () => {
    const c = ctx({ profiles: [{ id: PEER, name: "Grace", avatarUrl: null }, { bad: true }] });
    const result = await handle(call("search", [`  ${"a".repeat(200)}  `]), c);
    expect((body(c.calls[0]!.init) as { q: string }).q).toHaveLength(100);
    expect(result).toEqual([{ id: PEER, name: "Grace", avatarUrl: null, email: null }]);
  });

  it("answers an empty query locally", async () => {
    const c = ctx({ profiles: [] });
    await expect(handle(call("search", ["   "]), c)).resolves.toEqual([]);
    await expect(handle(call("search", [null]), c)).resolves.toEqual([]);
    expect(c.calls).toEqual([]);
  });
});

describe("the boot token", () => {
  it("proves to the backend which artifact the shell rendered for this viewer", async () => {
    const c = ctx({ account: { id: OWNER, name: "Ada", avatarUrl: null } });
    await handle(call("profile"), c);
    await handle(call("search", ["ada"]), c);
    for (const captured of c.calls) {
      expect((captured.init?.headers as Record<string, string>)["x-artifact-frame-token"]).toBe(
        TOKEN,
      );
    }
  });

  it("sends no header at all when the boot record has no frame URL", async () => {
    const c = ctx({ profiles: [] });
    delete (c.boot as { frameUrl?: string }).frameUrl;
    await handle(call("search", ["ada"]), c);
    expect(c.calls[0]!.init?.headers).toEqual({ "content-type": "application/json" });
  });
});

describe("email is never carried by another verb", () => {
  it("strips an address the account endpoint should not have sent", async () => {
    const c = ctx({ account: { id: OWNER, name: "Ada", email: "ada@example.test" } });
    await expect(handle(call("profile"), c)).resolves.toMatchObject({ email: null });
  });

  it("strips it from directory rows too", async () => {
    const c = ctx({ profiles: [{ id: PEER, name: "Grace", email: "grace@example.test" }] });
    await expect(handle(call("search", ["gr"]), c)).resolves.toEqual([
      { id: PEER, name: "Grace", avatarUrl: null, email: null },
    ]);
  });
});

describe("refusals", () => {
  it("rejects an unknown verb with capability_disabled", async () => {
    await expect(handle(call("setName", ["Ada"]), ctx({}))).rejects.toMatchObject({
      code: "capability_disabled",
    });
  });

  it("lets a backend error travel to the frame unchanged", async () => {
    const c = ctx(null, { throws: { code: "not_granted", message: "no" } });
    await expect(handle(call("email"), c)).rejects.toEqual({ code: "not_granted", message: "no" });
  });
});
