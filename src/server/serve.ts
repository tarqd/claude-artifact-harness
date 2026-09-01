/**
 * What each origin serves: the shell page and its bundle, the artifact
 * content with its injected envelope, `/_runtime/<name>.js`, `/_blob/<id>`,
 * and the CSP (design.md "Page envelope", surface-area.md §10). The string
 * builders at the top are pure, so they are unit-testable on their own.
 */
import type { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeModuleMap } from "../protocol/capabilities.ts";
import { isArtifactId } from "../protocol/paths.ts";
import type { FramePreambleConfig } from "../protocol/messages.ts";
import type { ShellBoot } from "../shell/types.ts";
import { mountAdminApi } from "./admin.ts";
import { buildShellBoot } from "./boot.ts";
import type { FrameApp, ServerContext } from "./types.ts";

/** The documented reset the platform prepends to author content. */
export const RESET_CSS = `:root{color-scheme:light}
body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}
img{max-width:100%}
[hidden]{display:none!important}`;

const DOCTYPE_RE = /^\s*<!doctype html/i;

/** JSON safe to inline in a `<script>` element. */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/** Defensive: a `</script` inside the bundle would end the element early. */
function inlineScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

function preambleBlock(config: FramePreambleConfig, source: string): string {
  return (
    `<script>window.__FRAME_PREAMBLE=${inlineJson(config)}</script>` +
    `<script>${inlineScript(source)}</script>`
  );
}

export interface EnvelopeOptions {
  preambleConfig: FramePreambleConfig;
  preambleSource: string;
}

/**
 * Serve-time envelope. Author body content is wrapped in a full document;
 * a complete document (what `publish(html)` sends) keeps its own `<head>`
 * and only receives the preamble, as its first child.
 */
