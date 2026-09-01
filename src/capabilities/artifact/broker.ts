/**
 * `artifact` broker: turns a frame's `publish` into a compare-and-set write
 * on the server, with the viewer's own authority, and reloads the view.
 *
 * The frame never sees a credential: the shell calls its own backend
 * same-origin, carrying the viewer cookie.
 */
import { capError, CAPABILITY_DISABLED } from "../../protocol/errors.ts";
import type { BrokerCall, BrokerContext } from "../../shell/types.ts";

interface WireFile {
  content: string | Blob;
  contentType: string;
}

interface PublishResponse {
  version: string;
}

/** JSON transport for a files publish: bytes travel base64. */
interface EncodedFile {
  contentType: string;
  encoding: "utf8" | "base64";
  content: string;
}

function isWireFile(value: unknown): value is WireFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as { content?: unknown; contentType?: unknown };
  return (
    typeof file.contentType === "string" &&
    (typeof file.content === "string" || file.content instanceof Blob)
  );
}

async function encodeFile(file: WireFile): Promise<EncodedFile> {
  if (typeof file.content === "string") {
    return { contentType: file.contentType, encoding: "utf8", content: file.content };
  }
  const buffer = await file.content.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { contentType: file.contentType, encoding: "base64", content: btoa(binary) };
}

async function encodeFiles(
  input: unknown,
): Promise<Record<string, EncodedFile | null>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw capError("invalid_content", "files must be plain data");
  }
  const out: Record<string, EncodedFile | null> = {};
  for (const [path, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === null) {
      out[path] = null;
      continue;
    }
    if (!isWireFile(value)) {
      throw capError("invalid_content", `${path}: content must be a string or a Blob`);
    }
    out[path] = await encodeFile(value);
  }
  return out;
}

export async function handle(call: BrokerCall, ctx: BrokerContext): Promise<unknown> {
  if (call.method !== "publish") {
    // `edit` and `sync` are live-doc verbs; v0 serves classic artifacts only.
    throw CAPABILITY_DISABLED(`artifact.${call.method}`);
  }
  if (!ctx.viewer.canEdit) {
    throw capError("not_writer", "this viewer cannot write this artifact");
  }

  const argument = call.args[0];
  const path = `/api/frame/self/${ctx.boot.artifactId}`;

  if (typeof argument === "string") {
    const result = await ctx.api<PublishResponse>(path, {
      method: "POST",
      body: JSON.stringify({ baseVersion: ctx.version, html: argument }),
    });
    ctx.setVersion(result.version);
    // Reply first, then reload: the page is told its version before it goes.
    setTimeout(() => ctx.reloadView(result.version), 0);
    return { version: result.version };
  }

  if (!ctx.flags.has("artifact_files")) {
    throw CAPABILITY_DISABLED("publishing files");
  }
  const files = await encodeFiles(argument);
  const result = await ctx.api<PublishResponse>(path, {
    method: "POST",
    body: JSON.stringify({ baseVersion: ctx.version, files }),
  });
  // A files publish leaves this view running; only other views reload.
  ctx.setVersion(result.version);
  return { version: result.version };
}
