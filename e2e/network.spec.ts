/**
 * `network` end to end, through the real server, shell and frame:
 *
 * - the namespace shape a page sees (`origins()` and nothing else), and the
 *   declaration echoed back verbatim;
 * - the CSP the iframe document is actually served, with the declared https
 *   origin in `connect-src` and the malformed sibling dropped;
 * - and the enforcement that follows: a fetch to the declared origin is left
 *   to the network, a fetch to an undeclared one is refused by the browser
 *   before it leaves the page (`securitypolicyviolation`, `connect-src`);
 * - an artifact that declared nothing gets no namespace at all.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/index.ts";

let server: RunningServer;
let dataDir: string;
let fixture: string;

const OWNER_TOKEN = "e2e-network-token";

/** Declared: one usable origin, one the CSP must refuse. */
const DECLARED = "https://declared.example";
const INSECURE = "http://insecure.example";

async function createArtifact(capabilities: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify({ html: fixture, capabilities }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

const frame = (page: Page) => page.frameLocator("#frame-content");
const ns = (page: Page) => frame(page).locator("#ns");

/** Open a view and wait for `use("network")` to have settled either way. */
async function open(page: Page, id: string): Promise<void> {
  await page.goto(`${server.shellOrigin}/a/${id}`);
  await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 15_000 });
  await expect(ns(page)).not.toHaveAttribute("data-state", "pending", { timeout: 15_000 });
}

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "network-e2e-"));
  fixture = await readFile("fixtures/network.html", "utf8");
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

test("the namespace is one method, and it echoes the declaration", async ({ page }) => {
  const id = await createArtifact({ network: { origins: [DECLARED, INSECURE] } });
  await open(page, id);

  await expect(ns(page)).toHaveAttribute("data-state", "resolved");
  await expect(ns(page)).toHaveAttribute("data-methods", "origins");
  // Verbatim: the page is told what it declared, including the entry the CSP
  // refuses. `origins()` reports the declaration; the browser enforces the
  // validated subset (see server.ts).
  await expect(frame(page).locator("#origins")).toHaveAttribute(
    "data-json",
    JSON.stringify([DECLARED, INSECURE]),
  );

  // The hardening every namespace gets, read from inside the frame — the
  // shell page cannot touch a cross-origin `contentWindow`.
  const shape = frame(page).locator("#shape");
  await expect(shape).toHaveAttribute("data-frozen", "true");
  await expect(shape).toHaveAttribute("data-proto", "null");
  await expect(shape).toHaveAttribute("data-thenable", "true");
});

test("the iframe document is served a connect-src carrying the declared origin", async ({
  page,
}) => {
  const id = await createArtifact({ network: { origins: [DECLARED, INSECURE] } });
  const policies: string[] = [];
  page.on("response", (response) => {
    if (!response.url().includes("/_f/")) return;
    const csp = response.headers()["content-security-policy"];
    if (csp) policies.push(csp);
  });
  await open(page, id);

  expect(policies.length).toBeGreaterThan(0);
  for (const policy of policies) {
    const connect = policy
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("connect-src"));
    expect(connect).toContain("'self'");
    expect(connect).toContain(DECLARED);
    // The cleartext sibling was declared and echoed to the page, but never
    // reaches the browser's allowlist.
    expect(policy).not.toContain(INSECURE);
  }
});

test("an undeclared origin is refused by the CSP; a declared one is not", async ({ page }) => {
  const id = await createArtifact({ network: { origins: [DECLARED, INSECURE] } });
  await open(page, id);

  // Neither host resolves, so neither fetch can succeed; what separates them
  // is whether the browser refused to open the connection at all.
  await frame(page).locator("#fetch-undeclared").click();
  const undeclared = frame(page).locator("#undeclared");
  await expect(undeclared).toHaveAttribute("data-state", "failed");
  await expect(undeclared).toHaveAttribute("data-blocked", "true");
  await expect(frame(page).locator("#violations")).toHaveAttribute(
    "data-last",
    /connect-src.*undeclared\.example/,
  );

  await frame(page).locator("#fetch-declared").click();
  const declared = frame(page).locator("#declared");
  await expect(declared).not.toHaveAttribute("data-state", "fetching", { timeout: 15_000 });
  await expect(declared).toHaveAttribute("data-blocked", "false");
});

test("an artifact that declared no network gets no namespace and no allowlist", async ({
  page,
}) => {
  const id = await createArtifact({});
  const policies: string[] = [];
  page.on("response", (response) => {
    if (!response.url().includes("/_f/")) return;
    const csp = response.headers()["content-security-policy"];
    if (csp) policies.push(csp);
  });
  await open(page, id);

  await expect(ns(page)).toHaveAttribute("data-state", "absent");
  // Only the runtime can set this: the fixture reads the namespace's shape
  // before touching `#shape`, so an untouched "?" means nothing was mounted.
  // (`#origins` is not evidence here — the fixture's own `!network` branch
  // writes `[]` into it whatever the runtime did.)
  await expect(frame(page).locator("#shape")).toHaveAttribute("data-frozen", "?");
  expect(policies.length).toBeGreaterThan(0);
  for (const policy of policies) expect(policy).toContain("connect-src 'self';");

  // Enforcement follows the declaration, not the namespace: with nothing
  // declared, even the origin the other artifact may reach is refused.
  await frame(page).locator("#fetch-declared").click();
  await expect(frame(page).locator("#declared")).toHaveAttribute("data-blocked", "true");
});
