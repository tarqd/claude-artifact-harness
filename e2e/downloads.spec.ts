/**
 * `downloads` end to end, through the real server, shell and frame:
 *
 * - a page generates a CSV and a PNG and offers each one; the shell asks the
 *   viewer with the FINAL filename and the size, over an inert iframe, and
 *   only an accepted prompt becomes a real browser download;
 * - the refusals a page must be able to read: `declined`, `rejected_extension`,
 *   `bad_request`, `too_large`, `rate_limited` (a prompt is already open) and
 *   `extension_not_enabled` on a view whose second extension list is off;
 * - and the ArrayBuffer the contract says is transferred, which the page sees
 *   detached the moment the call is made.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/index.ts";

let server: RunningServer;
let dataDir: string;
let fixture: string;

const OWNER_TOKEN = "e2e-downloads-token";

interface Created {
  id: string;
  version: string;
}

async function createArtifact(capabilities: Record<string, unknown>): Promise<Created> {
  const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify({ html: fixture, capabilities }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Created;
}

function frame(page: Page) {
  return page.frameLocator("#frame-content");
}

const dialog = (page: Page) => page.locator(".shell-consent");
const iframe = (page: Page) => page.locator("iframe#frame-content");
const status = (page: Page) => frame(page).locator("#status");

/** Open a view and wait for `use("downloads")` to have resolved. */
async function open(page: Page, id: string): Promise<void> {
  await page.goto(`${server.shellOrigin}/a/${id}`);
  await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 15_000 });
  await expect(frame(page).locator("#ns")).toHaveAttribute("data-state", "resolved", {
    timeout: 15_000,
  });
}

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "downloads-e2e-"));
  fixture = await readFile("fixtures/downloads.html", "utf8");
  server = await startServer({
    shellPort: 0,
    framePort: 0,
    dataDir,
    versionPollMs: 0,
    ownerToken: OWNER_TOKEN,
  });
});

test.afterAll(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a CSV and a PNG reach the viewer's disk, once the viewer says yes", async ({ page }) => {
  const artifact = await createArtifact({ downloads: {} });
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await open(page, artifact.id);
  await expect(frame(page).locator("#ns")).toHaveAttribute("data-downloads", "yes");
  // Nothing is asked, and nothing is saved, until the page offers something.
  await expect(dialog(page)).toHaveCount(0);

  /* ------------------------------ the CSV ------------------------------- */

  await frame(page).locator("#save-csv").click();

  // The prompt names the FINAL filename — the page asked for
  // "reports/summary.CSV" — and the size, over an inert iframe.
  await expect(dialog(page)).toHaveCount(1);
  await expect(dialog(page).locator("h2")).toHaveText("Save this file?");
  const body = await dialog(page).locator("p").textContent();
  expect(body).toMatch(/^This page wants to save "summary\.csv" \(\d+ bytes\) to your device\.$/);
  await expect(iframe(page)).toHaveJSProperty("inert", true);
  await expect(status(page)).toHaveAttribute("data-state", "saving");

  const csvDownload = page.waitForEvent("download");
  await dialog(page).getByRole("button", { name: "Save" }).click();
  const csv = await csvDownload;

  expect(csv.suggestedFilename()).toBe("summary.csv");
  const csvPath = await csv.path();
  expect(await readFile(csvPath, "utf8")).toBe("region,units\nnorth,120\nsouth,88\neast,151\n");

  await expect(dialog(page)).toHaveCount(0);
  await expect(iframe(page)).toHaveJSProperty("inert", false);
  await expect(status(page)).toHaveAttribute("data-state", "saved");
  await expect(status(page)).toHaveAttribute("data-code", "saved");
  await expect(frame(page).locator("#saves")).toHaveAttribute("data-count", "1");

  /* ------------------------------ the PNG ------------------------------- */

  await frame(page).locator("#save-png").click();
  await expect(dialog(page)).toHaveCount(1);
  expect(await dialog(page).locator("p").textContent()).toContain('"chart.png"');

  const pngDownload = page.waitForEvent("download");
  await dialog(page).getByRole("button", { name: "Save" }).click();
  const png = await pngDownload;

  expect(png.suggestedFilename()).toBe("chart.png");
  const bytes = await readFile(await png.path());
  // A real PNG, drawn by the page: the eight-byte signature.
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  await expect(frame(page).locator("#saves")).toHaveAttribute("data-count", "2");

  expect(errors).toEqual([]);
});

