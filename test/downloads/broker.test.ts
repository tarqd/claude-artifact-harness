/**
 * The shell side of `downloads`: the filename the viewer actually confirms,
 * the two extension allowlists and the switch over the second one, the 16 MiB
 * cap, the rate limit (one undecided prompt at a time, five prompts a
 * minute), the prompt itself — ack first, final name and size in the copy —
 * and the browser download that only an accepted prompt reaches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../../src/shell/broker.ts";
import type { BrokerContext, ConsentRequest, ShellBoot } from "../../src/shell/types.ts";
import {
  ALLOWED_EXTENSIONS,
  domDelivery,
  EXTRA_EXTENSIONS,
  extensionOf,
  extraExtensionsEnabled,
  FLAG_EXTRA_OFF,
  FLAG_EXTRA_ON,
  formatSize,
  handle,
  MAX_BYTES,
  mimeFor,
  OBJECT_URL_TTL_MS,
  RATE_LIMIT,
  RATE_WINDOW_MS,
  readSaveArgs,
  resetForTest,
  resolveName,
  sanitizeFilename,
  setDeliveryForTest,
  type DeliveryHost,
  type DownloadJob,
} from "../../src/capabilities/downloads/broker.ts";

const ARTIFACT = "0123456789abcdef0123456789abcdef";

function boot(overrides: Partial<ShellBoot> = {}): ShellBoot {
  return {
    artifactId: ARTIFACT,
    version: "v1",
    title: "T",
    frameOrigin: "http://frame.test",
    frameUrl: "http://frame.test/_f/v1/",
    contract: "0.2.32",
    changes: [],
    flags: [],
    capabilities: { downloads: { config: {} } },
    viewer: { id: "u_00000000000000000000AA", level: "owner", canEdit: true, isOwner: true },
    versionPollMs: 0,
    ...overrides,
  };
}

interface Ctx extends BrokerContext {
  acks: string[];
  asked: ConsentRequest[];
  /** `ack` and `consent` in the order they happened. */
  trace: string[];
  saved: DownloadJob[];
}

function context(
  options: {
    answer?: (n: number) => boolean | Promise<boolean>;
    boot?: Partial<ShellBoot>;
    deliver?: (job: DownloadJob) => void;
  } = {},
): Ctx {
  const acks: string[] = [];
  const asked: ConsentRequest[] = [];
  const trace: string[] = [];
  const saved: DownloadJob[] = [];
  const answer = options.answer ?? (() => true);
  const record = boot(options.boot);

  setDeliveryForTest((job) => {
    if (options.deliver) options.deliver(job);
    saved.push(job);
  });

  const ctx: Ctx = {
    acks,
    asked,
    trace,
    saved,
    boot: record,
    version: record.version,
    viewer: record.viewer,
    flags: new Set(record.flags),
    toFrame: vi.fn(),
    ack: (id) => {
      acks.push(id);
      trace.push(`ack:${id}`);
    },
    progress: vi.fn(),
    reloadView: vi.fn(),
    setVersion: vi.fn(),
    consent: (request) => {
      asked.push(request);
      trace.push(`consent:${request.title}`);
      return Promise.resolve(answer(asked.length));
    },
    api: () => Promise.reject(new Error("downloads never calls a backend")),
  };
  return ctx;
}

function save(ctx: BrokerContext, filename: string, size = 8, id = "d1"): Promise<unknown> {
  return handle(
    { cap: "downloads", id, method: "save", args: [{ filename, bytes: new ArrayBuffer(size) }] },
    ctx,
  );
}

async function failure(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await promise;
    return { code: "resolved" };
  } catch (err) {
    return err as { code?: string; message?: string };
  }
}

beforeEach(() => resetForTest());
afterEach(() => resetForTest());

/* ------------------------------- the filename ----------------------------- */

