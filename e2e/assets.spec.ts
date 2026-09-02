/**
 * `assets` end to end: a page uploads a canvas PNG, renders it back from
 * `/_blob/<id>` on its own origin, lists it with its usage, and deletes it —
 * through the real shell, the real broker and the real server.
 *
 * The boundary this spec exists for: another artifact's origin cannot fetch
 * the blob, even knowing its id.
 */
import { expect, test, type Frame, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/index.ts";

let server: RunningServer;
let dataDir: string;

const OWNER_TOKEN = "assets-e2e-owner-token";

async function createArtifact(): Promise<string> {
  const html = await readFile("fixtures/assets.html", "utf8");
  const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify({ html, capabilities: { assets: {} } }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

/** The frame origin from outside the browser: the `/_a/<id>/` prefix form. */
function blobUrlFor(artifactId: string, blobId: string): string {
  return `http://127.0.0.1:${server.framePort}/_a/${artifactId}/_blob/${blobId}`;
}

const idOf = (url: string): string => url.slice("/_blob/".length);

function frame(page: Page) {
  return page.frameLocator("#frame-content");
}

/** The artifact's own document, for evaluating script on its origin. */
function content(page: Page): Frame {
  const found = page.frames().find((f) => f.url().includes("/_f/"));
  expect(found).toBeTruthy();
  return found!;
}

async function open(page: Page, artifactId: string, asOwner = true): Promise<void> {
  if (asOwner) await page.goto(`${server.shellOrigin}/login?token=${OWNER_TOKEN}`);
  await page.goto(`${server.shellOrigin}/a/${artifactId}`);
  await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 15_000 });
  await expect(frame(page).locator("#ns")).toHaveAttribute("data-state", "resolved", {
    timeout: 15_000,
  });
}

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "assets-e2e-"));
  server = await startServer({
    shellPort: 0,
    framePort: 0,
    dataDir,
    versionPollMs: 0,
    ownerToken: OWNER_TOKEN,
    // The out-of-browser blob fetches below use the tooling prefix form.
    allowPrefixHosts: true,
  });
});

