/**
 * Admin API on the shell origin, for tooling (`npm run publish`) and tests.
 * Guarded by the owner cookie or `Authorization: Bearer <ARTIFACT_OWNER_TOKEN>`.
 * A server with no credential serves it only when explicitly opened with
 * `ARTIFACT_OPEN_ADMIN=1`: it creates and overwrites artifacts.
 */
import type { Context, Hono } from "hono";
import { isCapError, toCapError } from "../protocol/errors.ts";
import { isArtifactId } from "../protocol/paths.ts";
import type { ServerContext } from "./types.ts";

interface CreateBody {
  html?: unknown;
  title?: unknown;
  favicon?: unknown;
  capabilities?: unknown;
}

function readCapabilities(value: unknown): Record<string, { config?: unknown }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, { config?: unknown }> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "object" && entry !== null && "config" in entry) {
      out[name] = { config: (entry as { config?: unknown }).config };
    } else {
      // `{"db": {}}` and `{"downloads": true}` both mean "declared, no config".
      out[name] = { config: typeof entry === "object" && entry !== null ? entry : {} };
    }
  }
  return out;
}

export function mountAdminApi(app: Hono, ctx: ServerContext): void {
  const guard = (c: Context): boolean => ctx.auth.isAdminRequest(c);

  app.post("/api/artifacts", async (c) => {
    if (!guard(c)) return c.json({ code: "not_writer", message: "owner only" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as CreateBody;
    if (typeof body.html !== "string") {
      return c.json({ code: "invalid_content", message: "html is required" }, 400);
    }
    const viewer = ctx.auth.viewer(c);
    try {
      const meta = await ctx.store.createArtifact({
        html: body.html,
        title: typeof body.title === "string" ? body.title : undefined,
        favicon: typeof body.favicon === "string" ? body.favicon : null,
        capabilities: readCapabilities(body.capabilities),
        owner: viewer.id,
      });
      return c.json({
        id: meta.id,
        version: meta.currentVersion,
        title: meta.title,
        url: `${ctx.shellOrigin}/a/${meta.id}`,
      });
    } catch (err) {
      const error = toCapError(err);
      return c.json(error, isCapError(err) ? 400 : 500);
    }
  });

  app.get("/api/artifacts/:id", async (c) => {
    const id = c.req.param("id");
    if (!isArtifactId(id)) return c.json({ code: "invalid_content", message: "bad id" }, 400);
    const meta = await ctx.store.readMeta(id);
    if (!meta) return c.json({ code: "not_declared", message: "no such artifact" }, 404);
    const files = await ctx.store.listVersionFiles(id, meta.currentVersion);
    return c.json({ ...meta, files, url: `${ctx.shellOrigin}/a/${meta.id}` });
  });

  /** Any viewer may ask what the live version is: this drives live reload. */
  app.get("/api/artifacts/:id/version", async (c) => {
    const id = c.req.param("id");
    if (!isArtifactId(id)) return c.json({ code: "invalid_content", message: "bad id" }, 400);
    const meta = await ctx.store.readMeta(id);
    if (!meta) return c.json({ code: "not_declared", message: "no such artifact" }, 404);
    return c.json({ version: meta.currentVersion, updatedAt: meta.updatedAt });
  });

  app.post("/api/artifacts/:id/publish", async (c) => {
    if (!guard(c)) return c.json({ code: "not_writer", message: "owner only" }, 403);
    const id = c.req.param("id");
    if (!isArtifactId(id)) return c.json({ code: "invalid_content", message: "bad id" }, 400);
    const meta = await ctx.store.readMeta(id);
    if (!meta) return c.json({ code: "not_declared", message: "no such artifact" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      html?: unknown;
      baseVersion?: unknown;
    };
    if (typeof body.html !== "string") {
      return c.json({ code: "invalid_content", message: "html is required" }, 400);
    }
    const baseVersion =
      typeof body.baseVersion === "string" ? body.baseVersion : meta.currentVersion;
    const viewer = ctx.auth.viewer(c);
    try {
      const result = await ctx.store.publish(id, {
        baseVersion,
        html: body.html,
        actor: viewer.id,
      });
      return c.json(result);
    } catch (err) {
      const error = toCapError(err);
      return c.json(error, error.code === "conflict" ? 409 : 400);
    }
  });
}
