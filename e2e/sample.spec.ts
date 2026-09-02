/**
 * `sample` end to end: the fixture page asks Claude through the real shell,
 * frame and server with the deterministic fake backend
 * (`SAMPLE_BACKEND=fake`). It checks the consent dialog, streaming, Stop, a
 * page tool round, the reply cache and the legacy `claude.complete` wrapper.
 */
import { FOREIGN_RUNTIME } from "./foreign.ts";
import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/index.ts";

let server: RunningServer;
let dataDir: string;
let fixture: string;

const OWNER_TOKEN = "sample-e2e-token";
const CAPABILITIES = { sample: { config: { images: {}, tools: {} } } };
/** Long enough that the fake backend answers in several chunks. */
const PROMPT = "hello, please answer this in several small pieces";
const ECHO = new RegExp(`^echo #\\d+ \\(default\\): ${PROMPT}$`);

async function createArtifact(): Promise<string> {
  const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify({ html: fixture, capabilities: CAPABILITIES }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

function frame(page: Page) {
  return page.frameLocator("#frame-content");
}

/** Open an artifact and wait for the frame to be revealed and resolved. */
async function open(page: Page, id: string): Promise<void> {
  await page.goto(`${server.shellOrigin}/a/${id}`);
  await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 15_000 });
  await expect(frame(page).locator("#ns")).toHaveAttribute("data-state", "resolved", {
    timeout: 15_000,
  });
}

test.beforeAll(async () => {
  process.env.SAMPLE_BACKEND = "fake";
  dataDir = await mkdtemp(join(tmpdir(), "sample-e2e-"));
  fixture = await readFile("fixtures/sample.html", "utf8");
  server = await startServer({
    shellPort: 0,
    framePort: 0,
    dataDir,
    versionPollMs: 0,
    ownerToken: OWNER_TOKEN,
  });
});

