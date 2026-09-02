/**
 * The frame preamble's own hardening: it strips the `__frame_t` asset token
 * from `location.search` once the server has consumed it, so it doesn't
 * linger in the address bar, `document.referrer` or browser history. Driven
 * through the real embedded iframe (not a top-level `page.goto`) because
 * `replaceState` is sandbox-sensitive — it throws in an opaque-origin frame,
 * which the preamble silently swallows — so only the actual `allow-scripts
 * allow-same-origin` embedding proves the strip does anything.
 *
 * (`/a/:id`'s `cache-control: no-store` header — the other half of the same
 * hardening — is covered by `test/server/serve.test.ts`; no need to spend a
 * browser on a header a plain `fetch` already checks.)
 */
import { expect, test, type Page } from "@playwright/test";
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

/** The shell's own embedded iframe, once the handshake has revealed it. */
async function open(page: Page, id: string): Promise<void> {
  await page.goto(`${server.shellOrigin}/a/${id}`);
  await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 15_000 });
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

test("the preamble strips __frame_t from the embedded frame's own URL", async ({ page }) => {
  const id = await createArtifact();
  await open(page, id);

  // The shell's own sandboxed iframe (`allow-scripts allow-same-origin`,
  // `src/shell/host.ts`), not a top-level navigation to the frame URL: only
  // this embedding exercises the sandbox attributes the strip runs under.
  //
  // The `src` attribute the shell set on the `<iframe>` element still shows
  // the original, token-bearing URL — `history.replaceState` inside the
  // child document doesn't rewrite its parent's DOM attribute — so it's the
  // "before" half of the assertion; the frame's own live `location.search`
  // (queried via Playwright's `Frame`, which tracks the child document's
  // real navigation state) is the "after" half.
  const iframeSrc = await page.locator("iframe#frame-content").getAttribute("src");
  const originalUrl = new URL(iframeSrc ?? "", server.shellOrigin);
  expect(originalUrl.searchParams.has("__frame_t")).toBe(true);

  const frames = page.frames().filter((f) => f !== page.mainFrame());
  expect(frames).toHaveLength(1);
  const frameEl = frames[0]!;
  // Confirmed via the frame's own document, not just its outer `src` — this
  // is what `location.search` reads in a page script trying to exfiltrate
  // the token, and `replaceState` runs asynchronously enough (first script
  // in `<head>`, but still after navigation) to need a poll.
  await expect
    .poll(() => frameEl.evaluate(() => location.search))
    .not.toContain("__frame_t");
  // The strip must touch only `search`: confirm the path (`/_f/<ver>/...`,
  // taken from the original `src`) is still exactly what it was, so a
  // regression that rewrote the path along with stripping the token would
  // be caught here too.
  expect(await frameEl.evaluate(() => location.pathname)).toBe(originalUrl.pathname);
});
