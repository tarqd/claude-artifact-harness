/**
 * `downloads` broker: the shell side of `save`.
 *
 * Everything the page is not allowed to decide happens here, in this order
 * (surface-area.md §5.3, `reference/contract/0.2.32/downloads.d.ts`):
 *
 *  1. the filename is sanitized to a bare basename and its extension checked
 *     against the two documented allowlists — the always-on list, and the
 *     second list this deployment can switch off (`extension_not_enabled`);
 *  2. 16 MiB cap (`too_large`);
 *  3. one undecided prompt at a time, and at most five prompts a minute, per
 *     artifact (`rate_limited`);
 *  4. the viewer is asked, with the FINAL filename and the size, over an
 *     inert iframe so the page cannot clickjack the answer; "no" is
 *     `declined`;
 *  5. only then does the shell hand the bytes to the browser, as an object
 *     URL on a temporary anchor.
 *
 * There is no server route and no token: the bytes never leave the browser.
 */
import { capError, CAPABILITY_DISABLED } from "../../protocol/errors.ts";
import type { BrokerCall, BrokerContext } from "../../shell/types.ts";

export const CAP = "downloads";

/** The always-on list (downloads.d.ts, `rejected_extension`). */
export const ALLOWED_EXTENSIONS: readonly string[] = Object.freeze([
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

/** The second list, which a deployment may switch off (`extension_not_enabled`). */
export const EXTRA_EXTENSIONS: readonly string[] = Object.freeze([
  "docx",
  "pptx",
  "epub",
  "csv",
  "ttf",
  "html",
  "svg",
  "pdf",
]);

/** `too_large` — "over 16 MiB". */
export const MAX_BYTES = 16 * 1024 * 1024;

/** At most five prompts a minute, per artifact. */
export const RATE_LIMIT = 5;
export const RATE_WINDOW_MS = 60_000;

/** How long a final filename may be, once the extension is on it. */
export const MAX_FINAL_NAME = 200;

/** `bad_request` — "bad filename (non-string or >512 chars)". */
export const MAX_FILENAME_LENGTH = 512;

/**
 * Boot flags this broker honours. The platform's switch is the
 * `DOWNLOADS_EXTRA_EXTENSIONS` boot flag; the spine's flag list is not ours
 * to extend, so the broker reads either spelling if one ever appears and
 * otherwise falls back to the artifact's own declaration, then to "on".
 */
export const FLAG_EXTRA_ON = "downloads_extra_extensions";
export const FLAG_EXTRA_OFF = "no_downloads_extra_extensions";

/** MIME comes from the extension; a Blob's own type is ignored. */
const MIME: Readonly<Record<string, string>> = Object.freeze({
  gif: "image/gif",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  txt: "text/plain",
  json: "application/json",
  md: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  epub: "application/epub+zip",
  csv: "text/csv",
  ttf: "font/ttf",
  html: "text/html",
  svg: "image/svg+xml",
  pdf: "application/pdf",
});

export function mimeFor(extension: string): string {
  return MIME[extension] ?? "application/octet-stream";
}

/* ------------------------------- the filename ----------------------------- */

/**
 * Reduce whatever the page passed to a bare, boring basename. Directory
 * separators go first (a save is never a path), then control characters and
 * the characters no common file system accepts, then leading dots — a save is
 * not a way to write a hidden file, and `".csv"` is an extension with no name.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  return base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
}

/** The lower-cased extension of a sanitized name, or `null` if it has none. */
export function extensionOf(sanitized: string): string | null {
  const dot = sanitized.lastIndexOf(".");
  if (dot <= 0 || dot === sanitized.length - 1) return null;
  const extension = sanitized.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(extension) ? extension : null;
}

export interface ResolvedName {
  /** What the viewer is shown and the browser is told to write. */
  name: string;
  extension: string;
}

/**
 * The final name the viewer confirms — "sanitized and allowlist-checked; the
 * viewer confirms the FINAL name, which may differ".
 */
export function resolveName(filename: string, extraEnabled: boolean): ResolvedName {
  const sanitized = sanitizeFilename(filename);
  const extension = extensionOf(sanitized);
  if (!extension) {
    throw capError("rejected_extension", "filename needs an extension from the allowed list");
  }
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    if (!EXTRA_EXTENSIONS.includes(extension)) {
      throw capError("rejected_extension", `".${extension}" is not an allowed file extension`);
    }
    if (!extraEnabled) {
      throw capError(
        "extension_not_enabled",
        `".${extension}" downloads are switched off in this view`,
      );
    }
  }
  const stem = sanitized.slice(0, sanitized.lastIndexOf("."));
  const room = MAX_FINAL_NAME - extension.length - 1;
  // A stem that sanitizing reduced to nothing must not become a dotfile.
  const trimmed = stem
    .slice(0, Math.max(room, 0))
    .trim()
    .replace(/[. ]+$/, "");
  return { name: `${trimmed === "" ? "download" : trimmed}.${extension}`, extension };
}

/* --------------------------- the extra-list switch ------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Is the second extension list live in this view? The boot flag wins; an
 * artifact may narrow its own view with
 * `{"downloads": {"config": {"extraExtensions": false}}}`; the default is on.
 */
export function extraExtensionsEnabled(ctx: BrokerContext): boolean {
  if (ctx.flags.has(FLAG_EXTRA_OFF)) return false;
  if (ctx.flags.has(FLAG_EXTRA_ON)) return true;
  const config = ctx.boot.capabilities[CAP]?.config;
  if (isRecord(config) && typeof config.extraExtensions === "boolean") {
    return config.extraExtensions;
  }
  return true;
}

/* ------------------------------- the prompt ------------------------------- */

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? "" : "s"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface SaveState {
  /** When each prompt in the current window went up. */
  recent: number[];
  /** One undecided prompt at a time: the second caller is `rate_limited`. */
  prompting: boolean;
}

const states = new Map<string, SaveState>();

function stateFor(artifactId: string): SaveState {
  let state = states.get(artifactId);
  if (!state) {
    state = { recent: [], prompting: false };
    states.set(artifactId, state);
  }
  return state;
}

/* ------------------------------ the delivery ------------------------------ */

export interface DownloadJob {
  filename: string;
  bytes: ArrayBuffer;
  contentType: string;
}

export type Delivery = (job: DownloadJob) => void;

/** What the browser implementation needs; a test hands it a stand-in. */
export interface DeliveryHost {
  document: Document;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  setTimeout(fn: () => void, ms: number): unknown;
}

/** How long an object URL is kept alive after the click, ms. */
export const OBJECT_URL_TTL_MS = 60_000;

/**
 * The shell's own save surface: an object URL on a temporary anchor. The
 * shell page is top level, so this is a real browser download — the iframe
 * cannot do it itself, since its sandbox has no `allow-downloads` (which is
 * why a page's own `<a download>` is relayed as `__frame_blocked`).
 */
export function domDelivery(host: DeliveryHost): Delivery {
  return (job) => {
    const blob = new Blob([job.bytes], { type: job.contentType });
    const url = host.createObjectURL(blob);
    const anchor = host.document.createElement("a");
    anchor.href = url;
    anchor.download = job.filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    host.document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      host.setTimeout(() => host.revokeObjectURL(url), OBJECT_URL_TTL_MS);
    }
  };
}

