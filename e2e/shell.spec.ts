/**
 * The shell page and frame preamble's own hardening: `/a/:id` sends
 * `cache-control: no-store` (it inlines the `__frame_t` asset token), and
 * the frame preamble strips that token from `location.search` once the
 * server has consumed it, so it doesn't linger in the address bar or
 * history.
 */
import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/index.ts";

let server: RunningServer;
let dataDir: string;

const OWNER_TOKEN = "shell-e2e-owner-token";
const HTML = "<!doctype html><html><head><title>shell</title></head><body>hi</body></html>";

async function createArtifact(): Promise<string> {
  const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify({ html: HTML, capabilities: {} }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

/** Pull `__SHELL_BOOT.frameUrl` out of the shell page's inlined boot record. */
async function frameUrlFor(id: string): Promise<string> {
  const response = await fetch(`${server.shellOrigin}/a/${id}`);
  const body = await response.text();
  const match = /window\.__SHELL_BOOT=(.*?)<\/script>/s.exec(body);
  if (!match) throw new Error("no __SHELL_BOOT in shell page");
  const boot = JSON.parse(match[1] as string) as { frameUrl: string };
  return boot.frameUrl;
}

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "shell-e2e-"));
  server = await startServer({
    shellPort: 0,
    framePort: 0,
    dataDir,
    ownerToken: OWNER_TOKEN,
  });
});

test.afterAll(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("/a/:id sends cache-control: no-store", async () => {
  const id = await createArtifact();
  const response = await fetch(`${server.shellOrigin}/a/${id}`);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("the preamble strips __frame_t from the frame's own URL", async ({ page }) => {
  const id = await createArtifact();
  const frameUrl = await frameUrlFor(id);
  expect(frameUrl).toContain("__frame_t=");

  await page.goto(frameUrl);
  // The preamble runs as the first script in `<head>`, ahead of any body
  // content, so by the time the document is idle the replaceState has run.
  await page.waitForLoadState("domcontentloaded");
  await expect.poll(() => new URL(page.url()).searchParams.has("__frame_t")).toBe(false);
  // The path itself is untouched — only the token query param is gone.
  expect(new URL(page.url()).pathname).toBe(new URL(frameUrl).pathname);
});
