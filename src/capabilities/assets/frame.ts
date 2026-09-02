/**
 * `assets` — the page-facing namespace (surface-area.md §5.4):
 *
 *   upload(blob, {type?}) -> {id, url: "/_blob/<id>", type, size, createdAt}
 *   list()                -> {assets: [...], usage}
 *   delete(idOrUrl)       -> {id, deleted}
 *
 * The frame owns the caller-bug half of the contract: the accepted media
 * types, the 20 MiB / 2 MiB-for-SVG caps and the `/_blob/<id>` grammar are all
 * checked here so an obvious mistake never costs a round trip, and so the page
 * sees the documented code (`invalid_request`, `too_large`,
 * `unsupported_type`) rather than a generic backend failure. The shell and the
 * server run the same checks again, because neither trusts the frame.
 *
 * `list()` is the one method that is more than a single call: the wire pages,
 * and the module follows `next` cursors for at most 16 pages before it stops
 * and returns what it has. That bound is the platform's, and it is what keeps
 * a page with a runaway asset list from hanging on `list()`.
 *
 * Wire: id prefix `e`, 130 s reply budget, `upstream_error` on timeout.
 */
import { createRpc, type RpcHost } from "../../frame/rpc.ts";
import { isCapError } from "../../protocol/errors.ts";
import type { FrameContext } from "../../frame/types.ts";
import {
  ASSETS_TIMEOUT_MS,
  CAP,
  MAX_LIST_PAGES,
  checkSize,
  checkType,
  invalidRequest,
  isAssetErrorCode,
  parseAssetRef,
  upstreamError,
  type AssetDeleteResult,
  type AssetListResult,
  type AssetPage,
  type AssetRecord,
  type AssetUsage,
} from "./protocol.ts";

export { CAP } from "./protocol.ts";

export interface UploadOptions {
  type?: string;
}

export interface AssetsNamespace {
  upload(blob: Blob, options?: UploadOptions): Promise<AssetRecord>;
  list(): Promise<AssetListResult>;
  delete(idOrUrl: string): Promise<AssetDeleteResult>;
}

export interface AssetsClientOptions {
  /** Test seam: stands in for `parent.postMessage` (see `frame/rpc.ts`). */
  host?: RpcHost;
}

const EMPTY_USAGE: AssetUsage = { count: 0, bytes: 0 };

function isBlob(v: unknown): v is Blob {
  return typeof Blob !== "undefined" && v instanceof Blob;
}

/**
 * What goes on the wire for `upload`: `[Blob, contentType]`. Throws one of the
 * documented errors; `pipe.wrap` turns that into the rejection the page sees.
 */
export function validateUpload(blob: unknown, options: unknown): [Blob, string] {
  if (!isBlob(blob)) throw invalidRequest("upload takes a Blob");
  if (options !== undefined && options !== null) {
    if (typeof options !== "object" || Array.isArray(options)) {
      throw invalidRequest("upload options must be an object");
    }
  }
  let declared: unknown;
  if (options !== undefined && options !== null) {
    try {
      declared = (options as { type?: unknown }).type;
    } catch {
      throw invalidRequest("upload options must be plain data");
    }
    if (declared !== undefined && typeof declared !== "string") {
      throw invalidRequest("upload options.type must be a string");
    }
  }

  // An explicit `{type}` wins over the Blob's own, which is often "" for
  // bytes a page assembled itself.
  const checked = checkType(declared ?? blob.type);
  if ("error" in checked) throw checked.error;

  // An empty Blob is stored as an empty asset: §5.4 sets caps, not a minimum.
  const tooBig = checkSize(checked.type, blob.size);
  if (tooBig) throw tooBig;

  return [blob, checked.type];
}

/** One page of `list`, defended against a reply that is not the shape we asked for. */
function readPage(reply: unknown): AssetPage {
  if (typeof reply !== "object" || reply === null) {
    return { assets: [], usage: EMPTY_USAGE };
  }
  const page = reply as Partial<AssetPage>;
  const assets = Array.isArray(page.assets)
    ? page.assets.filter((a): a is AssetRecord => typeof a === "object" && a !== null)
    : [];
  const usage =
    typeof page.usage === "object" && page.usage !== null
      ? (page.usage as AssetUsage)
      : EMPTY_USAGE;
  const next = typeof page.next === "string" && page.next.length > 0 ? page.next : undefined;
  return next === undefined ? { assets, usage } : { assets, usage, next };
}

/**
 * The shell answers with this capability's own codes. The one code the RPC
 * client can produce that §5.4 does not name is `invalid_content` (arguments
 * `postMessage` refused to clone), which is a caller bug by another name, so
 * it reaches the page as `invalid_request`. Anything else unrecognised is
 * `upstream_error`, so a page only ever branches on the four documented codes.
 */
function asAssetsError(err: unknown): unknown {
  if (!isCapError(err)) return upstreamError(String(err));
  if (isAssetErrorCode(err.code)) return err;
  if (err.code === "invalid_content") return invalidRequest(err.message);
  // Lifecycle codes are the runtime's own and must reach the page unchanged.
  if (
    err.code === "capability_disabled" ||
    err.code === "capability_removed" ||
    err.code === "not_granted" ||
    err.code === "transform_error"
  ) {
    return err;
  }
  return upstreamError(err.message);
}

export function createAssets(
  ctx: FrameContext,
  options: AssetsClientOptions = {},
): AssetsNamespace {
  const pipe = ctx.pipe(CAP);
  const rpc = createRpc({
    cap: CAP,
    shellOrigin: ctx.shellOrigin,
    ...(options.host ? { host: options.host } : {}),
    timeoutMs: ASSETS_TIMEOUT_MS,
    onTimeout: () => upstreamError("no reply from shell"),
  });

  const upload = pipe.wrap("upload", async (blob: unknown, uploadOptions?: unknown) => {
    const args = validateUpload(blob, uploadOptions);
    try {
      return await rpc.call<AssetRecord>("upload", args);
    } catch (err) {
      throw asAssetsError(err);
    }
  });

  const list = pipe.wrap("list", async () => {
    const assets: AssetRecord[] = [];
    let usage: AssetUsage = EMPTY_USAGE;
    let cursor: string | undefined;
    const seen = new Set<string>();

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      let reply: unknown;
      try {
        reply = await rpc.call<AssetPage>("list", cursor === undefined ? [] : [cursor]);
      } catch (err) {
        throw asAssetsError(err);
      }
      const { assets: rows, usage: pageUsage, next } = readPage(reply);
      assets.push(...rows);
      // Usage is the whole artifact's, not the page's: the last answer wins.
      usage = pageUsage;
      // A cursor that repeats would page forever; stop instead.
      if (next === undefined || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }

    return { assets, usage } satisfies AssetListResult;
  });

  const remove = pipe.wrap("delete", async (idOrUrl: unknown) => {
    const id = parseAssetRef(idOrUrl);
    if (id === null) {
      throw invalidRequest("delete takes an asset id or its /_blob/<id> url");
    }
    try {
      return await rpc.call<AssetDeleteResult>("delete", [id]);
    } catch (err) {
      throw asAssetsError(err);
    }
  });

  return { upload, list, delete: remove } as AssetsNamespace;
}

export function install(ctx: FrameContext): void {
  ctx.mount(CAP, createAssets(ctx));
}