describe("the final filename", () => {
  it.each([
    ["report.csv", "report.csv"],
    ["../../etc/passwd.txt", "passwd.txt"],
    ["C:\\Users\\me\\notes.md", "notes.md"],
    ["Report Q3.CSV", "Report Q3.csv"],
    ["  spaced   out .png", "spaced out.png"],
    [".hidden.txt", "hidden.txt"],
    ['we"ird<name>.json', "weirdname.json"],
  ])("%s becomes %s", (input, expected) => {
    expect(resolveName(input, true).name).toBe(expected);
  });

  it("keeps the name inside what a file system will take", () => {
    const long = `${"a".repeat(500)}.png`;
    const resolved = resolveName(long, true);
    expect(resolved.name.length).toBeLessThanOrEqual(200);
    expect(resolved.name.endsWith(".png")).toBe(true);
  });

  it("still produces a name when sanitizing leaves nothing but the extension", () => {
    // ". .png" keeps its extension but loses its stem: the file must not
    // become a dotfile named `.png`.
    expect(resolveName(". .png", true).name).toBe("download.png");
  });

  it("treats a name that is only an extension as no extension at all", async () => {
    expect((await failure(save(context(), "///.....png"))).code).toBe("rejected_extension");
  });

  it("strips control characters", () => {
    expect(sanitizeFilename("a\u0000b\u001fc\u007f.txt")).toBe("abc.txt");
  });

  it.each([
    ["report", "no extension at all"],
    [".csv", "an extension with no name"],
    ["report.", "a trailing dot"],
    ["report.c sv", "a space inside the extension"],
    ["archive.tar.gz2!", "punctuation in the extension"],
  ])("rejects %s (%s)", async (filename) => {
    expect(() => resolveName(filename, true)).toThrow();
    const error = await failure(save(context(), filename));
    expect(error.code).toBe("rejected_extension");
  });

  it("reads the extension case-insensitively", () => {
    expect(extensionOf("a.PNG")).toBe("png");
    expect(extensionOf("a")).toBeNull();
    expect(extensionOf(".png")).toBeNull();
  });
});

/* ------------------------------ the allowlists ---------------------------- */

describe("the extension allowlists", () => {
  it("accepts every extension on the always-on list", async () => {
    for (const extension of ALLOWED_EXTENSIONS) {
      resetForTest();
      await expect(save(context(), `file.${extension}`)).resolves.toEqual({ status: "saved" });
    }
    expect(ALLOWED_EXTENSIONS).toEqual([
      "gif",
      "png",
      "jpg",
      "jpeg",
      "webp",
      "mp4",
      "webm",
      "txt",
      "json",
      "md",
    ]);
  });

  it("accepts the second list while it is switched on (the default)", async () => {
    for (const extension of EXTRA_EXTENSIONS) {
      resetForTest();
      await expect(save(context(), `file.${extension}`)).resolves.toEqual({ status: "saved" });
    }
    expect(EXTRA_EXTENSIONS).toEqual([
      "docx",
      "pptx",
      "epub",
      "csv",
      "ttf",
      "html",
      "svg",
      "pdf",
    ]);
  });

  it("answers `extension_not_enabled` for the second list once it is off", async () => {
    const ctx = context({ boot: { flags: [FLAG_EXTRA_OFF] } });
    const error = await failure(save(ctx, "table.csv"));
    expect(error).toEqual({
      code: "extension_not_enabled",
      message: '".csv" downloads are switched off in this view',
    });
    // The always-on list is unaffected.
    await expect(save(ctx, "table.txt")).resolves.toEqual({ status: "saved" });
  });

  it("answers `rejected_extension` for anything on neither list", async () => {
    const error = await failure(save(context(), "installer.exe"));
    expect(error).toEqual({
      code: "rejected_extension",
      message: '".exe" is not an allowed file extension',
    });
  });

  it("never asks the viewer about a name it is going to refuse", async () => {
    const ctx = context();
    await failure(save(ctx, "installer.exe"));
    expect(ctx.asked).toEqual([]);
    expect(ctx.acks).toEqual([]);
  });
});

