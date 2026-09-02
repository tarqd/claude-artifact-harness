/**
 * The integration spec: one artifact declaring **every** capability the
 * roster serves, booted through the real shell, frame and server.
 *
 * What it is for is the seams between slices, which a per-slice spec cannot
 * see: ten `use()` names resolving from one `__frame_init`, two websocket
 * lanes (`db` and `room`) open on the same page at once, `assets` serving
 * `/_blob/<id>` on the frame origin the `network` slice's CSP governs, the
 * legacy `claude.complete()` wrapper reaching the `sample` backend, and the
 * consent key `sample` writes being the one `permissions` reads back.
 */
import { expect, test, type Page } from "@playwright/test";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/index.ts";

let server: RunningServer;
let dataDir: string;
let fixture: string;

const OWNER_TOKEN = "kitchen-sink-e2e-token";
const DECLARED_ORIGIN = "https://api.example.com";

/**
 * A raw GET against the frame origin with the artifact's `Host` header — the
 * origin a browser really uses. (The `/_a/<id>/` prefix form is off unless a
 * server opts into it, and it would collapse every artifact onto one origin.)
 */
function frameGet(
  artifactId: string,
  path: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.framePort,
        path,
        method: "GET",
        headers: { host: `${artifactId}.localhost:${server.framePort}` },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Every slice at once, each with the config its own spec declares. */
const CAPABILITIES = {
  artifact: {},
  db: {},
  sample: { config: { images: {}, tools: {} } },
  user: { scopes: ["profile"] },
  permissions: {},
  downloads: {},
  room: { config: { topics: { reaction: "interact" } } },
  assets: {},
  network: { origins: [DECLARED_ORIGIN] },
};

/** The names the page calls `use()` with — the roster plus the `self` alias. */
const USED = [
  "artifact",
  "self",
  "db",
  "sample",
  "user",
  "permissions",
  "downloads",
  "room",
  "assets",
  "network",
];

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

async function open(page: Page, id: string): Promise<void> {
  await page.goto(`${server.shellOrigin}/login?token=${OWNER_TOKEN}`);
  await page.goto(`${server.shellOrigin}/a/${id}`);
  await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 15_000 });
  await expect(frame(page).locator("#ns")).toHaveAttribute("data-state", "resolved", {
    timeout: 15_000,
  });
}

test.beforeAll(async () => {
  process.env.SAMPLE_BACKEND = "fake";
  dataDir = await mkdtemp(join(tmpdir(), "kitchen-sink-e2e-"));
  fixture = await readFile("fixtures/kitchen-sink.html", "utf8");
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

test("every capability resolves and works on one page", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  const lanes = new Set<string>();
  page.on("websocket", (ws) => lanes.add(new URL(ws.url()).pathname));

  const id = await createArtifact();
  await open(page, id);

  // 1. Every name resolves to a namespace — none of them null.
  const ns = frame(page).locator("#ns");
  await expect(ns).toHaveAttribute("data-total", String(USED.length));
  await expect(ns).toHaveAttribute("data-resolved", String(USED.length));
  await expect(ns).toHaveAttribute("data-null", "");
  for (const name of USED) {
    await expect(frame(page).locator(`#caps li[data-name="${name}"]`)).toHaveAttribute(
      "data-resolved",
      "yes",
    );
  }

  // 2. Each namespace does its one real thing: a db round trip, a room lane,
  //    an upload fetched back from /_blob, a viewer identity, and so on.
  const smoke = frame(page).locator("#smoke");
  await expect(smoke).toHaveAttribute("data-state", "passed", { timeout: 30_000 });
  await expect(smoke).toHaveAttribute("data-failed", "0");
  for (const name of ["artifact", "db", "sample", "user", "permissions", "downloads", "room", "assets", "network"]) {
    await expect(frame(page).locator(`#checks li[data-name="${name}"]`)).toHaveAttribute(
      "data-ok",
      "yes",
    );
  }

  // Both realtime lanes are open on this one page, on the shell origin.
  expect([...lanes].sort()).toEqual(["/api/frame/db/ws", "/api/frame/room/ws"]);

  // The declared origin reached the served policy through the `network`
  // slice's validator, and nothing else did.
  await expect(frame(page).locator('#checks li[data-name="network"]')).toHaveAttribute(
    "data-detail",
    `origins: ${DECLARED_ORIGIN}`,
  );

  // Nothing has asked the viewer anything yet.
  await expect(frame(page).locator("#perm-sample")).toHaveAttribute("data-value", "prompt");
  await expect(page.locator(".shell-consent")).toHaveCount(0);

  // 3. The legacy chat-artifact API: `claude.complete()` over `sample`,
  //    through the consent dialog and the fake backend.
  await frame(page).locator("#legacy").click();
  const dialog = page.locator(".shell-consent");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Allow" }).click();

  const out = frame(page).locator("#legacy-out");
  await expect(out).toHaveAttribute("data-state", "done", { timeout: 20_000 });
  await expect(out).toHaveText(/^echo #\d+ \(default\): kitchen sink$/);

  // 4. Cross-slice: `sample` recorded the answer under the shared key, and
  //    `permissions` reads that same key back rather than asking again.
  expect(await page.evaluate((key) => localStorage.getItem(key), `consent:${id}:sample`)).toBe(
    "granted",
  );
  await frame(page).locator("#perm").click();
  await expect(frame(page).locator("#perm-sample")).toHaveAttribute("data-value", "granted");
  await expect(dialog).toHaveCount(0);

  await expect(frame(page).locator("#errors")).toHaveAttribute("data-count", "0");
  expect(errors).toEqual([]);
});

test("the frame origin serves the declared CSP and the assets route together", async ({
  page,
}) => {
  const id = await createArtifact();
  await open(page, id);

  // The document's policy is the validated `connect-src`, built by the
  // `network` slice for the spine's frame middleware.
  const document = await frameGet(id, "/_f/v1/index.html");
  expect(document.status).toBe(200);
  const policy = String(document.headers["content-security-policy"] ?? "");
  expect(policy).toContain(`connect-src 'self' ${DECLARED_ORIGIN}`);
  expect(policy).toContain(`frame-ancestors ${server.shellOrigin}`);

  // `/_blob/<id>` is the `assets` slice's route now, not a spine placeholder:
  // an id it never stored is a plain 404, and a stored one is served with the
  // slice's own sandboxed policy rather than the document's.
  const missing = await frameGet(id, `/_blob/${"a".repeat(32)}`);
  expect(missing.status).toBe(404);

  const detail = await frame(page)
    .locator('#checks li[data-name="assets"]')
    .getAttribute("data-detail");
  expect(detail).toBe("uploaded, fetched, listed and deleted");
});
