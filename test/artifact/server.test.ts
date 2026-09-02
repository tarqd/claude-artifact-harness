/**
 * Integration: the two real Hono apps, over real sockets, without a browser.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type IncomingHttpHeaders } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../src/server/index.ts";

let server: RunningServer;
let readOnly: RunningServer;
let closed: RunningServer;
let dataDir: string;
let fixture: string;

async function create(
  target: RunningServer,
  capabilities: Record<string, unknown> = { artifact: {} },
): Promise<{ id: string; version: string }> {
  const response = await fetch(`${target.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ html: fixture, capabilities }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; version: string };
}

/** A raw GET so the `Host` header (the artifact's origin) can be set exactly. */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

/** Reach the frame origin without wildcard DNS, via the `/_a/<id>/` form. */
function frameUrl(target: RunningServer, id: string, path: string): string {
  return `http://127.0.0.1:${target.framePort}/_a/${id}${path}`;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "artifact-server-"));
  fixture = await readFile("fixtures/artifact.html", "utf8");
  // An open dev box: the admin API takes no credential and every viewer is
  // an admin, which is the only non-owner level that may write.
  server = await startServer({
    shellPort: 0,
    framePort: 0,
    dataDir,
    defaultLevel: "admin",
    openAdminApi: true,
    // Tooling reaches the frame origin without wildcard DNS; opt in for it.
    allowPrefixHosts: true,
  });
  readOnly = await startServer({
    shellPort: 0,
    framePort: 0,
    dataDir,
    defaultLevel: "view",
    openAdminApi: true,
    allowPrefixHosts: true,
  });
  closed = await startServer({ shellPort: 0, framePort: 0, dataDir });
});

afterAll(async () => {
  await Promise.all([server.close(), readOnly.close(), closed.close()]);
  await rm(dataDir, { recursive: true, force: true });
});