export function buildEnvelope(html: string, options: EnvelopeOptions): string {
  const block = preambleBlock(options.preambleConfig, options.preambleSource);

  if (DOCTYPE_RE.test(html)) {
    // `<head`, not `<header`: a document whose first element is a `<header>`
    // must still get a real head, or the preamble would land in the body,
    // after page scripts have already run.
    const head = /<head(?=[\s>])[^>]*>/i.exec(html);
    if (head) {
      const at = head.index + head[0].length;
      return html.slice(0, at) + block + html.slice(at);
    }
    const htmlTag = /<html[^>]*>/i.exec(html);
    if (htmlTag) {
      const at = htmlTag.index + htmlTag[0].length;
      return `${html.slice(0, at)}<head>${block}</head>${html.slice(at)}`;
    }
    const doctype = /<!doctype html[^>]*>/i.exec(html);
    const at = doctype ? doctype.index + doctype[0].length : 0;
    return `${html.slice(0, at)}<head>${block}</head>${html.slice(at)}`;
  }

  return (
    "<!doctype html><html><head>" +
    block +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<style>${RESET_CSS}</style>` +
    "</head><body>" +
    html +
    "</body></html>"
  );
}

/** The CSP the frame origin serves (surface-area.md §10.1). */
export function frameCsp(shellOrigin: string, connectOrigins: readonly string[] = []): string {
  const connect = ["'self'", ...connectOrigins].join(" ");
  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://cdn.tailwindcss.com https://code.jquery.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    `connect-src ${connect}`,
    "form-action 'none'",
    "base-uri 'self'",
    `frame-ancestors ${shellOrigin}`,
  ].join("; ");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const SHELL_CSS = `:root{color-scheme:light dark}
html,body{margin:0;height:100%;background:#faf9f5;color:#141413}
@media (prefers-color-scheme:dark){html,body{background:#1f1e1d;color:#f5f4ef}}
#frame-slot{position:fixed;inset:0}
#frame-slot iframe{width:100%;height:100%;border:0;opacity:0;transition:opacity .12s ease}
#frame-slot iframe.ready{opacity:1}
@media print{#frame-slot iframe{height:var(--frame-print-h,100vh)}}`;

/** The shell page: boot record plus the shell bundle. Nothing else. */
export function renderShellPage(boot: ShellBoot): string {
  return (
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(boot.title)}</title>` +
    `<style>${SHELL_CSS}</style>` +
    `<script>window.__SHELL_BOOT=${inlineJson(boot)}</script>` +
    '<script src="/_shell/shell.js" defer></script>' +
    '</head><body><div id="frame-slot"></div></body></html>'
  );
}

/* ------------------------------------------------------------------ */
/* route mounting                                                      */
/* ------------------------------------------------------------------ */

const BUILD_HINT = "the client bundles are missing — run `npm run build`";

async function readDist(ctx: ServerContext, ...parts: string[]): Promise<string | null> {
  try {
    return await readFile(join(ctx.config.distDir, ...parts), "utf8");
  } catch {
    return null;
  }
}

/**
 * The artifact is named by the host label; the `/_a/<id>/` prefix form (which
 * arrives as `x-artifact-id`, set by the frame listener, never by a client)
 * is a fallback for hosts that carry no artifact label at all.
 */
function artifactIdFrom(host: string | undefined, header: string | undefined): string | null {
  const label = (host ?? "").split(":")[0]?.split(".")[0] ?? "";
  if (isArtifactId(label)) return label;
  return header && isArtifactId(header) ? header : null;
}

function networkOrigins(capabilities: Record<string, { config?: unknown }> | undefined): string[] {
  const config = capabilities?.network?.config;
  if (typeof config !== "object" || config === null) return [];
  const origins = (config as { origins?: unknown }).origins;
  if (!Array.isArray(origins)) return [];
  return origins.filter((o): o is string => typeof o === "string");
}

export function mountShellRoutes(app: Hono, ctx: ServerContext): void {
  app.get("/login", (c) => {
    const ok = ctx.auth.login(c, c.req.query("token") ?? "");
    if (!ok) return c.text("invalid owner token", 403);
    const next = c.req.query("next");
    if (next && next.startsWith("/")) return c.redirect(next);
    return c.text("logged in as the owner");
  });

  app.get("/_shell/shell.js", async (c) => {
    const source = await readDist(ctx, "shell", "shell.js");
    if (source === null) return c.text(BUILD_HINT, 500);
    return c.body(source, 200, { "content-type": "text/javascript; charset=utf-8" });
  });

  app.get("/a/:id", async (c) => {
    const id = c.req.param("id");
    if (!isArtifactId(id)) return c.text("not found", 404);
    const meta = await ctx.store.readMeta(id);
    if (!meta) return c.text("not found", 404);
    const viewer = ctx.auth.viewer(c);
    const level = ctx.auth.levelFor(viewer, meta);
    const boot = buildShellBoot({
      config: ctx.config,
      auth: ctx.auth,
      meta,
      viewer,
      level,
      shellPort: ctx.shellPort,
      framePort: ctx.framePort,
    });
    return c.html(renderShellPage(boot));
  });

  app.get("/", (c) => c.text("claude-artifact-harness: open /a/<artifactId>"));

  mountAdminApi(app, ctx);
}

export function mountFrameRoutes(app: FrameApp, ctx: ServerContext): void {
  app.use("*", async (c, next) => {
    const id = artifactIdFrom(c.req.header("host"), c.req.header("x-artifact-id"));
    const meta = id ? await ctx.store.readMeta(id) : null;
    c.header("content-security-policy", frameCsp(ctx.shellOrigin, networkOrigins(meta?.capabilities)));
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");

    // Identity on this origin is the signed asset token and nothing else. A
    // token that is forged, expired, or minted for another artifact is a hard
    // refusal; no token at all is simply an anonymous request.
    const token = c.req.query("__frame_t");
    const claims = ctx.auth.verifyAssetToken(token);
    if (token !== undefined && (!claims || (id !== null && claims.artifactId !== id))) {
      return c.text("denied", 403);
    }
    const viewerId = claims && (id === null || claims.artifactId === id) ? claims.viewerId : null;
    const level = meta
      ? ctx.auth.levelFor({ id: viewerId ?? "", isOwner: false }, meta)
      : ctx.config.defaultLevel;
    c.set("frameViewer", { id: viewerId, artifactId: id, level });
    await next();
  });

  app.get("/_runtime/:file", async (c) => {
    const file = c.req.param("file");
    const allowed = new Set(Object.values(runtimeModuleMap()));
    if (!allowed.has(file)) return c.text("not found", 404);
    const source = await readDist(ctx, "runtime", file);
    if (source === null) return c.text(BUILD_HINT, 500);
    return c.body(source, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    });
  });

  // Assets land here once the assets slice ships.
  app.get("/_blob/:blobId", (c) =>
    c.json({ code: "unavailable", message: "the assets slice is not installed" }, 501),
  );

  app.get("/_f/:ver", (c) => c.redirect(`${c.req.path}/`));

  app.get("/_f/:ver/*", async (c) => {
    const id = artifactIdFrom(c.req.header("host"), c.req.header("x-artifact-id"));
    if (!id) return c.text("no artifact for this host", 404);
    const meta = await ctx.store.readMeta(id);
    if (!meta) return c.text("not found", 404);

    const version = c.req.param("ver");
    const prefix = `/_f/${version}/`;
    const rest = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "";
    const relative = decodeURIComponent(rest) || "index.html";
    const file = await ctx.store.readVersionFile(id, version, relative);
    if (!file) return c.text("not found", 404);

    if (file.contentType.startsWith("text/html")) {
      const preambleSource = await readDist(ctx, "frame", "preamble.js");
      if (preambleSource === null) return c.text(BUILD_HINT, 500);
      const preambleConfig: FramePreambleConfig = {
        v: 1,
        capabilities: runtimeModuleMap(),
        origins: [ctx.shellOrigin],
      };
      const html = buildEnvelope(file.body.toString("utf8"), { preambleConfig, preambleSource });
      return c.body(html, 200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
    }
    return c.body(new Uint8Array(file.body), 200, { "content-type": file.contentType });
  });
}
