/**
 * What each origin serves: the shell page and its bundle, the artifact
 * content with its injected envelope, `/_runtime/<name>.js`, `/_blob/<id>`,
 * and the CSP (design.md "Page envelope", surface-area.md §10). The string
 * builders at the top are pure, so they are unit-testable on their own.
 */
import type { Context, Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connectSrcOrigins } from "../capabilities/network/server.ts";
import { runtimeModuleMap } from "../protocol/capabilities.ts";
import { isArtifactId } from "../protocol/paths.ts";
import type { FramePreambleConfig } from "../protocol/messages.ts";
import type { ShellBoot } from "../shell/types.ts";
import { mountAdminApi } from "./admin.ts";
import { buildShellBoot } from "./boot.ts";
import { clientKey, RateLimiter } from "./ratelimit.ts";
import type { FrameApp, ServerContext } from "./types.ts";

/** The documented reset the platform prepends to author content. */
export const RESET_CSS = `:root{color-scheme:light}
body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}
img{max-width:100%}
[hidden]{display:none!important}`;

const DOCTYPE_RE = /^\s*<!doctype html/i;
const LEADING_DOCTYPE_RE = /^\s*<!doctype html[^>]*>/i;

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

/** Login attempts one address may make in a minute, right or wrong. */
export const LOGIN_ATTEMPTS_PER_WINDOW = 20;

/** Largest login body. The form has two short fields. */
const MAX_LOGIN_BODY_BYTES = 4096;

/** The login page and its answers: a decision surface, never framed or cached. */
const LOGIN_HEADERS = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
} as const;

const LOGIN_CSS = `:root{color-scheme:light dark}
body{margin:0;display:grid;place-items:center;min-height:100vh;background:#faf9f5;color:#141413;
font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}
@media (prefers-color-scheme:dark){body{background:#1f1e1d;color:#f5f4ef}}
form{display:grid;gap:8px;width:min(28rem,90vw)}
input,button{font:inherit;padding:8px;border-radius:6px;border:1px solid #8883}
.note{color:#a33;margin:0}`;

/**
 * The owner login form. `next` is echoed back into a hidden field (escaped)
 * so a link into a page survives the login, exactly as the query form did.
 */
export function renderLoginPage(next: string | undefined, message: string | null): string {
  const nextField = next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : "";
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>Owner login</title>" +
    `<style>${LOGIN_CSS}</style>` +
    '</head><body><form method="post" action="/login">' +
    "<h1>Owner login</h1>" +
    (message ? `<p class="note">${escapeHtml(message)}</p>` : "") +
    '<label for="token">Owner token (<code>ARTIFACT_OWNER_TOKEN</code>)</label>' +
    '<input id="token" name="token" type="password" autocomplete="current-password" required>' +
    nextField +
    '<button type="submit">Log in</button>' +
    "</form></body></html>"
  );
}

/**
 * The posted credential. Both spellings a client would reach for are read —
 * the form's `application/x-www-form-urlencoded` and `application/json` —
 * and nothing else, so a cross-site "simple" `text/plain` post never lands
 * here.
 *
 * Nothing is read until the length says it is small: a declared length is
 * required (every form and JSON post carries one) and capped, and since the
 * length is what frames the body on the wire, a client cannot then send more
 * than it declared. A chunked body, which declares nothing, is refused.
 */
async function readLoginBody(
  c: Context,
): Promise<{ token: string; next?: string } | { error: string; status: 400 | 411 | 413 | 415 }> {
  const length = c.req.header("content-length");
  const declared = length === undefined ? NaN : Number(length);
  if (!Number.isInteger(declared) || declared < 0) {
    return { error: "a content-length is required", status: 411 };
  }
  if (declared > MAX_LOGIN_BODY_BYTES) {
    return { error: "the request body is too large", status: 413 };
  }
  const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded" && type !== "application/json") {
    return { error: "post the token as a form or as JSON", status: 415 };
  }
  const raw = await c.req.text();
  let token: unknown;
  let next: unknown;
  if (type === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { error: "bad request body", status: 400 };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { error: "bad request body", status: 400 };
    }
    ({ token, next } = parsed as { token?: unknown; next?: unknown });
  } else {
    const fields = new URLSearchParams(raw);
    token = fields.get("token") ?? undefined;
    next = fields.get("next") ?? undefined;
  }
  if (typeof token !== "string") return { error: "bad request body", status: 400 };
  return typeof next === "string" ? { token, next } : { token };
}

export function mountShellRoutes(app: Hono, ctx: ServerContext): void {
  // Guessing the owner token is the one credential attack this server has,
  // and it is a single secret: a browser logs in once, so a per-address
  // budget costs a real operator nothing and ends offline-speed guessing.
  const loginLimit = new RateLimiter(LOGIN_ATTEMPTS_PER_WINDOW);

  /**
   * The form. It carries no token itself, so this page is safe to link, to
   * bookmark and to log — which is the whole point of it existing.
   */
  const loginPage = (c: Context, message: string | null, status: 200 | 400) =>
    c.html(renderLoginPage(c.req.query("next"), message), status, LOGIN_HEADERS);

  app.get("/login", (c) => {
    // A token in a query string is written to proxy and access logs and kept
    // in browser history, so it is refused rather than honoured: the form
    // below posts it in a body instead. The token in the URL the operator
    // just used should be treated as burned and rotated.
    if (c.req.query("token") !== undefined) {
      return loginPage(c, "The owner token must not travel in a URL - paste it here instead.", 400);
    }
    return loginPage(c, null, 200);
  });

  app.post("/login", async (c) => {
    if (!loginLimit.allow(clientKey(c))) {
      return c.text("too many login attempts - wait a minute", 429, LOGIN_HEADERS);
    }
    // A login is state-changing and cookie-setting, so it is accepted only
    // from this origin (or from a bare client, which sends neither header).
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    if (
      (origin !== undefined && origin !== ctx.shellOrigin) ||
      (site !== undefined && site !== "same-origin" && site !== "none")
    ) {
      return c.text("cross-site login is refused", 403, LOGIN_HEADERS);
    }
    const body = await readLoginBody(c);
    if ("error" in body) return c.text(body.error, body.status, LOGIN_HEADERS);
    if (!ctx.auth.login(c, body.token)) return c.text("invalid owner token", 403, LOGIN_HEADERS);
    const next = body.next ?? c.req.query("next");
    if (next && next.startsWith("/")) return c.redirect(next, 303);
    return c.text("logged in as the owner", 200, LOGIN_HEADERS);
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
    return c.body(new Uint8Array(file.body), 200, { "content-type": file.contentType });
  });
}
