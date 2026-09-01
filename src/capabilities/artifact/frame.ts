/**
 * `artifact` (and its legacy spelling `self`) — the page-facing namespace
 * from `reference/contract/0.2.32/artifact.d.ts`: `publish`, `edit`, `sync`.
 *
 * v0 implements `publish` in both forms. `edit`/`sync` are live-doc only and
 * are out of scope, so they reject `capability_disabled` — the lifecycle code
 * the contract tells pages to treat as "hide the write affordance".
 */
import { capError } from "../../protocol/errors.ts";
import { createRpc } from "../../frame/rpc.ts";
import type { FrameContext } from "../../frame/types.ts";

const CAP = "artifact";
const MAX_PATHS = 256;

/** Extension → media type, for a files publish that omits `contentType`. */
const EXTENSION_TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain",
  md: "text/markdown",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
  wasm: "application/wasm",
};

interface WireFile {
  content: string | Blob;
  contentType: string;
}

export type PublishFile = string | Blob | { content: string | Blob; contentType?: string };

function extensionType(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return EXTENSION_TYPES[path.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * The files-form validator, mirroring the platform's rejections exactly
 * (docs/analysis/artifact.md §3.1) so pages see the same messages.
 */
export function validateFiles(
  input: unknown,
  filesEnabled: boolean,
): Record<string, WireFile | null> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw capError(
      "invalid_content",
      "publish takes an HTML string or an object mapping file paths to contents",
    );
  }
  if (!filesEnabled) {
    throw capError("capability_disabled", "publishing files is not available in this view");
  }
  let entries: Array<[string, unknown]>;
  try {
    entries = Object.entries(input as Record<string, unknown>);
  } catch {
    throw capError("invalid_content", "files must be plain data");
  }
  if (entries.length === 0) throw capError("invalid_content", "files names no paths");
  if (entries.length > MAX_PATHS) {
    throw capError("invalid_content", `files names more than ${MAX_PATHS} paths`);
  }

  const out = Object.create(null) as Record<string, WireFile | null>;
  for (const [path, value] of entries) {
    if (path === "") throw capError("invalid_content", "a file path must not be empty");
    if (value === null) {
      out[path] = null;
      continue;
    }
    let content: unknown;
    let contentType: unknown;
    if (typeof value === "string" || value instanceof Blob) {
      content = value;
    } else if (typeof value === "object") {
      try {
        content = (value as { content?: unknown }).content;
        contentType = (value as { contentType?: unknown }).contentType;
      } catch {
        throw capError("invalid_content", "files must be plain data");
      }
    } else {
      throw capError("invalid_content", `${path}: content must be a string or a Blob`);
    }

    if (typeof content !== "string" && !(content instanceof Blob)) {
      throw capError("invalid_content", `${path}: content must be a string or a Blob`);
    }
    if (contentType !== undefined) {
      if (typeof contentType !== "string" || contentType.length === 0 || contentType.includes(";")) {
        throw capError(
          "invalid_content",
          `${path}: contentType must be a bare media type such as text/plain, with no parameters`,
        );
      }
      out[path] = { content, contentType };
      continue;
    }
    let blobType = "";
    if (content instanceof Blob) {
      try {
        blobType = content.type.split(";")[0]?.trim() ?? "";
      } catch {
        throw capError("invalid_content", `${path}: the blob must be plain bytes`);
      }
    }
    const inferred = blobType || extensionType(path);
    if (!inferred) {
      throw capError(
        "invalid_content",
        `${path}: cannot infer a content type from the name; pass {content, contentType}`,
      );
    }
    out[path] = { content, contentType: inferred };
  }
  return out;
}

export function install(ctx: FrameContext): void {
  const rpc = createRpc({ cap: CAP, shellOrigin: ctx.shellOrigin });
  const pipe = ctx.pipe(CAP);
  const filesEnabled = ctx.flags.has("artifact_files");

  const publish = pipe.wrap("publish", (arg: string | Record<string, PublishFile | null>) => {
    if (typeof arg === "string") {
      // No client-side doctype or size check: the shell decides.
      return rpc.call<{ version: string }>("publish", [arg]);
    }
    return rpc.call<{ version: string }>("publish", [validateFiles(arg, filesEnabled)]);
  });

  const edit = pipe.wrap("edit", (_ops: unknown[]) => {
    throw capError("capability_disabled", "live-doc editing is not available in this view");
  });

  const sync = pipe.wrap("sync", (fn: () => unknown) => {
    if (typeof fn !== "function") throw capError("transform_error", "sync takes a function");
    throw capError("capability_disabled", "live-doc editing is not available in this view");
  });

  const namespace = { publish, edit, sync };
  ctx.mount("artifact", namespace);
  ctx.mount("self", namespace);
}