describe("the switch over the second list", () => {
  const withFlags = (flags: string[], config?: unknown): BrokerContext =>
    context({ boot: { flags, capabilities: { downloads: { config } } } });

  it("is on by default", () => {
    expect(extraExtensionsEnabled(withFlags([]))).toBe(true);
  });

  it("follows the boot flag before anything else", () => {
    expect(extraExtensionsEnabled(withFlags([FLAG_EXTRA_OFF], { extraExtensions: true }))).toBe(
      false,
    );
    expect(extraExtensionsEnabled(withFlags([FLAG_EXTRA_ON], { extraExtensions: false }))).toBe(
      true,
    );
  });

  it("lets an artifact narrow its own view when the platform is silent", () => {
    expect(extraExtensionsEnabled(withFlags([], { extraExtensions: false }))).toBe(false);
    expect(extraExtensionsEnabled(withFlags([], { extraExtensions: "no" }))).toBe(true);
    expect(extraExtensionsEnabled(withFlags([], undefined))).toBe(true);
  });
});

/* --------------------------------- the cap -------------------------------- */

describe("the 16 MiB cap", () => {
  it("takes exactly 16 MiB", async () => {
    await expect(save(context(), "big.png", MAX_BYTES)).resolves.toEqual({ status: "saved" });
    expect(MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  it("refuses one byte more, without asking the viewer", async () => {
    const ctx = context();
    const error = await failure(save(ctx, "big.png", MAX_BYTES + 1));
    expect(error).toEqual({ code: "too_large", message: "a download may be at most 16 MiB" });
    expect(ctx.asked).toEqual([]);
  });
});

/* ------------------------------ the rate limit ---------------------------- */

describe("the rate limit", () => {
  it("allows five prompts a minute and refuses the sixth", async () => {
    vi.useFakeTimers();
    try {
      const ctx = context();
      for (let n = 0; n < RATE_LIMIT; n++) {
        await expect(save(ctx, `f${n}.png`)).resolves.toEqual({ status: "saved" });
      }
      const error = await failure(save(ctx, "sixth.png"));
      expect(error).toEqual({ code: "rate_limited", message: "at most 5 downloads a minute" });
      expect(ctx.asked).toHaveLength(RATE_LIMIT);

      // The window slides: a minute later the page may ask again.
      vi.advanceTimersByTime(RATE_WINDOW_MS + 1);
      await expect(save(ctx, "later.png")).resolves.toEqual({ status: "saved" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a declined prompt: saying no is still a prompt", async () => {
    const ctx = context({ answer: () => false });
    for (let n = 0; n < RATE_LIMIT; n++) {
      expect((await failure(save(ctx, `f${n}.png`))).code).toBe("declined");
    }
    expect((await failure(save(ctx, "sixth.png"))).code).toBe("rate_limited");
  });

  it("counts per artifact", async () => {
    const one = context();
    const two = context({ boot: { artifactId: "ffffffffffffffffffffffffffffffff" } });
    for (let n = 0; n < RATE_LIMIT; n++) await save(one, `f${n}.png`);
    expect((await failure(save(one, "x.png"))).code).toBe("rate_limited");
    await expect(save(two, "x.png")).resolves.toEqual({ status: "saved" });
  });

  it("holds one undecided prompt at a time: the second save is refused, not queued", async () => {
    let release: (v: boolean) => void = () => undefined;
    const ctx = context();
    ctx.consent = (request: ConsentRequest) => {
      ctx.asked.push(request);
      return new Promise<boolean>((resolve) => {
        release = resolve;
      });
    };

    const first = save(ctx, "first.png", 8, "d1");
    await Promise.resolve();
    const second = await failure(save(ctx, "second.png", 8, "d2"));
    expect(second).toEqual({ code: "rate_limited", message: "a save prompt is already open" });
    expect(ctx.asked).toHaveLength(1);

    release(true);
    await expect(first).resolves.toEqual({ status: "saved" });

    // Once it is answered, the next save opens its own prompt.
    ctx.consent = () => Promise.resolve(true);
    await expect(save(ctx, "third.png", 8, "d3")).resolves.toEqual({ status: "saved" });
  });

  it("frees the prompt slot even when the dialog itself fails", async () => {
    const ctx = context();
    ctx.consent = () => Promise.reject(new Error("dialog blew up"));
    await failure(save(ctx, "first.png"));
    ctx.consent = () => Promise.resolve(true);
    await expect(save(ctx, "second.png")).resolves.toEqual({ status: "saved" });
  });
});

/* -------------------------------- the prompt ------------------------------ */

describe("the viewer's prompt", () => {
  it("acks the call before the dialog goes up", async () => {
    const ctx = context();
    await save(ctx, "report.csv", 2048, "d7");
    expect(ctx.acks).toEqual(["d7"]);
    expect(ctx.trace).toEqual(["ack:d7", "consent:Save this file?"]);
  });

  it("shows the final filename and the size", async () => {
    const ctx = context();
    await save(ctx, "../../etc/Report Q3.CSV", 2048);
    expect(ctx.asked[0]).toEqual({
      title: "Save this file?",
      body: 'This page wants to save "Report Q3.csv" (2.0 KB) to your device.',
      confirmLabel: "Save",
      cancelLabel: "Cancel",
    });
  });

  it("rejects `declined` when the viewer says no, and saves nothing", async () => {
    const ctx = context({ answer: () => false });
    const error = await failure(save(ctx, "report.csv"));
    expect(error).toEqual({ code: "declined", message: "the viewer declined the download" });
    expect(ctx.saved).toEqual([]);
  });
});

describe("formatSize", () => {
  it.each([
    [1, "1 byte"],
    [512, "512 bytes"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [1024 * 1024, "1.0 MB"],
    [MAX_BYTES, "16.0 MB"],
  ])("%d reads as %s", (bytes, text) => {
    expect(formatSize(bytes)).toBe(text);
  });
});

/* ------------------------------- the download ----------------------------- */

describe("the download itself", () => {
  it("hands the browser the final name, the extension's MIME type and the bytes", async () => {
    const ctx = context();
    const bytes = new TextEncoder().encode("a,b\n1,2").buffer as ArrayBuffer;
    await expect(
      handle({ cap: "downloads", id: "d1", method: "save", args: [{ filename: "x/y.csv", bytes }] }, ctx),
    ).resolves.toEqual({ status: "saved" });
    expect(ctx.saved).toHaveLength(1);
    expect(ctx.saved[0]!.filename).toBe("y.csv");
    expect(ctx.saved[0]!.contentType).toBe("text/csv");
    expect(new TextDecoder().decode(new Uint8Array(ctx.saved[0]!.bytes))).toBe("a,b\n1,2");
  });

  it("types the file from the extension, never from the page", () => {
    expect(mimeFor("png")).toBe("image/png");
    expect(mimeFor("jpg")).toBe("image/jpeg");
    expect(mimeFor("md")).toBe("text/markdown");
    expect(mimeFor("svg")).toBe("image/svg+xml");
    expect(mimeFor("nonsense")).toBe("application/octet-stream");
  });

  it("becomes `unavailable` when this view has no way to save", async () => {
    const ctx = context({
      deliver: () => {
        throw new Error("no save surface here");
      },
    });
    const error = await failure(save(ctx, "report.csv"));
    expect(error).toEqual({ code: "unavailable", message: "no save surface here" });
  });
});

describe("domDelivery", () => {
  interface FakeAnchor {
    href: string;
    download: string;
    rel: string;
    style: { display: string };
    clicked: number;
    removed: number;
    click(): void;
    remove(): void;
  }

  function fakeHost(): { host: DeliveryHost; anchors: FakeAnchor[]; appended: FakeAnchor[]; revoked: string[]; timers: Array<() => void> } {
    const anchors: FakeAnchor[] = [];
    const appended: FakeAnchor[] = [];
    const revoked: string[] = [];
    const timers: Array<() => void> = [];
    const host = {
      document: {
        createElement: () => {
          const anchor: FakeAnchor = {
            href: "",
            download: "",
            rel: "",
            style: { display: "" },
            clicked: 0,
            removed: 0,
            click() {
              anchor.clicked++;
            },
            remove() {
              anchor.removed++;
            },
          };
          anchors.push(anchor);
          return anchor;
        },
        body: { append: (node: FakeAnchor) => void appended.push(node) },
      },
      createObjectURL: () => "blob:fake-url",
      revokeObjectURL: (url: string) => void revoked.push(url),
      setTimeout: (fn: () => void, ms: number) => {
        expect(ms).toBe(OBJECT_URL_TTL_MS);
        timers.push(fn);
        return 0;
      },
    };
    return { host: host as unknown as DeliveryHost, anchors, appended, revoked, timers };
  }

  it("clicks a hidden anchor and cleans it up", () => {
    const { host, anchors, appended, revoked, timers } = fakeHost();
    domDelivery(host)({
      filename: "report.csv",
      bytes: new ArrayBuffer(4),
      contentType: "text/csv",
    });
    expect(anchors).toHaveLength(1);
    const anchor = anchors[0]!;
    expect(anchor.href).toBe("blob:fake-url");
    expect(anchor.download).toBe("report.csv");
    expect(anchor.rel).toBe("noopener");
    expect(anchor.style.display).toBe("none");
    expect(appended).toEqual([anchor]);
    expect(anchor.clicked).toBe(1);
    expect(anchor.removed).toBe(1);

    // The object URL outlives the click, then goes.
    expect(revoked).toEqual([]);
    timers[0]!();
    expect(revoked).toEqual(["blob:fake-url"]);
  });

  it("cleans up even when the click throws", () => {
    const { host, anchors, timers } = fakeHost();
    const deliver = domDelivery(host);
    const original = host.document.createElement;
    host.document.createElement = ((tag: string) => {
      const anchor = original.call(host.document, tag as "a") as unknown as FakeAnchor;
      anchor.click = () => {
        throw new Error("blocked");
      };
      return anchor;
    }) as typeof host.document.createElement;

    expect(() =>
      deliver({ filename: "a.png", bytes: new ArrayBuffer(1), contentType: "image/png" }),
    ).toThrow("blocked");
    expect(anchors[0]!.removed).toBe(1);
    expect(timers).toHaveLength(1);
  });
});

/* ------------------------------- the envelope ----------------------------- */

describe("the wire argument, re-validated shell-side", () => {
  it.each([
    ["not an object", "x"],
    ["no filename", { bytes: new ArrayBuffer(2) }],
    ["a numeric filename", { filename: 3, bytes: new ArrayBuffer(2) }],
    ["a 513-character filename", { filename: `${"a".repeat(509)}.txt`, bytes: new ArrayBuffer(2) }],
    ["no bytes", { filename: "a.txt" }],
    ["an empty buffer", { filename: "a.txt", bytes: new ArrayBuffer(0) }],
    ["bytes that are not bytes", { filename: "a.txt", bytes: "hello" }],
  ])("refuses %s with bad_request", async (_label, arg) => {
    expect(() => readSaveArgs(arg)).toThrowError();
    const error = await failure(
      handle({ cap: "downloads", id: "d1", method: "save", args: [arg] }, context()),
    );
    expect(error.code).toBe("bad_request");
  });

  it("accepts a view, for a frame that sent one", () => {
    const args = readSaveArgs({ filename: "a.txt", bytes: new Uint8Array([1, 2, 3]) });
    expect(args.bytes.byteLength).toBe(3);
  });

  it("refuses a method that is not save", async () => {
    const error = await failure(
      handle({ cap: "downloads", id: "d1", method: "list", args: [] }, context()),
    );
    expect(error).toEqual({
      code: "capability_disabled",
      message: "downloads.list is not available in this view",
    });
  });

  it("is unreachable from a view that did not declare downloads", async () => {
    const ctx = context({ boot: { capabilities: { db: { config: {} } } } });
    const reply = await dispatch(
      {
        cap: "downloads",
        id: "d1",
        method: "save",
        args: [{ filename: "a.png", bytes: new ArrayBuffer(2) }],
      },
      ctx,
    );
    expect(reply.error?.code).toBe("capability_disabled");
    expect(ctx.asked).toEqual([]);
  });

  it("reaches the broker through dispatch when the view did declare it", async () => {
    const ctx = context();
    const reply = await dispatch(
      {
        cap: "downloads",
        id: "d9",
        method: "save",
        args: [{ filename: "a.png", bytes: new ArrayBuffer(2) }],
      },
      ctx,
    );
    expect(reply).toEqual({ __frame_cap_r: true, id: "d9", result: { status: "saved" } });
  });
});