describe("shell origin", () => {
  it("serves a shell page carrying the boot record and a tokenised frame URL", async () => {
    const artifact = await create(server);
    const html = await (await fetch(`${server.shellOrigin}/a/${artifact.id}`)).text();
    expect(html).toContain("window.__SHELL_BOOT=");
    expect(html).toContain('<script src="/_shell/shell.js" defer></script>');
    const boot = JSON.parse(
      /__SHELL_BOOT=(\{.*?\})<\/script>/s.exec(html)![1]!.replaceAll("\\u003c", "<"),
    ) as { frameUrl: string; capabilities: Record<string, unknown>; flags: string[] };
    expect(boot.frameUrl).toContain(`${artifact.id}.localhost:${server.framePort}/_f/v1/`);
    expect(boot.frameUrl).toContain("__frame_t=");
    expect(boot.capabilities).toEqual({ artifact: { config: {} } });
    expect(boot.flags).toEqual(["artifact_files"]);
  });

  it("gives a read-only viewer no artifact_files flag", async () => {
    const artifact = await create(readOnly);
    const html = await (await fetch(`${readOnly.shellOrigin}/a/${artifact.id}`)).text();
    const boot = JSON.parse(
      /__SHELL_BOOT=(\{.*?\})<\/script>/s.exec(html)![1]!.replaceAll("\\u003c", "<"),
    ) as { flags: string[]; viewer: { canEdit: boolean; level: string } };
    expect(boot.flags).toEqual([]);
    expect(boot.viewer).toMatchObject({ canEdit: false, level: "view" });
  });

  it("serves the shell page with a no-framing policy", async () => {
    const artifact = await create(server);
    const response = await fetch(`${server.shellOrigin}/a/${artifact.id}`);
    expect(response.status).toBe(200);
    // The consent dialog lives on this page; it must not be framed.
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps the artifact record behind the admin guard", async () => {
    const artifact = await create(server);
    // The record names the owner and lists the version's files.
    const open = await fetch(`${server.shellOrigin}/api/artifacts/${artifact.id}`);
    expect(open.status).toBe(200);
    expect((await open.json()) as { files: string[] }).toMatchObject({ files: ["index.html"] });

    // The same record on a server with no credential: refused, not leaked.
    const refused = await fetch(`${closed.shellOrigin}/api/artifacts/${artifact.id}`);
    expect(refused.status).toBe(403);
    const body = await refused.text();
    expect(body).not.toContain("index.html");
    expect(body).not.toMatch(/u_[A-Za-z0-9]{22}/); // the owner's viewer id

    // The version poll stays open: it drives live reload and says nothing else.
    const version = await fetch(`${closed.shellOrigin}/api/artifacts/${artifact.id}/version`);
    expect(version.status).toBe(200);
    expect(Object.keys((await version.json()) as object).sort()).toEqual([
      "updatedAt",
      "version",
    ]);
  });

  it("refuses the admin API with no credential unless it was opened", async () => {
    const response = await fetch(`${closed.shellOrigin}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html: fixture, capabilities: { artifact: {} } }),
    });
    expect(response.status).toBe(403);
  });

  it("resolves the legacy `self` declaration to the artifact capability", async () => {
    const artifact = await create(server, { self: {} });
    const html = await (await fetch(`${server.shellOrigin}/a/${artifact.id}`)).text();
    const boot = JSON.parse(
      /__SHELL_BOOT=(\{.*?\})<\/script>/s.exec(html)![1]!.replaceAll("\\u003c", "<"),
    ) as { capabilities: Record<string, unknown> };
    expect(boot.capabilities).toEqual({ artifact: { config: {} } });
  });

  it("404s an unknown artifact and rejects a malformed id", async () => {
    expect((await fetch(`${server.shellOrigin}/a/${"0".repeat(32)}`)).status).toBe(404);
    expect((await fetch(`${server.shellOrigin}/a/nope`)).status).toBe(404);
  });
});

describe("frame origin", () => {
  it("injects the preamble and serves the runtime modules under the CSP", async () => {
    const artifact = await create(server);
    const response = await fetch(frameUrl(server, artifact.id, "/_f/v1/"));
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`frame-ancestors ${server.shellOrigin}`);
    expect(csp).toContain("img-src 'self' data: blob:");
    const html = await response.text();
    expect(html).toContain("window.__FRAME_PREAMBLE=");
    expect(html).toContain('"artifact":"artifact.js"');
    expect(html).toContain("app-script");

    const module = await fetch(frameUrl(server, artifact.id, "/_runtime/db.js"));
    expect(module.status).toBe(200);
    expect(module.headers.get("content-type")).toContain("text/javascript");
    expect((await fetch(frameUrl(server, artifact.id, "/_runtime/evil.js"))).status).toBe(404);
  });

  it("never serves another artifact from this artifact's origin", async () => {
    const mine = await create(server);
    const other = await create(server);
    const host = { host: `${mine.id}.localhost:${server.framePort}` };

    const own = await rawGet(server.framePort, "/_f/v1/index.html", host);
    expect(own.status).toBe(200);

    // The `/_a/<id>/` prefix form is for hosts with no artifact label only.
    const prefixed = await rawGet(
      server.framePort,
      `/_a/${other.id}/_f/v1/index.html`,
      host,
    );
    expect(prefixed.status).toBe(404);

    // The prefix form is off unless a server opts into it: every artifact
    // reached that way would otherwise share one browser origin.
    const bare = { host: `127.0.0.1:${closed.framePort}` };
    const offByDefault = await rawGet(
      closed.framePort,
      `/_f/v1/index.html`,
      bare,
    );
    expect(offByDefault.status).toBe(404);
    expect(
      (await rawGet(closed.framePort, `/_a/${mine.id}/_f/v1/index.html`, bare)).status,
    ).toBe(404);
    expect(
      (await rawGet(closed.framePort, `/_a/${mine.id}/_blob/${"a".repeat(32)}`, bare)).status,
    ).toBe(404);
    expect(
      (await rawGet(server.framePort, `/_a/${mine.id}/_f/v1/index.html`, {
        host: `127.0.0.1:${server.framePort}`,
      })).status,
    ).toBe(200);

    // A client-supplied `x-artifact-id` never overrides the host label.
    const forged = await rawGet(server.framePort, "/_f/v1/index.html", {
      ...host,
      "x-artifact-id": other.id,
    });
    expect(forged.status).toBe(200);
    expect(forged.body).toBe(own.body);
  });

  it("injects the preamble past a decoy <head> in a comment", async () => {
    // What `publish(html)` may legitimately send: a licence comment first.
    const page =
      "<!doctype html><!-- <head>decoy</head> --><html><head><title>T</title></head>" +
      "<body><p>x</p></body></html>";
    const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html: page, capabilities: { artifact: {} } }),
    });
    const artifact = (await response.json()) as { id: string; version: string };
    const html = await (
      await fetch(frameUrl(server, artifact.id, `/_f/${artifact.version}/index.html`))
    ).text();
    expect(html).toContain("<!-- <head>decoy</head> -->");
    // In the document's real head, before the author's own head content.
    expect(html).toContain("<html><head><script>window.__FRAME_PREAMBLE=");
    expect(html.indexOf("__FRAME_PREAMBLE")).toBeLessThan(html.indexOf("<title>T"));
  });

  it("refuses a forged asset token, and leaves /_blob to the assets slice", async () => {
    const artifact = await create(server);
    const forged = await fetch(frameUrl(server, artifact.id, "/_f/v1/?__frame_t=nope.nope"));
    expect(forged.status).toBe(403);
    // No spine placeholder holds this path any more: the `assets` slice's own
    // route answers, and an id it has never stored is a plain 404.
    const blob = await fetch(frameUrl(server, artifact.id, `/_blob/${"a".repeat(32)}`));
    expect(blob.status).toBe(404);
  });

  it("404s a malformed /_f path instead of 500ing", async () => {
    const artifact = await create(server);
    const host = { host: `${artifact.id}.localhost:${server.framePort}` };
    // A truncated percent-escape: decodeURIComponent throws a URIError.
    expect((await rawGet(server.framePort, "/_f/v1/%E0%A4", host)).status).toBe(404);
    // A version id outside the version grammar.
    expect((await rawGet(server.framePort, "/_f/v1!/index.html", host)).status).toBe(404);
    // An encoded traversal in the version segment.
    expect(
      (await rawGet(server.framePort, "/_f/..%2F..%2F/index.html", host)).status,
    ).toBe(404);
  });

  it("preserves the query string on the /_f/<ver> -> /_f/<ver>/ redirect", async () => {
    const artifact = await create(server);
    // The host-label form, not the `/_a/<id>` prefix: the prefix form is
    // rewritten to a bare path before this handler ever sees it (server's
    // `frameFetch`), so a Location built from `c.req.path` there necessarily
    // drops the `/_a/<id>` prefix — a separate, pre-existing gap this fix
    // doesn't reach. On the host-label form there is no prefix to lose, so
    // the redirect is exactly the case #29 asks for: same path, `+/`, query
    // string intact.
    const host = { host: `${artifact.id}.localhost:${server.framePort}` };
    // Not a real `__frame_t` (that goes through the asset-token check first,
    // before this handler even runs) — any query string must survive.
    const response = await rawGet(server.framePort, "/_f/v1?foo=bar", host);
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/_f/v1/?foo=bar");
  });

  it("envelopes TEXT/HTML and application/xhtml+xml but sandboxes everything else", async () => {
    const artifact = await create(server);
    const publish = await fetch(`${server.shellOrigin}/api/frame/self/${artifact.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseVersion: "v1",
        files: {
          "y.html": { content: "<p>y</p>", contentType: "TEXT/HTML" },
          "p.xhtml": { content: "<p>p</p>", contentType: "application/xhtml+xml" },
          "a.svg": { content: "<svg onload=\"alert(1)\"></svg>", contentType: "image/svg+xml" },
          "w.js": { content: "postMessage('hi')", contentType: "text/javascript" },
        },
      }),
    });
    expect(publish.status).toBe(200);
    const { version } = (await publish.json()) as { version: string };

    const html = await fetch(frameUrl(server, artifact.id, `/_f/${version}/y.html`));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toContain("frame-ancestors");
    expect(await html.text()).toContain("window.__FRAME_PREAMBLE=");

    const xhtml = await fetch(frameUrl(server, artifact.id, `/_f/${version}/p.xhtml`));
    expect(await xhtml.text()).toContain("window.__FRAME_PREAMBLE=");

    const svg = await fetch(frameUrl(server, artifact.id, `/_f/${version}/a.svg`));
    expect(svg.status).toBe(200);
    // No preamble runs for a non-document type, so it gets an unconditional
    // `sandbox` — but layered on top of the frame's normal CSP, not in place
    // of it: `frame-ancestors` (and `default-src 'none'` etc.) must survive,
    // or any origin could frame the file and any directly-navigated document
    // type could load arbitrary external subresources.
    const svgCsp = svg.headers.get("content-security-policy");
    expect(svgCsp).toContain("sandbox");
    expect(svgCsp).toContain("frame-ancestors");
    expect(svgCsp).toContain("default-src 'none'");
    const svgBody = await svg.text();
    expect(svgBody).not.toContain("__FRAME_PREAMBLE");
    expect(svgBody).toContain("onload");

    // A stored script file is the one non-document type exempted from the
    // sandbox suffix: CSP sandbox gives a `new Worker(...)` response an
    // opaque origin (the platform enforces sandbox for worker scripts too),
    // which would break `new Worker('/_f/<ver>/w.js')` for an artifact that
    // ships a worker. It still keeps the rest of the frame's CSP.
    const js = await fetch(frameUrl(server, artifact.id, `/_f/${version}/w.js`));
    expect(js.status).toBe(200);
    const jsCsp = js.headers.get("content-security-policy");
    expect(jsCsp).not.toContain("sandbox");
    expect(jsCsp).toContain("frame-ancestors");
    expect(jsCsp).toContain("default-src 'none'");
  });
});

