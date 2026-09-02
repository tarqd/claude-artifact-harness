/**
 * `permissions` end to end, through the real server, shell and frame:
 *
 * - what a page reads before it asks (`prompt` for a consent capability,
 *   `granted` for the rest, `unavailable` for anything not declared),
 * - what `request()` does: one shell dialog over an inert iframe, then the
 *   state the page reads afterwards — including after a reload, because the
 *   answer is stored under the key the `sample` slice reads,
 * - the refusal path, which is remembered and never re-asked,
 * - and the view with nothing to govern, where the namespace still mounts but
 *   answers `"unavailable"` without ever reaching the shell.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/index.ts";

let server: RunningServer;
let dataDir: string;
let fixture: string;

const OWNER_TOKEN = "e2e-permissions-token";

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

/** Open a view and wait for the fixture to have read its first state. */
async function open(page: Page, id: string): Promise<void> {
  await page.goto(`${server.shellOrigin}/a/${id}`);
  await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 15_000 });
  await expect(frame(page).locator("#ns")).toHaveAttribute("data-state", "resolved", {
    timeout: 15_000,
  });
}

const dialog = (page: Page) => page.locator(".shell-consent");

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "permissions-e2e-"));
  fixture = await readFile("fixtures/permissions.html", "utf8");
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

test("state before a request, the prompt, and state after it", async ({ page }) => {
  const artifact = await createArtifact({ permissions: {}, sample: {}, downloads: {} });
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await open(page, artifact.id);

  // Before the viewer is asked: the consent capability is "prompt", the rest
  // of the declaration is "granted", and nothing else exists.
  await expect(frame(page).locator("#ns")).toHaveAttribute("data-permissions", "yes");
  await expect(frame(page).locator("#ns")).toHaveAttribute("data-frozen", "yes");
  await expect(frame(page).locator("#sample")).toHaveAttribute("data-value", "prompt");
  await expect(frame(page).locator("#downloads")).toHaveAttribute("data-value", "granted");
  await expect(frame(page).locator("#db")).toHaveAttribute("data-value", "unavailable");
  await expect(frame(page).locator("#scoped")).toHaveAttribute("data-value", "unavailable");
  await expect(frame(page).locator("#map")).toHaveAttribute(
    "data-value",
    JSON.stringify({ sample: "prompt", downloads: "granted" }),
  );
  // A read never asks the viewer.
  await expect(dialog(page)).toHaveCount(0);

  // request() puts the question up in the shell, over an inert iframe.
  await frame(page).locator("#request").click();
  await expect(dialog(page)).toHaveCount(1);
  await expect(dialog(page).locator("h2")).toHaveText("Let this artifact ask Claude?");
  await expect(page.locator("iframe#frame-content")).toHaveJSProperty("inert", true);

  await dialog(page).getByRole("button", { name: "Allow" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator("iframe#frame-content")).toHaveJSProperty("inert", false);

  await expect(frame(page).locator("#result")).toHaveAttribute("data-state", "answered");
  await expect(frame(page).locator("#result")).toHaveAttribute(
    "data-value",
    JSON.stringify({ sample: "granted" }),
  );
  await expect(frame(page).locator("#sample")).toHaveAttribute("data-value", "granted");
  await expect(frame(page).locator("#map")).toHaveAttribute(
    "data-value",
    JSON.stringify({ sample: "granted", downloads: "granted" }),
  );

  // The decision is the viewer's, not the page's: it survives a reload, and a
  // second request is answered from it without asking again.
  await open(page, artifact.id);
  await expect(frame(page).locator("#sample")).toHaveAttribute("data-value", "granted");
  await frame(page).locator("#request").click();
  await expect(frame(page).locator("#result")).toHaveAttribute("data-ask", "1");
  await expect(frame(page).locator("#result")).toHaveAttribute(
    "data-value",
    JSON.stringify({ sample: "granted" }),
  );
  await expect(dialog(page)).toHaveCount(0);

  // request() with no names answers for the whole declaration.
  await frame(page).locator("#request-all").click();
  await expect(frame(page).locator("#result")).toHaveAttribute(
    "data-value",
    JSON.stringify({ sample: "granted", downloads: "granted" }),
  );

  // The documented limit is enforced, and rejects rather than throwing.
  await frame(page).locator("#request-bad").click();
  await expect(frame(page).locator("#result")).toHaveAttribute("data-state", "error");
  await expect(frame(page).locator("#result")).toHaveAttribute("data-value", "error:invalid_content");

  expect(errors).toEqual([]);
});

test("a refusal is remembered and never asked again", async ({ page }) => {
  const artifact = await createArtifact({ permissions: {}, sample: {} });
  await open(page, artifact.id);
  await expect(frame(page).locator("#sample")).toHaveAttribute("data-value", "prompt");

  await frame(page).locator("#request").click();
  await expect(dialog(page)).toHaveCount(1);
  await dialog(page).getByRole("button", { name: "Not now" }).click();

  await expect(frame(page).locator("#result")).toHaveAttribute(
    "data-value",
    JSON.stringify({ sample: "denied" }),
  );
  await expect(frame(page).locator("#sample")).toHaveAttribute("data-value", "denied");

  // Asking again cannot nag the viewer.
  await frame(page).locator("#request").click();
  await expect(frame(page).locator("#result")).toHaveAttribute("data-ask", "2");
  await expect(frame(page).locator("#result")).toHaveAttribute(
    "data-value",
    JSON.stringify({ sample: "denied" }),
  );
  await expect(dialog(page)).toHaveCount(0);
});

test("a view with nothing to govern answers unavailable locally", async ({ page }) => {
  const artifact = await createArtifact({ permissions: {}, user: {} });
  await open(page, artifact.id);

  // The namespace still mounts — `use("permissions")` is not the gate.
  await expect(frame(page).locator("#ns")).toHaveAttribute("data-permissions", "yes");
  await expect(frame(page).locator("#map")).toHaveAttribute("data-value", "{}");
  await expect(frame(page).locator("#sample")).toHaveAttribute("data-value", "unavailable");
  await expect(frame(page).locator("#downloads")).toHaveAttribute("data-value", "unavailable");
  await expect(frame(page).locator("#db")).toHaveAttribute("data-value", "unavailable");

  await frame(page).locator("#request").click();
  await expect(frame(page).locator("#result")).toHaveAttribute(
    "data-value",
    JSON.stringify({ sample: "unavailable" }),
  );
  await expect(dialog(page)).toHaveCount(0);
});

test("a page that never declared permissions resolves it null", async ({ page }) => {
  const artifact = await createArtifact({ downloads: {} });
  await page.goto(`${server.shellOrigin}/a/${artifact.id}`);
  await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 15_000 });
  await expect(frame(page).locator("#ns")).toHaveAttribute("data-permissions", "no", {
    timeout: 15_000,
  });
  await frame(page).locator("#request").click();
  await expect(frame(page).locator("#result")).toHaveAttribute("data-state", "absent");
});