const browserDelivery: Delivery = (job) => {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    throw capError("unavailable", "this view has no way to save files");
  }
  domDelivery({
    document,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  })(job);
};

let delivery: Delivery = browserDelivery;

/** Test seam: stands in for the browser download. */
export function setDeliveryForTest(next: Delivery | null): void {
  delivery = next ?? browserDelivery;
}

/* -------------------------------- dispatch -------------------------------- */

interface SaveArgs {
  filename: string;
  bytes: ArrayBuffer;
}

/**
 * The wire argument, re-validated shell-side. The frame checked all of this,
 * but the frame is the untrusted side of the boundary: a page that posts to
 * the broker directly gets the same answers.
 */
export function readSaveArgs(arg: unknown): SaveArgs {
  if (!isRecord(arg)) throw capError("bad_request", "save takes {filename, data}");
  const filename = arg.filename;
  if (typeof filename !== "string") throw capError("bad_request", "filename must be a string");
  if (filename.length > MAX_FILENAME_LENGTH) {
    throw capError("bad_request", `filename must be at most ${MAX_FILENAME_LENGTH} characters`);
  }
  const raw = arg.bytes;
  let bytes: ArrayBuffer;
  if (raw instanceof ArrayBuffer) {
    bytes = raw;
  } else if (ArrayBuffer.isView(raw)) {
    bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice()
      .buffer as ArrayBuffer;
  } else {
    throw capError("bad_request", "data must be bytes");
  }
  if (bytes.byteLength === 0) throw capError("bad_request", "data is empty");
  return { filename, bytes };
}

export async function handle(call: BrokerCall, ctx: BrokerContext): Promise<unknown> {
  if (call.method !== "save") throw CAPABILITY_DISABLED(`${CAP}.${call.method}`);

  const { filename, bytes } = readSaveArgs(call.args[0]);
  const resolved = resolveName(filename, extraExtensionsEnabled(ctx));
  if (bytes.byteLength > MAX_BYTES) {
    throw capError("too_large", "a download may be at most 16 MiB");
  }

  const state = stateFor(ctx.boot.artifactId);
  if (state.prompting) {
    throw capError("rate_limited", "a save prompt is already open");
  }
  const now = Date.now();
  state.recent = state.recent.filter((at) => now - at < RATE_WINDOW_MS);
  if (state.recent.length >= RATE_LIMIT) {
    throw capError("rate_limited", `at most ${RATE_LIMIT} downloads a minute`);
  }

  state.recent.push(now);
  state.prompting = true;
  let accepted: boolean;
  try {
    // The viewer is about to be asked: extend the frame's 150 s budget first,
    // so a question somebody is still reading cannot expire into
    // `unavailable` under them.
    ctx.ack(call.id);
    accepted = await ctx.consent({
      title: "Save this file?",
      body: `This page wants to save "${resolved.name}" (${formatSize(
        bytes.byteLength,
      )}) to your device.`,
      confirmLabel: "Save",
      cancelLabel: "Cancel",
    });
  } finally {
    state.prompting = false;
  }
  if (!accepted) throw capError("declined", "the viewer declined the download");

  try {
    delivery({ filename: resolved.name, bytes, contentType: mimeFor(resolved.extension) });
  } catch (err) {
    throw capError(
      "unavailable",
      err instanceof Error ? err.message : "this view has no way to save files",
    );
  }
  return { status: "saved" };
}

/** Only for tests: the rate-limit window outlives a single view. */
export function resetForTest(): void {
  states.clear();
  setDeliveryForTest(null);
}
