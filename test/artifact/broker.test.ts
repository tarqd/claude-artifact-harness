import { describe, expect, it, vi } from "vitest";
import { dispatch, readCapCall } from "../../src/shell/broker.ts";
import type { BrokerContext, ShellBoot } from "../../src/shell/types.ts";

function boot(capabilities: Record<string, { config?: unknown }>): ShellBoot {
  return {
    artifactId: "0123456789abcdef0123456789abcdef",
    version: "v3",
    title: "T",
    frameOrigin: "http://frame.test",
    frameUrl: "http://frame.test/_f/v3/",
    contract: "0.2.32",
    changes: [],
    flags: ["artifact_files"],
    capabilities,
    viewer: { id: "u_00000000000000000000AA", level: "owner", canEdit: true, isOwner: true },
    versionPollMs: 5000,
  };
}

function context(overrides: Partial<BrokerContext> = {}): BrokerContext {
  const base: BrokerContext = {
    boot: boot({ artifact: { config: {} } }),
    version: "v3",
    viewer: boot({}).viewer,
    flags: new Set(["artifact_files"]),
    toFrame: vi.fn(),
    ack: vi.fn(),
    progress: vi.fn(),
    reloadView: vi.fn(),
    setVersion: vi.fn(),
    consent: vi.fn(async () => true),
    api: vi.fn(async () => ({ version: "v4" })) as BrokerContext["api"],
    ...overrides,
  };
  return base;
}

describe("capability envelope validation", () => {
  it("accepts a well-formed call and refuses anything else", () => {
    expect(
      readCapCall({ __frame_cap: true, cap: "artifact", id: "s1", method: "publish", args: [] }),
    ).toEqual({ cap: "artifact", id: "s1", method: "publish", args: [] });
    expect(readCapCall({ __frame_cap: true, cap: "artifact", id: "s1", method: "publish" })).toBeNull();
    expect(readCapCall({ cap: "artifact", id: "s1", method: "publish", args: [] })).toBeNull();
    expect(readCapCall("hello")).toBeNull();
    expect(readCapCall(null)).toBeNull();
  });
});

describe("broker dispatch", () => {
  it("refuses an unknown capability with capability_disabled", async () => {
    const reply = await dispatch(
      { cap: "telepathy", id: "x1", method: "read", args: [] },
      context(),
    );
    expect(reply).toMatchObject({ id: "x1", error: { code: "capability_disabled" } });
  });

  it("refuses a capability this view was not granted", async () => {
    const reply = await dispatch({ cap: "db", id: "b1", method: "get", args: [] }, context());
    expect(reply.error?.code).toBe("capability_disabled");
  });

  it("dispatches a declared slice's call to that slice, not to a refusal", async () => {
    // Every roster slice now ships, so a declared capability reaches its own
    // broker: `db.get` is answered by `db` (here, an argument complaint),
    // never by the registry's `capability_disabled`.
    const ctx = context({ boot: boot({ artifact: { config: {} }, db: { config: {} } }) });
    const reply = await dispatch({ cap: "db", id: "b1", method: "get", args: [] }, ctx);
    expect(reply.error?.code).not.toBe("capability_disabled");
    expect(reply.error).toMatchObject({ code: "invalid_argument" });
  });

  it("serves `artifact` to a page that declared the legacy `self` spelling", async () => {
    const ctx = context({ boot: boot({ self: { config: {} } }) });
    const reply = await dispatch(
      { cap: "artifact", id: "s1", method: "publish", args: ["<!doctype html><html></html>"] },
      ctx,
    );
    expect(reply.result).toEqual({ version: "v4" });
  });

  it("serves `self` to a page that declared `artifact`", async () => {
    const reply = await dispatch(
      { cap: "self", id: "s1", method: "publish", args: ["<!doctype html><html></html>"] },
      context(),
    );
    expect(reply.result).toEqual({ version: "v4" });
  });

  it("refuses an unknown method on a live slice", async () => {
    const reply = await dispatch({ cap: "artifact", id: "s1", method: "edit", args: [[]] }, context());
    expect(reply.error?.code).toBe("capability_disabled");
  });

  it("publishes html, records the version and reloads the view", async () => {
    vi.useFakeTimers();
    const ctx = context();
    const reply = await dispatch(
      { cap: "artifact", id: "s1", method: "publish", args: ["<!doctype html><html></html>"] },
      ctx,
    );
    expect(reply.result).toEqual({ version: "v4" });
    expect(ctx.api).toHaveBeenCalledWith(
      "/api/frame/self/0123456789abcdef0123456789abcdef",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(
      (vi.mocked(ctx.api).mock.calls[0]![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body).toEqual({ baseVersion: "v3", html: "<!doctype html><html></html>" });
    expect(ctx.setVersion).toHaveBeenCalledWith("v4");
    // the reply is posted first; the reload lands on the next tick
    expect(ctx.reloadView).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(ctx.reloadView).toHaveBeenCalledWith("v4");
    vi.useRealTimers();
  });

  it("does not reload the publishing view after a files publish", async () => {
    const ctx = context();
    const reply = await dispatch(
      {
        cap: "artifact",
        id: "s2",
        method: "publish",
        args: [{ "data/doc.json": { content: "{}", contentType: "application/json" } }],
      },
      ctx,
    );
    expect(reply.result).toEqual({ version: "v4" });
    expect(ctx.reloadView).not.toHaveBeenCalled();
    const body = JSON.parse(
      (vi.mocked(ctx.api).mock.calls[0]![1] as { body: string }).body,
    ) as { files: Record<string, unknown> };
    expect(body.files["data/doc.json"]).toEqual({
      contentType: "application/json",
      encoding: "utf8",
      content: "{}",
    });
  });

  it("maps a read-only viewer to not_writer", async () => {
    const ctx = context({
      viewer: { id: "u_00000000000000000000AA", level: "view", canEdit: false, isOwner: false },
    });
    const reply = await dispatch(
      { cap: "artifact", id: "s3", method: "publish", args: ["<!doctype html>"] },
      ctx,
    );
    expect(reply.error?.code).toBe("not_writer");
  });

  it("passes a server conflict through verbatim", async () => {
    const ctx = context({
      api: vi.fn(async () => {
        throw { code: "conflict", message: "a newer version was published first", live: "v9" };
      }) as BrokerContext["api"],
    });
    const reply = await dispatch(
      { cap: "artifact", id: "s4", method: "publish", args: ["<!doctype html>"] },
      ctx,
    );
    expect(reply.error).toMatchObject({ code: "conflict", live: "v9" });
  });
});