test.afterAll(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a page uploads a canvas PNG, renders it from /_blob and lists it", async ({ page, context }) => {
  const artifact = await createArtifact();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await open(page, artifact);
  await expect(frame(page).locator("#ns")).toHaveAttribute("data-assets", "yes");

  /* ------------------------------- upload ------------------------------- */

  await frame(page).locator("#upload").click();
  const uploaded = frame(page).locator("#uploaded");
  await expect(uploaded).toHaveAttribute("data-state", "ok", { timeout: 20_000 });
  await expect(frame(page).locator("#status")).toHaveAttribute("data-code", "ok");
  await expect(uploaded).toHaveAttribute("data-type", "image/png");

  const pngUrl = (await uploaded.getAttribute("data-url"))!;
  const pngId = (await uploaded.getAttribute("data-id"))!;
  expect(pngUrl).toBe(`/_blob/${pngId}`);
  expect(pngId).toMatch(/^[0-9a-f]{32}$/);
  expect(Number(await uploaded.getAttribute("data-size"))).toBeGreaterThan(0);

  /* ---------------------- the page renders it back ---------------------- */

  await expect(frame(page).locator("#shot")).toHaveAttribute("data-state", "loaded", {
    timeout: 20_000,
  });
  const painted = await content(page).evaluate(() => {
    const img = document.getElementById("shot") as HTMLImageElement;
    return { width: img.naturalWidth, height: img.naturalHeight, src: img.src };
  });
  expect(painted.width).toBe(120);
  expect(painted.height).toBe(60);
  // The url is relative: it resolved against the artifact's own origin.
  expect(painted.src).toBe(`${server.frameOriginFor(artifact)}${pngUrl}`);

  /* -------------------------------- list -------------------------------- */

  await frame(page).locator("#list").click();
  await expect(frame(page).locator("#count")).toHaveAttribute("data-count", "1");
  await expect(frame(page).locator("#usage")).toHaveAttribute("data-count", "1");
  expect(
    Number(await frame(page).locator("#usage").getAttribute("data-bytes")),
  ).toBeGreaterThan(0);

  /* ---------------------- served with the right headers ------------------ */

  const direct = await fetch(blobUrlFor(artifact, pngId));
  expect(direct.status).toBe(200);
  expect(direct.headers.get("content-type")).toBe("image/png");
  expect(direct.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(direct.headers.get("x-content-type-options")).toBe("nosniff");

  /* ------------------- another artifact cannot fetch it ------------------ */

  const other = await createArtifact();
  expect((await fetch(blobUrlFor(other, pngId))).status).toBe(404);

  // The same check from a real browser on the other artifact's origin.
  const otherPage = await context.newPage();
  await open(otherPage, other, false);
  const stolen = await content(otherPage).evaluate(
    (url) => fetch(url).then((r) => r.status, () => -1),
    pngUrl,
  );
  expect(stolen).toBe(404);
  // ...while its own origin still serves it.
  const own = await content(page).evaluate(
    (url) => fetch(url).then((r) => r.status, () => -1),
    pngUrl,
  );
  expect(own).toBe(200);
  await otherPage.close();

  /* ------------------- a second upload, then a delete -------------------- */

  await frame(page).locator("#upload-typed").click();
  await expect(frame(page).locator("#status")).toHaveAttribute("data-op", "upload-typed");
  await expect(frame(page).locator("#status")).toHaveAttribute("data-code", "ok");
  await expect(uploaded).toHaveAttribute("data-type", "text/csv");
  const csvUrl = (await uploaded.getAttribute("data-url"))!;

  await frame(page).locator("#list").click();
  await expect(frame(page).locator("#count")).toHaveAttribute("data-count", "2");

  await frame(page).locator("#delete").click();
  await expect(frame(page).locator("#status")).toHaveAttribute("data-op", "delete");
  await expect(frame(page).locator("#status")).toHaveAttribute("data-code", "ok");

  expect((await fetch(blobUrlFor(artifact, idOf(csvUrl)))).status).toBe(404);
  expect((await fetch(blobUrlFor(artifact, pngId))).status).toBe(200);

  await frame(page).locator("#list").click();
  await expect(frame(page).locator("#count")).toHaveAttribute("data-count", "1");

  expect(errors).toEqual([]);
});

test("the documented refusals reach the page by code", async ({ page }) => {
  const artifact = await createArtifact();
  await open(page, artifact);
  const status = frame(page).locator("#status");

  for (const [button, code] of [
    ["#upload-bad-type", "unsupported_type"],
    ["#upload-big-svg", "too_large"],
    ["#upload-nonsense", "invalid_request"],
    ["#delete-nonsense", "invalid_request"],
  ] as const) {
    await frame(page).locator(button).click();
    await expect(status).toHaveAttribute("data-state", "rejected", { timeout: 20_000 });
    await expect(status).toHaveAttribute("data-code", code);
  }

  // Nothing was stored by any of them.
  await frame(page).locator("#list").click();
  await expect(frame(page).locator("#count")).toHaveAttribute("data-count", "0");
});

test("a viewer who cannot write may list but not upload", async ({ page }) => {
  const artifact = await createArtifact();
  // No `/login`: this browser is an ordinary visitor, not the owner.
  await open(page, artifact, false);

  await frame(page).locator("#upload").click();
  const status = frame(page).locator("#status");
  await expect(status).toHaveAttribute("data-state", "rejected", { timeout: 20_000 });
  await expect(status).toHaveAttribute("data-code", "upstream_error");

  await frame(page).locator("#list").click();
  await expect(status).toHaveAttribute("data-code", "ok");
  await expect(frame(page).locator("#count")).toHaveAttribute("data-count", "0");
});
