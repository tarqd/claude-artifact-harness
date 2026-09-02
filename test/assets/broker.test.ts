/**
 * The shell side of `assets`: which backend call each verb makes, the
 * admin-or-owner gate, and the promise that whatever the backend fails with,
 * the page only ever sees one of the four documented codes.
 */
import { describe, expect, it, vi } from "vitest";
import { handle, NOT_A_WRITER } from "../../src/capabilities/assets/broker.ts";
import type { BrokerCall, BrokerContext, ShellBoot } from "../../src/shell/types.ts";

const ARTIFACT = "0123456789abcdef0123456789abcdef";
const BLOB = "fedcba9876543210fedcba9876543210";

interface Api {
  calls: Array<{ path: string; init: RequestInit | undefined }>;
}

function context(
  overrides: { canEdit?: boolean; api?: (path: string, init?: RequestInit) => Promise<unknown> } = {},
): BrokerContext & Api {
  const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
  const boot = { artifactId: ARTIFACT, version: "v1" } as ShellBoot;
  const ctx = {
    calls,
    boot,
    version: "v1",
    viewer: {
      id: "u_aaaaaaaaaaaaaaaaaaaaaa",
      level: overrides.canEdit === false ? "interact" : "owner",
      canEdit: overrides.canEdit !== false,
      isOwner: overrides.canEdit !== false,
    },
    flags: new Set<string>(),
    toFrame: () => undefined,
    ack: () => undefined,
    progress: () => undefined,
    reloadView: () => undefined,
    setVersion: () => undefined,
    consent: () => Promise.resolve(true),
    api: async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      if (overrides.api) return (await overrides.api(path, init)) as T;
      return { ok: true } as T;
    },
  } as unknown as BrokerContext & Api;
  return ctx;
}

const call = (method: string, ...args: unknown[]): BrokerCall => ({
  cap: "assets",
  id: "e1",
  method,
  args,
});

const png = (): Blob => new Blob([new Uint8Array(8)], { type: "image/png" });

describe("upload", () => {
  it("POSTs the raw bytes with the validated type as Content-Type", async () => {
    const ctx = context();
    const blob = png();
    await handle(call("upload", blob, "image/png"), ctx);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]!.path).toBe(`/api/frame/blob/${ARTIFACT}/upload`);
    const init = ctx.calls[0]!.init!;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "image/png" });
    // Raw body, not base64 in JSON: a 20 MiB cap must stay 20 MiB on the wire.
    expect(init.body).toBe(blob);
  });

  it("falls back to the Blob's own type when the frame sent none", async () => {
    const ctx = context();
    await handle(call("upload", png()), ctx);
    expect(ctx.calls[0]!.init!.headers).toEqual({ "content-type": "image/png" });
  });

  it("checks the type and the size again, without trusting the frame", async () => {
    const ctx = context();
    await expect(handle(call("upload", png(), "application/x-msdownload"), ctx)).rejects.toMatchObject({
      code: "unsupported_type",
    });
    const big = new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: "image/svg+xml" });
    await expect(handle(call("upload", big), ctx)).rejects.toMatchObject({ code: "too_large" });
    await expect(handle(call("upload", "not a blob"), ctx)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(ctx.calls).toEqual([]);
  });

  it("refuses a viewer who may not write, before the backend is asked", async () => {
    const ctx = context({ canEdit: false });
    await expect(handle(call("upload", png()), ctx)).rejects.toEqual({
      code: "upstream_error",
      message: NOT_A_WRITER,
    });
    expect(ctx.calls).toEqual([]);
  });
});

describe("list", () => {
  it("POSTs an empty body, then the cursor", async () => {
    const ctx = context({ api: async () => ({ assets: [], usage: { count: 0, bytes: 0 } }) });
    await handle(call("list"), ctx);
    await handle(call("list", "cursor-1"), ctx);
    expect(ctx.calls.map((c) => c.path)).toEqual([
      `/api/frame/blob/${ARTIFACT}/list`,
      `/api/frame/blob/${ARTIFACT}/list`,
    ]);
    expect(ctx.calls.map((c) => c.init!.body)).toEqual(["{}", '{"after":"cursor-1"}']);
  });

  it("is readable by a viewer who may not write", async () => {
    const ctx = context({
      canEdit: false,
      api: async () => ({ assets: [], usage: { count: 0, bytes: 0 } }),
    });
    await expect(handle(call("list"), ctx)).resolves.toMatchObject({ assets: [] });
  });

  it("refuses a cursor that is not a string", async () => {
    const ctx = context();
    await expect(handle(call("list", 7), ctx)).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("delete", () => {
  it("addresses the asset by id, whichever form the frame sent", async () => {
    const ctx = context({ api: async () => ({ id: BLOB, deleted: true }) });
    await handle(call("delete", `/_blob/${BLOB}`), ctx);
    expect(ctx.calls[0]!.path).toBe(`/api/frame/blob/${ARTIFACT}/${BLOB}/delete`);
  });

  it("refuses a reference it cannot parse, and a viewer who may not write", async () => {
    const ctx = context();
    await expect(handle(call("delete", "../secret"), ctx)).rejects.toMatchObject({
      code: "invalid_request",
    });
    const reader = context({ canEdit: false });
    await expect(handle(call("delete", BLOB), reader)).rejects.toMatchObject({
      code: "upstream_error",
    });
    expect(reader.calls).toEqual([]);
  });
});

describe("what the page can be told", () => {
  it("passes a documented backend code through", async () => {
    const ctx = context({
      api: () => Promise.reject({ code: "too_large", message: "20 MiB" }),
    });
    await expect(handle(call("upload", png()), ctx)).rejects.toEqual({
      code: "too_large",
      message: "20 MiB",
    });
  });

  it("folds an undocumented code, and a thrown Error, into upstream_error", async () => {
    const undocumented = context({
      api: () => Promise.reject({ code: "not_declared", message: "no assets here" }),
    });
    await expect(handle(call("list"), undocumented)).rejects.toEqual({
      code: "upstream_error",
      message: "no assets here",
    });

    const broken = context({ api: () => Promise.reject(new TypeError("failed to fetch")) });
    await expect(handle(call("list"), broken)).rejects.toEqual({
      code: "upstream_error",
      message: "failed to fetch",
    });
  });

  it("calls an unknown verb capability_disabled", async () => {
    const ctx = context();
    const spy = vi.spyOn(ctx, "api");
    await expect(handle(call("rename", BLOB), ctx)).rejects.toMatchObject({
      code: "capability_disabled",
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