test.afterAll(async () => {
  delete process.env.SAMPLE_BACKEND;
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("consent, streaming, tools, json and the reply cache", async ({ page }) => {
  const id = await createArtifact();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await open(page, id);

  // The namespace is a callable function carrying its members, and limits()
  // answers locally with what this view serves.
  const ns = frame(page).locator("#ns");
  await expect(ns).toHaveAttribute("data-sample", "yes");
  await expect(ns).toHaveAttribute("data-callable", "yes");
  const limits = frame(page).locator("#limits");
  await expect(limits).toHaveAttribute("data-images", "yes");
  await expect(limits).toHaveAttribute("data-tools", "yes");
  await expect(limits).toHaveAttribute("data-max", "65536");

  // First call: the shell holds the call and asks the viewer.
  await frame(page).locator("#prompt").fill(PROMPT);
  await frame(page).locator("#ask").click();
  const dialog = page.locator(".shell-consent");
  await expect(dialog).toBeVisible();
  // The artifact cannot click the viewer's answer for them.
  await expect(page.locator("iframe#frame-content")).toHaveJSProperty("inert", true);
  await expect(frame(page).locator("#status")).toHaveAttribute("data-state", "streaming");
  await dialog.getByRole("button", { name: "Allow" }).click();

  await expect(frame(page).locator("#status")).toHaveAttribute("data-state", "done", {
    timeout: 20_000,
  });
  await expect(page.locator("iframe#frame-content")).toHaveJSProperty("inert", false);
  const first = await frame(page).locator("#out").textContent();
  expect(first).toMatch(ECHO);
  // The answer streamed: several deltas, and the last one is the whole text.
  expect(Number(await frame(page).locator("#deltas").textContent())).toBeGreaterThan(1);
  await expect(frame(page).locator("#status")).toContainText("truncated=false");
  await expect(frame(page).locator("#status")).toContainText("tier=default");

  // The decision is remembered under the documented key.
  expect(await page.evaluate((key) => localStorage.getItem(key), `consent:${id}:sample`)).toBe(
    "granted",
  );

  // Second call, same question: no dialog, and the cached answer is replayed.
  await frame(page).locator("#ask").click();
  await expect(frame(page).locator("#status")).toHaveAttribute("data-state", "done", {
    timeout: 20_000,
  });
  await expect(dialog).toHaveCount(0);
  expect(await frame(page).locator("#out").textContent()).toBe(first);

  // `cache: false` asks again: the fake backend numbers every answer.
  await frame(page).locator("#askfresh").click();
  await expect(frame(page).locator("#status")).toHaveAttribute("data-state", "done", {
    timeout: 20_000,
  });
  const fresh = await frame(page).locator("#out").textContent();
  expect(fresh).toMatch(ECHO);
  expect(fresh).not.toBe(first);

  // A page tool: the frame runs it and the answer carries what it returned.
  await frame(page).locator("#asktools").click();
  await expect(frame(page).locator("#toolruns")).toHaveText("1", { timeout: 20_000 });
  await expect(frame(page).locator("#status")).toHaveAttribute("data-state", "done", {
    timeout: 20_000,
  });
  await expect(frame(page).locator("#out")).toContainText("[page_title -> fixture-tool-1]");

  // json() parses the reply.
  await frame(page).locator("#askjson").click();
  await expect(frame(page).locator("#status")).toHaveAttribute("data-state", "done", {
    timeout: 20_000,
  });
  const parsed = JSON.parse((await frame(page).locator("#jsonout").textContent()) ?? "null") as {
    tier: string;
    echo: string;
  };
  expect(parsed).toMatchObject({ tier: "default", echo: PROMPT });

  // An image made in the page: sniffed, downscaled, re-encoded and sent.
  await frame(page).locator("#askimage").click();
  await expect(frame(page).locator("#status")).toHaveAttribute("data-state", "done", {
    timeout: 20_000,
  });
  await expect(frame(page).locator("#out")).toContainText("[images: 1 image/");

  // The legacy chat-artifact API is a thin wrapper over this namespace. The
  // platform's published-artifact preamble does not carry `complete()`, so
  // this is ours alone.
  if (!FOREIGN_RUNTIME) {
    const content = page.frames().find((f) => f.url().includes("/_f/"));
    const legacy = await content!.evaluate(
      () => (window as unknown as { legacyComplete(p: string): Promise<string> }).legacyComplete("legacy hi"),
    );
    expect(legacy).toMatch(/^echo #\d+ \(default\): legacy hi$/);
  }

  expect(errors).toEqual([]);
});

test("Stop cancels the call and keeps what had streamed", async ({ page }) => {
  const id = await createArtifact();
  await open(page, id);

  await frame(page).locator("#prompt").fill("!slow tell me a long story");
  await frame(page).locator("#ask").click();
  await page.locator(".shell-consent").getByRole("button", { name: "Allow" }).click();

  // Wait until some of the answer is on screen, then press Stop.
  await expect(frame(page).locator("#out")).not.toBeEmpty({ timeout: 20_000 });
  const partial = await frame(page).locator("#out").textContent();
  await frame(page).locator("#stop").click();

  await expect(frame(page).locator("#status")).toHaveAttribute("data-state", "error");
  await expect(frame(page).locator("#code")).toHaveText("cancelled");
  // `e.text` is the part the page may keep.
  expect(await frame(page).locator("#out").textContent()).toContain(partial ?? "");
});

test("Stop while the consent dialog is up spends nothing", async ({ page }) => {
  const id = await createArtifact();
  await open(page, id);

  // Nothing may reach the backend for a call the viewer stopped.
  let backendCalls = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/frame/sample/call")) backendCalls++;
  });

  await frame(page).locator("#prompt").fill(PROMPT);
  await frame(page).locator("#ask").click();
  const dialog = page.locator(".shell-consent");
  await expect(dialog).toBeVisible();

  // The frame is inert while the dialog is up, so Stop is pressed through the
  // page's own abort signal.
  await frame(page).locator("#stop").dispatchEvent("click");
  await dialog.getByRole("button", { name: "Allow" }).click();

  await expect(frame(page).locator("#status")).toHaveAttribute("data-state", "error");
  await expect(frame(page).locator("#code")).toHaveText("cancelled");
  expect(backendCalls).toBe(0);

  // The grant was still recorded, so the next question runs with no dialog.
  await frame(page).locator("#ask").click();
  await expect(frame(page).locator("#status")).toHaveAttribute("data-state", "done", {
    timeout: 20_000,
  });
  expect(await frame(page).locator("#out").textContent()).toMatch(ECHO);
  expect(backendCalls).toBe(1);
});

test("a declined dialog is not_granted, and is never asked again", async ({ page }) => {
  const id = await createArtifact();
  await open(page, id);

  await frame(page).locator("#ask").click();
  const dialog = page.locator(".shell-consent");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Not now" }).click();

  await expect(frame(page).locator("#status")).toHaveAttribute("data-state", "error");
  await expect(frame(page).locator("#code")).toHaveText("not_granted");
  expect(await page.evaluate((key) => localStorage.getItem(key), `consent:${id}:sample`)).toBe(
    "denied",
  );

  await frame(page).locator("#ask").click();
  await expect(frame(page).locator("#code")).toHaveText("not_granted");
  await expect(dialog).toHaveCount(0);
});

test("a view that serves no images refuses image calls locally", async ({ page }) => {
  const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify({ html: fixture, capabilities: { sample: { config: { tools: {} } } } }),
  });
  const id = ((await response.json()) as { id: string }).id;
  await open(page, id);

  await expect(frame(page).locator("#limits")).toHaveAttribute("data-images", "no");
  await frame(page).locator("#askimage").click();
  // No dialog: the frame refuses before anything is sent.
  await expect(frame(page).locator("#code")).toHaveText("images_unavailable");
  await expect(page.locator(".shell-consent")).toHaveCount(0);
});

test("a view-only viewer is refused by the backend", async ({ page }) => {
  const viewOnly = await startServer({
    shellPort: 0,
    framePort: 0,
    dataDir,
    versionPollMs: 0,
    defaultLevel: "view",
  });
  try {
    const id = await createArtifact();
    await page.goto(`${viewOnly.shellOrigin}/a/${id}`);
    await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 15_000 });
    const framed = page.frameLocator("#frame-content");
    await expect(framed.locator("#ns")).toHaveAttribute("data-state", "resolved", {
      timeout: 15_000,
    });
    await framed.locator("#ask").click();
    await page.locator(".shell-consent").getByRole("button", { name: "Allow" }).click();
    await expect(framed.locator("#code")).toHaveText("not_granted", { timeout: 20_000 });
  } finally {
    await viewOnly.close();
  }
});
