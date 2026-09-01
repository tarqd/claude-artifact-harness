/**
 * `artifact` backend: the compare-and-set publish endpoint the shell broker
 * calls, mirroring claude.ai's `/api/frame/self/<uuid>`.
 */
import { toCapError } from "../../protocol/errors.ts";
import { isArtifactId } from "../../protocol/paths.ts";
import type { ServerApps, ServerContext } from "../../server/types.ts";
import type { PublishInput } from "../../server/store.ts";

interface EncodedFile {
  contentType?: unknown;
  encoding?: unknown;
  content?: unknown;
}

function decodeFiles(input: unknown): PublishInput["files"] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const out: NonNullable<PublishInput["files"]> = {};
  for (const [path, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === null) {
      out[path] = null;
      continue;
    }
    const file = value as EncodedFile;
    if (typeof file.content !== "string" || typeof file.contentType !== "string") {
      throw toCapError({ code: "invalid_content", message: `${path}: malformed file` });
    }
    const content =
      file.encoding === "base64"
        ? Buffer.from(file.content, "base64")
        : Buffer.from(file.content, "utf8");
    out[path] = { content, contentType: file.contentType };
  }
  return out;
}

export function routes(apps: ServerApps, ctx: ServerContext): void {
  apps.shell.post("/api/frame/self/:id", async (c) => {
    const id = c.req.param("id");
    if (!isArtifactId(id)) {
      return c.json({ code: "invalid_content", message: "bad artifact id" }, 400);
    }
    const meta = await ctx.store.readMeta(id);
    if (!meta) return c.json({ code: "not_declared", message: "no such artifact" }, 404);

    const viewer = ctx.auth.viewer(c);
    const level = ctx.auth.levelFor(viewer, meta);
    if (!ctx.auth.canEdit(level)) {
      return c.json({ code: "not_writer", message: "this viewer cannot write" }, 403);
    }
    if (!("artifact" in meta.capabilities) && !("self" in meta.capabilities)) {
      return c.json(
        { code: "not_declared", message: "this artifact no longer declares artifact" },
        400,
      );
    }

    const body = (await c.req.json().catch(() => null)) as {
      baseVersion?: unknown;
      html?: unknown;
      files?: unknown;
    } | null;
    if (!body) return c.json({ code: "invalid_content", message: "bad request body" }, 400);

    const baseVersion =
      typeof body.baseVersion === "string" ? body.baseVersion : meta.currentVersion;

    try {
      const input: PublishInput = { baseVersion, actor: viewer.id, requireDoctype: true };
      if (typeof body.html === "string") input.html = body.html;
      else if (body.files !== undefined) input.files = decodeFiles(body.files);
      else {
        return c.json({ code: "invalid_content", message: "html or files is required" }, 400);
      }
      const result = await ctx.store.publish(id, input);
      return c.json(result);
    } catch (err) {
      const error = toCapError(err);
      const status = error.code === "conflict" ? 409 : error.code === "too_large" ? 413 : 400;
      return c.json(error, status);
    }
  });
}
