/**
 * `downloads` — the page-facing namespace from
 * `reference/contract/0.2.32/downloads.d.ts`: a single `save({filename, data})`
 * that resolves `{status: "saved"}` once the viewer has accepted, and rejects
 * with `{code, message}` for every other outcome.
 *
 * The frame decides almost nothing. It normalises `data` to bytes, enforces
 * the two caller-bug rules the contract names (`filename` a string of at most
 * 512 characters, non-empty and non-detached data) and hands the shell
 * `[{filename, bytes}]` with the buffer in the `postMessage` transfer list
 * (surface-area.md §5.3). The allowlist, the 16 MiB cap, the rate limit and
 * the viewer's prompt all live in the broker, because only the shell knows
 * what this deployment allows and what the viewer has already been asked.
 *
 * Timeout: 150 s, rejecting `unavailable` — the documented budget for this
 * capability (surface-area.md §4). An `__frame_cap_ack`, which the broker
 * sends before it opens the prompt, extends that to 900 s so a viewer who
 * takes their time reading the question does not turn a live prompt into a
 * spurious `unavailable`.
 */
import { browserRpcHost, createRpc, type RpcHost } from "../../frame/rpc.ts";
import { capError, isCapError } from "../../protocol/errors.ts";
import type { FrameContext } from "../../frame/types.ts";

export const CAP = "downloads";

/** The documented reply budget for `downloads` (surface-area.md §4). */
export const SAVE_TIMEOUT_MS = 150_000;

/** `bad_request` — "bad filename (non-string or >512 chars)". */
export const MAX_FILENAME_LENGTH = 512;

export interface SaveRequest {
  filename: string;
  data: string | Blob | ArrayBuffer | ArrayBufferView;
}

export interface SaveResult {
  status: "saved";
}

export interface DownloadsNamespace {
  save(request: SaveRequest): Promise<SaveResult>;
}

export interface DownloadsClientOptions {
  /** Test seam: stands in for `parent.postMessage` (see `frame/rpc.ts`). */
  host?: RpcHost;
}

const badRequest = (message: string): never => {
  throw capError("bad_request", message);
};

function isArrayBuffer(v: unknown): v is ArrayBuffer {
  return v instanceof ArrayBuffer;
}

/** A buffer whose bytes are gone: transferred away, or zero-length to begin with. */
function isUsableBuffer(buffer: ArrayBuffer): boolean {
  const detached = (buffer as { detached?: boolean }).detached;
  return detached !== true && buffer.byteLength > 0;
}

/** A fresh, exactly-sized ArrayBuffer holding a copy of a view's bytes. */
function copyView(view: ArrayBufferView): ArrayBuffer {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Normalise `data` to the bytes that go on the wire.
 *
 * An `ArrayBuffer` is TRANSFERRED, as the contract promises: the caller's
 * buffer is detached here rather than only when `postMessage` happens to
 * support a transfer list, so the page sees the documented behaviour on every
 * host. Views, Blobs and strings are copied; a string is UTF-8.
 */
export async function toBytes(data: unknown): Promise<ArrayBuffer> {
  if (typeof data === "string") {
    if (data.length === 0) badRequest("data is empty");
    const encoded = new TextEncoder().encode(data);
    if (encoded.byteLength === 0) badRequest("data is empty");
    return encoded.byteOffset === 0 && encoded.buffer.byteLength === encoded.byteLength
      ? (encoded.buffer as ArrayBuffer)
      : copyView(encoded);
  }

  if (isArrayBuffer(data)) {
    if (!isUsableBuffer(data)) badRequest("data is empty or already detached");
    try {
      // Detaches the caller's buffer and hands us the same bytes, no copy.
      return structuredClone(data, { transfer: [data] });
    } catch {
      // A buffer this realm may not transfer (a detached one that still
      // reports bytes, say): copy rather than fail the save.
      return data.slice(0);
    }
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    // A Blob's own `type` is deliberately ignored: MIME comes from the
    // extension (downloads.d.ts, `SaveRequest.data`).
    let buffer: ArrayBuffer;
    try {
      buffer = await data.arrayBuffer();
    } catch {
      return badRequest("data could not be read");
    }
    if (buffer.byteLength === 0) badRequest("data is empty");
    return buffer;
  }

  if (ArrayBuffer.isView(data)) {
    if (data.byteLength === 0) badRequest("data is empty or already detached");
    return copyView(data);
  }

  return badRequest("data must be a string, a Blob, an ArrayBuffer or an ArrayBufferView");
}

export function validateFilename(filename: unknown): string {
  if (typeof filename !== "string") badRequest("filename must be a string");
  const name = filename as string;
  if (name.length > MAX_FILENAME_LENGTH) {
    badRequest(`filename must be at most ${MAX_FILENAME_LENGTH} characters`);
  }
  return name;
}

/**
 * `postMessage` with the bytes in the transfer list, which is what the wire
 * shape in surface-area.md §5.3 calls for: the buffer moves to the shell
 * instead of being copied. Everything else about the host is the shared one.
 */
export function transferringHost(shellOrigin: string, base = browserRpcHost(shellOrigin)): RpcHost {
  return {
    ...base,
    post(message, targetOrigin) {
      const transfer = transferListFor(message);
      if (transfer.length === 0) {
        base.post(message, targetOrigin);
        return;
      }
      try {
        window.parent.postMessage(message, { targetOrigin, transfer });
      } catch {
        // A host without the options form still gets the message, by copy.
        base.post(message, targetOrigin);
      }
    },
  };
}

/** The ArrayBuffers in a `save` envelope, if any. */
export function transferListFor(message: unknown): Transferable[] {
  if (typeof message !== "object" || message === null) return [];
  const args = (message as { args?: unknown }).args;
  if (!Array.isArray(args)) return [];
  const out: Transferable[] = [];
  for (const arg of args) {
    if (typeof arg !== "object" || arg === null) continue;
    const bytes = (arg as { bytes?: unknown }).bytes;
    if (isArrayBuffer(bytes) && isUsableBuffer(bytes)) out.push(bytes);
  }
  return out;
}

/**
 * The shell answers with the capability's own codes. The one code it can
 * produce that the contract does not name is the RPC client's
 * `invalid_content` (arguments that would not clone), which is a caller bug
 * by another name, so it arrives at the page as `bad_request`.
 */
function asDownloadsError(err: unknown): unknown {
  if (isCapError(err) && err.code === "invalid_content") {
    return capError("bad_request", err.message);
  }
  return err;
}

export function createDownloads(
  ctx: FrameContext,
  options: DownloadsClientOptions = {},
): DownloadsNamespace {
  const pipe = ctx.pipe(CAP);
  const rpc = createRpc({
    cap: CAP,
    shellOrigin: ctx.shellOrigin,
    host: options.host ?? transferringHost(ctx.shellOrigin),
    timeoutMs: SAVE_TIMEOUT_MS,
    // "unavailable — saves unusable in this view; hide your save UI."
    onTimeout: () => capError("unavailable", "no reply from shell"),
  });

  const save = pipe.wrap("save", async (request: unknown) => {
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      badRequest("save takes {filename, data}");
    }
    const filename = validateFilename((request as { filename?: unknown }).filename);
    const bytes = await toBytes((request as { data?: unknown }).data);
    try {
      return await rpc.call<SaveResult>("save", [{ filename, bytes }]);
    } catch (err) {
      throw asDownloadsError(err);
    }
  });

  return { save } as DownloadsNamespace;
}

export function install(ctx: FrameContext): void {
  ctx.mount(CAP, createDownloads(ctx));
}
