/**
 * What each origin serves: the shell page and its bundle, the artifact
 * content with its injected envelope, `/_runtime/<name>.js`, `/_blob/<id>`,
 * and the CSP (design.md "Page envelope", surface-area.md §10). The string
 * builders at the top are pure, so they are unit-testable on their own.
 */
import type { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connectSrcOrigins } from "../capabilities/network/server.ts";
import { runtimeModuleMap } from "../protocol/capabilities.ts";
import { isArtifactId, isVersionId } from "../protocol/paths.ts";
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
const LEADING_DOCTYPE_RE = /^\s*<!doctype html[^>]*>/i;

/**
 * Stored types that receive the envelope (and so the preamble's RTC
 * lockdown): both are documents a browser executes script in when navigated
 * to directly. Everything else is served inert (issue #15).
 */
const DOCUMENT_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/**
 * Script media types exempted from the `; sandbox` suffix (issue #16
 * follow-up). CSP sandbox gives a `new Worker(...)` response an opaque
 * origin, which the platform enforces even for a worker script — so
 * sandboxing every non-document stored file would break an artifact that
 * ships `new Worker('/_f/<ver>/w.js')` pointed at a stored `.js` file.
 * Navigating to a script URL directly only ever renders it as inert text
 * (browsers do not execute a top-level navigation's response as script), so
 * exempting these leaks nothing: no document response becomes executable on
 * the artifact origin. Includes the module-script case, which is also
 * served as `text/javascript`. Every other non-document type (SVG, XML,
 * everything else) keeps the sandbox.
 */
const SCRIPT_CONTENT_TYPES = new Set([
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "text/ecmascript",
]);

/**
 * Elements whose content is text and not markup. A `<head` inside one of
 * them is the author's data, so the scanner steps over the whole element.
 */
const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noscript",
  "noframes",
  "noembed",
]);

/** Where the preamble goes: inside an existing head, or as a new one here. */
export interface HeadInsertion {
  kind: "in-head" | "new-head";
  at: number;
}

/** End of a tag, honouring quoted attribute values (`data-x="<head>"`). */
function tagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i + 1;
  }
  return html.length;
}

function skipPast(html: string, from: number, marker: string): number {
  const at = html.indexOf(marker, from);
  return at === -1 ? html.length : at + marker.length;
}

/**
 * Find the preamble's insertion point by scanning the markup rather than
 * matching its text: a `<head` inside a comment, an attribute value or a
 * script's source is data, and injecting there would either strand the
 * runtime outside the document or splice a `</script>` into author code.
 *
 * The first `<head>` wins; a `<body>` reached first means the document has
 * no head, so one is opened in front of it. `<html>` is only the fallback
 * (`null` when even that is absent — the caller inserts after the doctype).
 */
export function findHeadInsertion(html: string): HeadInsertion | null {
  let htmlAt: number | null = null;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      i = skipPast(html, lt + 4, "-->");
      continue;
    }
    if (html.startsWith("<![CDATA[", lt)) {
      i = skipPast(html, lt + 9, "]]>");
      continue;
    }
    const after = html[lt + 1];
    if (after === "!" || after === "?") {
      i = tagEnd(html, lt + 1);
      continue;
    }
    const name = /^<(\/?)([a-zA-Z][^\s/>]*)/.exec(html.slice(lt, lt + 64));
    if (!name) {
      i = lt + 1;
      continue;
    }
    const closing = name[1] === "/";
    const tag = name[2]!.toLowerCase();
    const end = tagEnd(html, lt + 1);
    if (!closing && RAW_TEXT.has(tag)) {
      const close = new RegExp(`</${tag}(?=[\\s/>])`, "i").exec(html.slice(end));
      i = close ? end + close.index + close[0].length : html.length;
      continue;
    }
    if (!closing) {
      if (tag === "head") return { kind: "in-head", at: end };
      if (tag === "body") return { kind: "new-head", at: lt };
      if (tag === "html") htmlAt = end;
    }
    i = end;
  }
  return htmlAt === null ? null : { kind: "new-head", at: htmlAt };
}

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
    const found = findHeadInsertion(html);
    if (found?.kind === "in-head") {
      return html.slice(0, found.at) + block + html.slice(found.at);
    }
    const doctype = LEADING_DOCTYPE_RE.exec(html);
    const at = found ? found.at : doctype ? doctype[0].length : 0;
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
    // The consent dialog lives on this page: it must not be framed, and its
    // type must not be sniffed. (The frame origin gets its own headers in
    // `mountFrameRoutes`; this is the same posture for the decision surface.)
    return c.html(renderShellPage(boot), 200, {
      "content-security-policy": "frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    });
  });

  app.get("/", (c) => c.text("claude-artifact-harness: open /a/<artifactId>"));

  mountAdminApi(app, ctx);
}