describe("publish endpoint (the artifact broker's backend)", () => {
  it("mints versions and maps a stale base version to 409 conflict", async () => {
    const artifact = await create(server);
    const publish = (baseVersion: string, n: number): Promise<Response> =>
      fetch(`${server.shellOrigin}/api/frame/self/${artifact.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseVersion,
          html: `<!doctype html><html><head><title>v${n}</title></head><body>${n}</body></html>`,
        }),
      });

    const first = await publish("v1", 2);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ version: "v2" });

    const stale = await publish("v1", 3);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "conflict", live: "v2" });

    const live = await fetch(`${server.shellOrigin}/api/artifacts/${artifact.id}/version`);
    expect(await live.json()).toMatchObject({ version: "v2" });
  });

  it("refuses an anonymous `interact` viewer with not_writer", async () => {
    const artifact = await create(server);
    const response = await fetch(`${closed.shellOrigin}/api/frame/self/${artifact.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: "v1", html: "<!doctype html><html></html>" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "not_writer" });
  });

  it("refuses a read-only viewer with not_writer", async () => {
    const artifact = await create(readOnly);
    const response = await fetch(`${readOnly.shellOrigin}/api/frame/self/${artifact.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: "v1", html: "<!doctype html><html></html>" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "not_writer" });
  });

  it("refuses an artifact that no longer declares the capability", async () => {
    const artifact = await create(server, {});
    const response = await fetch(`${server.shellOrigin}/api/frame/self/${artifact.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: "v1", html: "<!doctype html><html></html>" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "not_declared" });
  });

  it("refuses content that is not a document", async () => {
    const artifact = await create(server);
    const response = await fetch(`${server.shellOrigin}/api/frame/self/${artifact.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: "v1", html: "<h1>fragment</h1>" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_content" });
  });

  it("requires baseVersion: omitting it does not silently pass compare-and-set", async () => {
    const artifact = await create(server);
    const response = await fetch(`${server.shellOrigin}/api/frame/self/${artifact.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html: "<!doctype html><html><body>no base</body></html>" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_content" });
    // Nothing was published: the artifact is still on v1.
    const live = await fetch(`${server.shellOrigin}/api/artifacts/${artifact.id}/version`);
    expect(await live.json()).toMatchObject({ version: "v1" });
  });

  it("refuses a files contentType with CR/LF or parameters, before it can ever 500 a later GET", async () => {
    const artifact = await create(server);
    const crlf = await fetch(`${server.shellOrigin}/api/frame/self/${artifact.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseVersion: "v1",
        files: { "x.txt": { content: "x", contentType: "text/plain\r\nx-evil: 1" } },
      }),
    });
    expect(crlf.status).toBe(400);
    expect(await crlf.json()).toMatchObject({ code: "invalid_content" });

    const withParams = await fetch(`${server.shellOrigin}/api/frame/self/${artifact.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseVersion: "v1",
        files: { "x.txt": { content: "x", contentType: "text/plain;charset=utf-8" } },
      }),
    });
    expect(withParams.status).toBe(400);
    expect(await withParams.json()).toMatchObject({ code: "invalid_content" });
  });

  it("refuses a files publish that targets a <path>.type sidecar directly, end to end", async () => {
    // Publishing the sidecar path itself is the vector `decodeFiles`'s
    // contentType grammar doesn't reach: it validates the field named
    // `contentType`, not a raw file whose own path happens to end in
    // `.type`. Without the store-level rejection, this would 200, and every
    // later GET of index.html would 500 (an invalid value handed straight to
    // `Headers.set`) instead of serving the page.
    const artifact = await create(server);
    const poison = await fetch(`${server.shellOrigin}/api/frame/self/${artifact.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseVersion: "v1",
        files: {
          "index.html.type": { content: "text/plain\r\nx-evil: 1", contentType: "text/plain" },
        },
      }),
    });
    expect(poison.status).toBe(400);
    expect(await poison.json()).toMatchObject({ code: "invalid_content" });

    // index.html still serves normally: no sidecar was written.
    const page = await fetch(frameUrl(server, artifact.id, "/_f/v1/index.html"));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("window.__FRAME_PREAMBLE=");
  });
});
