/**
 * The spine end-to-end: a published artifact loads through the real shell and
 * frame, `claude.use("artifact")` resolves a namespace, `claude.use("db")`
 * resolves null (a stub slice), and `publish(html)` mints a new version that
 * the view reloads to.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/index.ts";

let server: RunningServer;
let dataDir: string;

interface Created {
  id: string;
  version: string;
  url: string;
}

/** The admin API takes a credential; the browser logs in at `/login`. */
const OWNER_TOKEN = "e2e-owner-token";

async function createArtifact(html: string): Promise<Created> {
  const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OWNER_TOKEN}`,
    },
    body: JSON.stringify({ html, capabilities: { artifact: {} } }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Created;
}

async function liveVersion(id: string): Promise<string> {
  const response = await fetch(`${server.shellOrigin}/api/artifacts/${id}/version`);
  const body = (await response.json()) as { version: string };
  return body.version;
}

function frame(page: Page) {
  return page.frameLocator("#frame-content");
}

/** Only the owner (or an `admin` viewer) may write, so the browser logs in. */
async function loginAsOwner(page: Page): Promise<void> {
  await page.goto(`${server.shellOrigin}/login?token=${OWNER_TOKEN}`);
}

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "artifact-e2e-"));
  server = await startServer({
    shellPort: 0,
    framePort: 0,
    dataDir,
    versionPollMs: 1000,
    ownerToken: OWNER_TOKEN,
  });
});

test.afterAll(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the shell serves the artifact, resolves capabilities and publishes", async ({ page }) => {
  const html = await readFile("fixtures/artifact.html", "utf8");
  const artifact = await createArtifact(html);
  expect(artifact.version).toBe("v1");

  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await loginAsOwner(page);
  await page.goto(`${server.shellOrigin}/a/${artifact.id}`);

  // The frame is revealed only after `__frame_ready` and `load`.
  const iframe = page.locator("iframe#frame-content.ready");
  await expect(iframe).toHaveCount(1, { timeout: 15_000 });
  await expect(iframe).toHaveJSProperty("inert", false);
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  await expect(iframe).toHaveAttribute("allow", "fullscreen; clipboard-write; gamepad");
  await expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
  const src = await iframe.getAttribute("src");
  expect(src).toContain(`${artifact.id}.localhost`);
  expect(src).toContain("/_f/v1/");
  expect(src).toContain("__frame_t=");

  // use("artifact") and use("self") resolve; use("db") — a stub — resolves null.
  const ns = frame(page).locator("#ns");
  await expect(ns).toHaveAttribute("data-state", "resolved", { timeout: 15_000 });
  await expect(ns).toHaveAttribute("data-artifact", "yes");
  await expect(ns).toHaveAttribute("data-self", "yes");
  await expect(ns).toHaveAttribute("data-db", "no");
  await expect(ns).toHaveAttribute("data-frozen", "yes");
  // one namespace object, mounted under both names
  await expect(ns).toHaveAttribute("data-same", "yes");
  await expect(frame(page).locator("#count")).toHaveText("0");

  // The preamble's own guarantees, checked inside the frame.
  const content = page.frames().find((f) => f.url().includes("/_f/"));
  expect(content).toBeTruthy();
  const guarantees = await content!.evaluate(async () => {
    const claude = (window as unknown as {
      claude: { use(name: string): Promise<unknown>; complete(prompt: string): Promise<string> };
    }).claude;
    let completeCode = "resolved";
    try {
      await claude.complete("hi");
    } catch (err) {
      completeCode = (err as { code?: string }).code ?? "unknown";
    }
    return {
      ownKeys: Object.keys(claude),
      hasUse: typeof claude.use === "function",
      memoized: claude.use("artifact") === claude.use("artifact"),
      unknownNull: await claude.use("nonesuch"),
      rtcGone: typeof (window as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection,
      theme: document.documentElement.dataset.theme ?? null,
      completeCode,
    };
  });
  expect(guarantees.hasUse).toBe(true);
  expect(guarantees.ownKeys).toEqual([]); // `use` is non-enumerable
  expect(guarantees.memoized).toBe(true); // one promise object per served name
  expect(guarantees.unknownNull).toBeNull();
  expect(guarantees.rtcGone).toBe("undefined"); // WebRTC lockdown
  expect(["light", "dark"]).toContain(guarantees.theme);
  // the legacy chat-artifact wrapper exists and fails cleanly without `sample`
  expect(guarantees.completeCode).toBe("capability_disabled");

  // Every namespace method rejects with its own code, never a wrapper's.
  const codes = await content!.evaluate(async () => {
    const ns = (await (window as unknown as {
      claude: { use(name: string): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> };
    }).claude.use("artifact"))!;
    const outcome = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
        return "resolved";
      } catch (err) {
        const e = err as { code?: string; message?: string };
        return `${e.code}: ${e.message}`;
      }
    };
    return {
      edit: await outcome(() => ns.edit!([])),
      sync: await outcome(() => ns.sync!(() => undefined)),
      publishNumber: await outcome(() => ns.publish!(7)),
    };
  });
  expect(codes.edit).toBe("capability_disabled: live-doc editing is not available in this view");
  expect(codes.sync).toBe("capability_disabled: live-doc editing is not available in this view");
  expect(codes.publishNumber).toBe(
    "invalid_content: publish takes an HTML string or an object mapping file paths to contents",
  );

  // The size report reaches the shell (used for print layout only).
  await expect
    .poll(async () =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--frame-print-h"),
      ),
    )
    .not.toBe("");

  // Publishing mints v2 and reloads this view onto it.
  await frame(page).locator("#publish").click();
  await expect(frame(page).locator("#count")).toHaveText("1", { timeout: 20_000 });
  await expect(frame(page).locator("#ns")).toHaveAttribute("data-artifact", "yes");
  expect(await liveVersion(artifact.id)).toBe("v2");

  const reloadedSrc = await page.locator("iframe#frame-content").getAttribute("src");
  expect(reloadedSrc).toContain("/_f/v2/");

  // A second publish builds on the version this view now runs.
  await frame(page).locator("#publish").click();
  await expect(frame(page).locator("#count")).toHaveText("2", { timeout: 20_000 });
  expect(await liveVersion(artifact.id)).toBe("v3");

  expect(errors).toEqual([]);
});

test("a page with no capabilities still boots and resolves everything null", async ({ page }) => {
  const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OWNER_TOKEN}`,
    },
    body: JSON.stringify({
      html: await readFile("fixtures/artifact.html", "utf8"),
      capabilities: {},
    }),
  });
  const artifact = (await response.json()) as Created;

  await loginAsOwner(page);
  await page.goto(`${server.shellOrigin}/a/${artifact.id}`);
  await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 15_000 });
  const ns = frame(page).locator("#ns");
  await expect(ns).toHaveAttribute("data-state", "resolved", { timeout: 15_000 });
  await expect(ns).toHaveAttribute("data-artifact", "no");
  await expect(ns).toHaveAttribute("data-db", "no");

  await frame(page).locator("#publish").click();
  await expect(frame(page).locator("#status")).toHaveAttribute("data-state", "unavailable");
  expect(await liveVersion(artifact.id)).toBe("v1");
});