export function mountFrameRoutes(app: FrameApp, ctx: ServerContext): void {
  app.use("*", async (c, next) => {
    const id = artifactIdFrom(c.req.header("host"), c.req.header("x-artifact-id"));
    const meta = id ? await ctx.store.readMeta(id) : null;
    // `connect-src` comes from the `network` slice's validator, not from the
    // raw declaration: the declared strings land inside a security header, so
    // they are re-emitted from `URL.origin` and capped there (network/server.ts).
    c.header(
      "content-security-policy",
      frameCsp(ctx.shellOrigin, connectSrcOrigins(meta?.capabilities)),
    );
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
    const external = ctx.config.runtimeDir;
    if (external) {
      // Conformance mode: any module of the foreign runtime, by its own name.
      if (!/^[\w.-]+\.js$/.test(file) || file === "preamble.js") return c.text("not found", 404);
      let source: string;
      try {
        source = await readFile(join(external, file), "utf8");
      } catch {
        return c.text("not found", 404);
      }
      return c.body(source, 200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache",
      });
    }
    const allowed = new Set(Object.values(runtimeModuleMap()));
    if (!allowed.has(file)) return c.text("not found", 404);
    const source = await readDist(ctx, "runtime", file);
    if (source === null) return c.text(BUILD_HINT, 500);
    return c.body(source, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    });
  });

  // `/_blob/<id>` is served by the `assets` slice (mounted after these
  // routes). No placeholder here: Hono ends the chain at the first handler
  // that returns a response, so one registered before the slice would hide it.

  app.get("/_f/:ver", (c) => {
    // Preserve the query string: `__frame_t` lives there, and dropping it on
    // the trailing-slash redirect would silently anonymise the viewer.
    const search = new URL(c.req.url).search;
    return c.redirect(`${c.req.path}/${search}`);
  });

  app.get("/_f/:ver/*", async (c) => {
    const id = artifactIdFrom(c.req.header("host"), c.req.header("x-artifact-id"));
    if (!id) return c.text("no artifact for this host", 404);

    const version = c.req.param("ver");
    if (!isVersionId(version)) return c.text("not found", 404);
    const meta = await ctx.store.readMeta(id);
    if (!meta) return c.text("not found", 404);

    const prefix = `/_f/${version}/`;
    const rest = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "";
    let relative: string;
    try {
      relative = decodeURIComponent(rest) || "index.html";
    } catch {
      // A malformed percent-escape (e.g. a truncated UTF-8 sequence): no
      // valid path decodes to this, so it can only ever be a 404.
      return c.text("not found", 404);
    }
    const file = await ctx.store.readVersionFile(id, version, relative);
    if (!file) return c.text("not found", 404);

    if (DOCUMENT_CONTENT_TYPES.has(file.contentType.toLowerCase())) {
      let preambleSource: string | null;
      let preambleConfig: FramePreambleConfig;
      const external = ctx.config.runtimeDir;
      if (external) {
        // Conformance mode: the foreign runtime's own preamble and module map,
        // with only the allowed shell origin swapped for ours.
        try {
          preambleSource = await readFile(join(external, "preamble.js"), "utf8");
          const raw = JSON.parse(await readFile(join(external, "preamble-config.json"), "utf8")) as
            Record<string, unknown>;
          preambleConfig = { ...raw, v: 1, origins: [ctx.shellOrigin] } as FramePreambleConfig;
        } catch {
          return c.text(`the external runtime in ${external} is incomplete`, 500);
        }
      } else {
        preambleSource = await readDist(ctx, "frame", "preamble.js");
        if (preambleSource === null) return c.text(BUILD_HINT, 500);
        preambleConfig = {
          v: 1,
          capabilities: runtimeModuleMap(),
          origins: [ctx.shellOrigin],
        };
      }
      const html = buildEnvelope(file.body.toString("utf8"), { preambleConfig, preambleSource });
      return c.body(html, 200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
    }
    // Every other stored type is served, not enveloped: no preamble runs, so
    // there is no RTC lockdown and no __FRAME_PREAMBLE to gate script. A
    // writer-chosen type (SVG, XML, or an outright lie about a document)
    // must not be able to execute script if a viewer is navigated to it
    // directly, so it gets an unconditional sandbox added on top of the
    // frame's normal CSP — not in place of it, or `frame-ancestors`,
    // `default-src 'none'` and the rest would drop out too, letting any
    // origin frame the file or its document load arbitrary subresources
    // (subresource loads made *from within* the enveloped page are on
    // separate requests/responses and are unaffected by this header).
    // Script media types are the one exception: see SCRIPT_CONTENT_TYPES.
    const csp = frameCsp(ctx.shellOrigin, connectSrcOrigins(meta.capabilities));
    const contentTypeLower = file.contentType.toLowerCase();
    return c.body(new Uint8Array(file.body), 200, {
      "content-type": file.contentType,
      "content-security-policy": SCRIPT_CONTENT_TYPES.has(contentTypeLower) ? csp : `${csp}; sandbox`,
    });
  });
}
