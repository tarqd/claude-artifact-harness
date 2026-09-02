/**
 * `user` end to end, through the real shell, frame and backend: what the
 * owner sees about themselves, what an anonymous second viewer sees about
 * both of them, and what a page that never declared `user` gets (nothing).
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/index.ts";
import { avatarDataUri, colorForId } from "../src/capabilities/user/identity.ts";
import { loginAsOwner as login } from "./login.ts";

let server: RunningServer;
let dataDir: string;
let artifactId: string;
let plainId: string;
/** Set by the first test and read by the second: they run in order. */
let ownerId = "";

const OWNER_TOKEN = "user-e2e-owner-token";
const UNKNOWN_ID = `u_${"z".repeat(22)}`;

test.describe.configure({ mode: "serial" });

async function createArtifact(capabilities: Record<string, unknown>): Promise<string> {
  const html = await readFile("fixtures/user.html", "utf8");
  const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify({ html, capabilities }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

function frame(page: Page) {
  return page.frameLocator("#frame-content");
}

/** Wait for the fixture to have finished its first render. */
async function open(page: Page, id: string): Promise<void> {
  await page.goto(`${server.shellOrigin}/a/${id}`);
  await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 15_000 });
  await expect(frame(page).locator("#ns")).toHaveAttribute("data-state", "resolved", {
    timeout: 15_000,
  });
}

async function setName(page: Page, name: string): Promise<void> {
  // A name is written only for a session that already exists; reading your own
  // account is what mints it, exactly as opening a page would.
  expect((await page.request.get(`${server.shellOrigin}/api/account`)).status()).toBe(200);
  const response = await page.request.post(`${server.shellOrigin}/api/frame/user/profile`, {
    data: { name },
  });
  expect(response.status()).toBe(200);
}

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "user-e2e-"));
  server = await startServer({
    shellPort: 0,
    framePort: 0,
    dataDir,
    ownerToken: OWNER_TOKEN,
    versionPollMs: 0,
  });
  artifactId = await createArtifact({ user: { scopes: ["profile"] } });
  plainId = await createArtifact({ db: {} });
});

test.afterAll(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the owner sees their own profile and resolves ids", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await login(page, server.shellOrigin, OWNER_TOKEN);
  await setName(page, "Ada Lovelace");
  await open(page, artifactId);

  const ns = frame(page).locator("#ns");
  await expect(ns).toHaveAttribute("data-user", "yes");

  const me = frame(page).locator("#me");
  await expect(me).toHaveAttribute("data-name", "Ada Lovelace", { timeout: 15_000 });
  await expect(me).toHaveAttribute("data-owner", "yes");
  await expect(me).toHaveAttribute("data-canedit", "yes");
  // v0 declares no email scope, so `email()` is null without a backend call.
  await expect(me).toHaveAttribute("data-email", "none");
  await expect(me).toHaveAttribute("data-avatar", "data-uri");

  ownerId = (await me.getAttribute("data-id")) ?? "";
  expect(ownerId).toMatch(/^u_[A-Za-z0-9_]{22}$/);
  await expect(me).toHaveAttribute("data-color", colorForId(ownerId));
  await expect(frame(page).locator("#me-avatar")).toHaveAttribute("src", avatarDataUri(ownerId));

  // id()/name()/isOwner()/canEdit()/avatarUrl()/email() agree with me().
  const members = frame(page).locator("#members");
  for (const key of ["id", "name", "owner", "canedit", "avatar", "email"]) {
    await expect(members).toHaveAttribute(`data-${key}`, "match");
  }

  // Resolving ids: the viewer's own, and one nobody has ever seen.
  await frame(page).locator("#ids").fill(`${ownerId}, ${UNKNOWN_ID}`);
  await frame(page).locator("#resolve").click();
  const state = frame(page).locator("#profiles-state");
  await expect(state).toHaveAttribute("data-state", "resolved");
  await expect(state).toHaveAttribute("data-count", "2");

  const rows = frame(page).locator("#profiles li");
  await expect(rows.nth(0)).toHaveAttribute("data-name", "Ada Lovelace");
  await expect(rows.nth(0)).toHaveAttribute("data-isme", "yes");
  // An id the directory cannot resolve still gets its own stable colour and
  // a data-URI avatar, so the page can draw it without a special case.
  await expect(rows.nth(1)).toHaveAttribute("data-name", "");
  await expect(rows.nth(1)).toHaveAttribute("data-isme", "no");
  await expect(rows.nth(1)).toHaveAttribute("data-color", colorForId(UNKNOWN_ID));
  await expect(rows.nth(1)).toHaveAttribute("data-avatar", "data-uri");

  // A writer may search the artifact's peers.
  await frame(page).locator("#q").fill("ada");
  await frame(page).locator("#search").click();
  const search = frame(page).locator("#search-state");
  await expect(search).toHaveAttribute("data-state", "resolved");
  await expect(search).toHaveAttribute("data-names", "Ada Lovelace");

  await expect(frame(page).locator("#threw")).toHaveAttribute("data-any", "no");
  expect(errors).toEqual([]);
});

test("an anonymous viewer resolves peers but is neither owner nor searcher", async ({
  browser,
}: {
  browser: Browser;
}) => {
  expect(ownerId).not.toBe("");
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await setName(page, "Grace Hopper");
  await open(page, artifactId);

  const me = frame(page).locator("#me");
  await expect(me).toHaveAttribute("data-name", "Grace Hopper", { timeout: 15_000 });
  await expect(me).toHaveAttribute("data-owner", "no");
  await expect(me).toHaveAttribute("data-canedit", "no");
  const anonId = (await me.getAttribute("data-id")) ?? "";
  expect(anonId).toMatch(/^u_[A-Za-z0-9_]{22}$/);
  expect(anonId).not.toBe(ownerId);

  // The owner has opened this artifact, so they are a peer this viewer can
  // resolve — the directory is scoped to the artifact, not to the account.
  await frame(page).locator("#ids").fill(`${ownerId},${anonId}`);
  await frame(page).locator("#resolve").click();
  await expect(frame(page).locator("#profiles-state")).toHaveAttribute("data-count", "2");
  const rows = frame(page).locator("#profiles li");
  await expect(rows.nth(0)).toHaveAttribute("data-name", "Ada Lovelace");
  await expect(rows.nth(0)).toHaveAttribute("data-isme", "no");
  await expect(rows.nth(1)).toHaveAttribute("data-name", "Grace Hopper");
  await expect(rows.nth(1)).toHaveAttribute("data-isme", "yes");

  // Enumeration needs a writer: the refusal reaches the page as an empty
  // list, never as a rejection.
  await frame(page).locator("#q").fill("ada");
  await frame(page).locator("#search").click();
  const search = frame(page).locator("#search-state");
  await expect(search).toHaveAttribute("data-state", "resolved");
  await expect(search).toHaveAttribute("data-count", "0");

  await expect(frame(page).locator("#threw")).toHaveAttribute("data-any", "no");
  expect(errors).toEqual([]);
  await context.close();
});

test("a page that did not declare user gets null from use()", async ({ page }) => {
  await open(page, plainId);
  await expect(frame(page).locator("#ns")).toHaveAttribute("data-user", "no");
  await expect(frame(page).locator("#me")).toHaveAttribute("data-id", "");
  await expect(frame(page).locator("#threw")).toHaveAttribute("data-any", "no");
});