test("a page that declared the legacy `self` spelling can publish", async ({ page }) => {
  const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OWNER_TOKEN}`,
    },
    body: JSON.stringify({
      html: await readFile("fixtures/artifact.html", "utf8"),
      capabilities: { self: {} },
    }),
  });
  const artifact = (await response.json()) as Created;

  await loginAsOwner(page);
  await page.goto(`${server.shellOrigin}/a/${artifact.id}`);
  await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 15_000 });
  const ns = frame(page).locator("#ns");
  await expect(ns).toHaveAttribute("data-state", "resolved", { timeout: 15_000 });
  await expect(ns).toHaveAttribute("data-artifact", "yes");
  await expect(ns).toHaveAttribute("data-self", "yes");

  await frame(page).locator("#publish").click();
  await expect(frame(page).locator("#count")).toHaveText("1", { timeout: 20_000 });
  expect(await liveVersion(artifact.id)).toBe("v2");
});

test("another writer's version reaches an open view through the poll", async ({ page }) => {
  const artifact = await createArtifact(await readFile("fixtures/artifact.html", "utf8"));
  await loginAsOwner(page);
  await page.goto(`${server.shellOrigin}/a/${artifact.id}`);
  await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 15_000 });
  await expect(frame(page).locator("#count")).toHaveText("0");

  // Somebody else publishes while this view is open.
  const response = await fetch(`${server.shellOrigin}/api/artifacts/${artifact.id}/publish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OWNER_TOKEN}`,
    },
    body: JSON.stringify({
      baseVersion: "v1",
      html:
        "<!doctype html><html><head><title>elsewhere</title></head>" +
        '<body><span id="count" data-count="7">7</span></body></html>',
    }),
  });
  expect(response.status).toBe(200);

  await expect(frame(page).locator("#count")).toHaveText("7", { timeout: 20_000 });
  expect(await liveVersion(artifact.id)).toBe("v2");
});
