/**
 * `assets` broker: three same-origin calls to the shell's own backend, with
 * the viewer's cookie and nothing else. The frame never sees a credential and
 * never learns the storage path — it gets an id and a relative `/_blob/<id>`
 * URL that resolves against its own origin.
 *
 * The upload is a **raw body** POST: the Blob the frame cloned over
 * `postMessage` is handed to `fetch` as-is with the validated media type in
 * `Content-Type`, so the bytes are never base64-inflated on their way to the
 * server (a 20 MiB cap would otherwise mean a ~27 MiB JSON string).
 */
import { CAPABILITY_DISABLED, isCapError } from "../../protocol/errors.ts";
import type { BrokerCall, BrokerContext } from "../../shell/types.ts";
import {
  checkSize,
  checkType,
  invalidRequest,
  isAssetErrorCode,
  parseAssetRef,
  upstreamError,
  type AssetDeleteResult,
  type AssetPage,
  type AssetRecord,
} from "./protocol.ts";

/** The refusal a viewer who may not write this artifact gets. */
export const NOT_A_WRITER = "this viewer cannot change this artifact's assets";

function isBlob(v: unknown): v is Blob {
  return typeof Blob !== "undefined" && v instanceof Blob;
}

/**
 * Everything the backend can fail with reaches the page as one of the four
 * documented codes; an unexpected shape (a proxy's HTML error page, a dropped
 * connection) becomes `upstream_error` rather than leaking through.
 */
function asAssetsError(err: unknown): unknown {
  if (isCapError(err)) {
    if (isAssetErrorCode(err.code)) return err;
    return upstreamError(err.message);
  }
  if (err instanceof Error) return upstreamError(err.message);
  return upstreamError(String(err));
}

async function upload(call: BrokerCall, ctx: BrokerContext): Promise<AssetRecord> {
  if (!ctx.viewer.canEdit) throw upstreamError(NOT_A_WRITER);
  const blob = call.args[0];
  if (!isBlob(blob)) throw invalidRequest("upload takes a Blob");

  // The frame already checked; the shell checks again because a frame is not
  // a trusted validator, and because the type on the wire is what the server
  // will store and later serve.
  const checked = checkType(call.args[1] ?? blob.type);
  if ("error" in checked) throw checked.error;
  const tooBig = checkSize(checked.type, blob.size);
  if (tooBig) throw tooBig;

  return ctx.api<AssetRecord>(`/api/frame/blob/${ctx.boot.artifactId}/upload`, {
    method: "POST",
    headers: { "content-type": checked.type },
    body: blob,
  });
}

async function list(call: BrokerCall, ctx: BrokerContext): Promise<AssetPage> {
  const cursor = call.args[0];
  if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
    throw invalidRequest("list takes an optional cursor");
  }
  return ctx.api<AssetPage>(`/api/frame/blob/${ctx.boot.artifactId}/list`, {
    method: "POST",
    body: JSON.stringify(cursor ? { after: cursor } : {}),
  });
}

async function remove(call: BrokerCall, ctx: BrokerContext): Promise<AssetDeleteResult> {
  if (!ctx.viewer.canEdit) throw upstreamError(NOT_A_WRITER);
  const id = parseAssetRef(call.args[0]);
  if (id === null) throw invalidRequest("delete takes an asset id or its /_blob/<id> url");
  return ctx.api<AssetDeleteResult>(
    `/api/frame/blob/${ctx.boot.artifactId}/${id}/delete`,
    { method: "POST" },
  );
}

export async function handle(call: BrokerCall, ctx: BrokerContext): Promise<unknown> {
  try {
    switch (call.method) {
      case "upload":
        return await upload(call, ctx);
      case "list":
        return await list(call, ctx);
      case "delete":
        return await remove(call, ctx);
      default:
        throw CAPABILITY_DISABLED(`assets.${call.method}`);
    }
  } catch (err) {
    // `capability_disabled` is a lifecycle code and travels unchanged.
    if (isCapError(err) && err.code === "capability_disabled") throw err;
    throw asAssetsError(err);
  }
}
