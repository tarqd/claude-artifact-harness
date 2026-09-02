/**
 * Shell-origin routes that are not owned by any capability slice: `/login`
 * (owner login, `next=` redirect) and `/a/:id` (the shell page itself).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../src/server/index.ts";
import { resolveNextRedirect } from "../../src/server/serve.ts";

let server: RunningServer;
let dataDir: string;

const OWNER_TOKEN = "serve-server-owner-token";
const HTML = "<!doctype html><html><head><title>serve</title></head><body>hi</body></html>";

async function createArtifact(): Promise<string> {
  const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify({ html: HTML, capabilities: {} }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "serve-server-"));
  server = await startServer({
    shellPort: 0,
    framePort: 0,
    dataDir,
    ownerToken: OWNER_TOKEN,
  });
});

afterAll(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("GET /login?next=", () => {
  /** A same-origin `next` still redirects, whatever shape it takes. */
  it("honours a normal same-origin path", async () => {
    const response = await fetch(
      `${server.shellOrigin}/login?token=${OWNER_TOKEN}&next=${encodeURIComponent("/a/xyz")}`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    // The Location is the fully-resolved URL that was actually validated
    // (`target.href`), not the raw `next` string handed back verbatim — see
    // the CRLF-smuggling regression below for why that distinction matters.
    expect(response.headers.get("location")).toBe(`${server.shellOrigin}/a/xyz`);
  });

  it.each([
    // Protocol-relative: browsers resolve `//evil.com/x` against the current
    // scheme, so this is `https://evil.com/x` off-origin.
    "//evil.com/x",
    // Backslash: browsers normalise a leading `/\` the same as `//`.
    "/\\evil.com",
    // Absolute, explicitly off-origin.
    "https://evil.com",
  ])("rejects an off-origin next=%s and falls back to the default", async (next) => {
    const response = await fetch(
      `${server.shellOrigin}/login?token=${OWNER_TOKEN}&next=${encodeURIComponent(next)}`,
      { redirect: "manual" },
    );
    // No redirect at all: the login itself still succeeded (a valid owner
    // token was presented), it just doesn't send the browser off-origin.
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("logged in as the owner");
  });

  it("resolves a `..`-escaping path same-origin, as a safe absolute Location", async () => {
    // `new URL("/..//evil.com", shellOrigin)` resolves *same-origin*
    // (leading "/" makes it an absolute-path reference against the shell's
    // own host, not a new authority) but its `.pathname` alone is
    // `//evil.com` — protocol-relative if ever sent bare as a Location
    // header. Redirecting with `target.href` (the full absolute URL) rather
    // than reassembling from `.pathname` keeps this safe: the browser gets
    // an absolute, same-origin Location, never a protocol-relative one.
    const next = "/..//evil.com";
    const response = await fetch(
      `${server.shellOrigin}/login?token=${OWNER_TOKEN}&next=${encodeURIComponent(next)}`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith(server.shellOrigin)).toBe(true);
    expect(location.startsWith("//")).toBe(false);
  });

  it("still refuses an invalid token regardless of next=", async () => {
    const response = await fetch(
      `${server.shellOrigin}/login?token=wrong&next=${encodeURIComponent("//evil.com")}`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(403);
  });

  it("does not 500 when next= smuggles a CRLF header injection", async () => {
    // `new URL()` silently strips ASCII tab/CR/LF while parsing, so a
    // same-origin-looking `next` carrying a raw CRLF used to pass the
    // origin check and then be handed verbatim to `Headers.set`, which
    // throws on control characters — an unhandled exception -> HTTP 500.
    const next = "/a\r\nSet-Cookie: pwn=1";
    const response = await fetch(
      `${server.shellOrigin}/login?token=${OWNER_TOKEN}&next=${encodeURIComponent(next)}`,
      { redirect: "manual" },
    );
    expect(response.status).not.toBe(500);
    // The stripped-of-control-characters form resolves same-origin, so it
    // still redirects — just never with the raw string containing the CRLF.
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).not.toMatch(/\r|\n/);
  });
});

describe("resolveNextRedirect", () => {
  it("normalizes an implicit default port before comparing origins", () => {
    // `shellOrigin()` (src/server/config.ts) builds a raw `http://host:80`
    // template that is never port-normalized, while `new URL(...).origin`
    // always is (`"http://host"`). Comparing the un-normalized string against
    // a parsed URL's origin would never match on the default port, silently
    // dropping every next= — including this legitimate same-origin one.
    expect(resolveNextRedirect("/a/xyz", "http://localhost:80")).toBe("http://localhost/a/xyz");
  });

  it("still rejects an off-origin next= once the shell origin is normalized", () => {
    expect(resolveNextRedirect("https://evil.com", "http://localhost:80")).toBeNull();
  });
});

describe("GET /a/:id", () => {
  it("sends cache-control: no-store, so the inlined frame token isn't cached", async () => {
    const id = await createArtifact();
    const response = await fetch(`${server.shellOrigin}/a/${id}`, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