test("an ArrayBuffer is transferred: the page's copy is detached", async ({ page }) => {
  const artifact = await createArtifact({ downloads: {} });
  await open(page, artifact.id);

  await frame(page).locator("#save-buffer").click();
  // The page sees the buffer detached immediately, long before the answer.
  await expect(frame(page).locator("#detached")).toHaveAttribute("data-value", "detached");

  const download = page.waitForEvent("download");
  await dialog(page).getByRole("button", { name: "Save" }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("bytes.txt");
  expect(await readFile(await saved.path(), "utf8")).toBe("transferred bytes");
});

test("cancelling the prompt is `declined`, and nothing is saved", async ({ page }) => {
  const artifact = await createArtifact({ downloads: {} });
  await open(page, artifact.id);

  const downloads: string[] = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));

  await frame(page).locator("#save-csv").click();
  await expect(dialog(page)).toHaveCount(1);
  await dialog(page).getByRole("button", { name: "Cancel" }).click();

  await expect(status(page)).toHaveAttribute("data-state", "rejected");
  await expect(status(page)).toHaveAttribute("data-code", "declined");
  await expect(dialog(page)).toHaveCount(0);
  await expect(iframe(page)).toHaveJSProperty("inert", false);
  await expect(frame(page).locator("#saves")).toHaveAttribute("data-count", "0");
  expect(downloads).toEqual([]);

  // A refusal is not remembered: the next offer asks again.
  await frame(page).locator("#save-csv").click();
  await expect(dialog(page)).toHaveCount(1);
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(status(page)).toHaveAttribute("data-code", "declined");
});

test("the refusals a page can read, none of which reach the viewer", async ({ page }) => {
  const artifact = await createArtifact({ downloads: {} });
  await open(page, artifact.id);

  // An extension on neither allowlist.
  await frame(page).locator("#save-bad").click();
  await expect(status(page)).toHaveAttribute("data-code", "rejected_extension");
  await expect(status(page)).toHaveText(/is not an allowed file extension/);

  // Empty data is a caller bug, caught in the frame without a round trip.
  await frame(page).locator("#save-empty").click();
  await expect(status(page)).toHaveAttribute("data-code", "bad_request");

  // Over 16 MiB.
  await frame(page).locator("#save-huge").click();
  await expect(status(page)).toHaveAttribute("data-code", "too_large");

  // None of that ever put a question in front of the viewer.
  await expect(dialog(page)).toHaveCount(0);
  await expect(frame(page).locator("#saves")).toHaveAttribute("data-count", "0");
});

test("a second save while a prompt is open is `rate_limited`, not a second prompt", async ({
  page,
}) => {
  const artifact = await createArtifact({ downloads: {} });
  await open(page, artifact.id);

  await frame(page).locator("#save-twice").click();

  await expect(frame(page).locator("#second")).toHaveAttribute("data-code", "rate_limited");
  await expect(dialog(page)).toHaveCount(1);
  expect(await dialog(page).locator("p").textContent()).toContain('"first.txt"');

  const download = page.waitForEvent("download");
  await dialog(page).getByRole("button", { name: "Save" }).click();
  expect((await download).suggestedFilename()).toBe("first.txt");
  await expect(frame(page).locator("#saves")).toHaveAttribute("data-count", "1");
});

test("a view with the second extension list switched off answers `extension_not_enabled`", async ({
  page,
}) => {
  const artifact = await createArtifact({ downloads: { config: { extraExtensions: false } } });
  await open(page, artifact.id);

  await frame(page).locator("#save-csv").click();
  await expect(status(page)).toHaveAttribute("data-code", "extension_not_enabled");
  await frame(page).locator("#save-svg").click();
  await expect(status(page)).toHaveAttribute("data-code", "extension_not_enabled");
  await expect(dialog(page)).toHaveCount(0);

  // The always-on list still works in the same view.
  const download = page.waitForEvent("download");
  await frame(page).locator("#save-buffer").click();
  await expect(dialog(page)).toHaveCount(1);
  await dialog(page).getByRole("button", { name: "Save" }).click();
  expect((await download).suggestedFilename()).toBe("bytes.txt");
});

test("a page that did not declare downloads gets no namespace at all", async ({ page }) => {
  const artifact = await createArtifact({ artifact: {} });
  await open(page, artifact.id);

  await expect(frame(page).locator("#ns")).toHaveAttribute("data-downloads", "no");
  await frame(page).locator("#save-csv").click();
  await expect(status(page)).toHaveAttribute("data-state", "absent");
  await expect(dialog(page)).toHaveCount(0);
});
