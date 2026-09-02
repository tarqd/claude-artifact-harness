/**
 * Shell-origin routes that are not owned by any capability slice: `/login`
 * (owner login, `next=` redirect) and `/a/:id` (the shell page itself).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../src/server/index.ts";

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
    expect(response.headers.get("location")).toBe("/a/xyz");
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

  it("still refuses an invalid token regardless of next=", async () => {
    const response = await fetch(
      `${server.shellOrigin}/login?token=wrong&next=${encodeURIComponent("//evil.com")}`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(403);
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
