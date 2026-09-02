/**
 * `mcp` end to end: the fixture page calls connectors through the real
 * shell, frame and server against the fake directory (`MCP_BACKEND=fake`).
 * It checks `listTools`, the per-server consent dialog, the result cache and
 * its marker, every refusal a page can meet, cancellation, a watch with
 * replay and `invalidate`, and the scoped permission names.
 */
import { FOREIGN_RUNTIME } from "./foreign.ts";
import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/index.ts";
import { fakeCallCount } from "../src/capabilities/mcp/directory.ts";

let server: RunningServer;
let dataDir: string;
let fixture: string;

const OWNER_TOKEN = "mcp-e2e-token";
const CAPABILITIES = {
  mcp: {
    servers: [
      { server: "Fake Tools", tools: ["echo", "write", "plain", "fail", "slow"] },
      { server: "host:local", tools: ["read_file"] },
      { server: "Needs Auth", tools: ["anything"] },
    ],
  },
  permissions: {},
};

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
  await page.goto(`${server.shellOrigin}/a/${id}`);
  await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 15_000 });
  await expect(frame(page).locator("#ns")).toHaveAttribute("data-state", "resolved", { timeout: 15_000 });
}

/** Click a fixture button and wait for the call to settle. */
async function run(page: Page, button: string): Promise<{ state: string; code: string; call: string; cached: string }> {
  const out = frame(page).locator("#out");
  await frame(page).locator(`#${button}`).click();
  await expect(out).toHaveAttribute("data-state", /^(done|error)$/, { timeout: 20_000 });
  return {
    state: (await out.getAttribute("data-state")) ?? "",
    code: (await out.getAttribute("data-code")) ?? "",
    call: (await out.getAttribute("data-call")) ?? "",
    cached: (await out.getAttribute("data-cached")) ?? "",
  };
}

test.beforeAll(async () => {
  process.env.MCP_BACKEND = "fake";
  dataDir = await mkdtemp(join(tmpdir(), "mcp-e2e-"));
  fixture = await readFile("fixtures/mcp.html", "utf8");
  server = await startServer({ shellPort: 0, framePort: 0, dataDir, versionPollMs: 0, ownerToken: OWNER_TOKEN });
});

test.afterAll(async () => {
  delete process.env.MCP_BACKEND;
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("listTools, consent, the cache, refusals, cancellation and permissions", async ({ page }) => {
  const id = await createArtifact();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await open(page, id);

  // The namespace, frozen, with the four methods.
  const ns = frame(page).locator("#ns");
  await expect(ns).toHaveAttribute("data-mcp", "yes");
  await expect(ns).toHaveAttribute("data-methods", "callTool,invalidate,listTools,watchTool");
  if (!FOREIGN_RUNTIME) await expect(ns).toHaveAttribute("data-frozen", "yes");

  // listTools: the manifest intersected with what is connected, host: servers
  // omitted, statuses in the closed vocabulary — and no dialog.
  const servers = frame(page).locator("#servers");
  await expect(servers).toHaveAttribute("data-state", "listed", { timeout: 15_000 });
  await expect(servers).toHaveAttribute("data-names", "Fake Tools,Needs Auth");
  const listed = JSON.parse((await servers.getAttribute("data-json")) ?? "{}") as {
    servers: Array<{ server: string; authStatus: string; tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> }>;
  };
  const fake = listed.servers.find((s) => s.server === "Fake Tools")!;
  expect(fake.authStatus).toBe("connected");
  expect(fake.tools.map((t) => t.name)).toEqual(["echo", "write", "plain", "fail", "slow"]);
  expect(fake.tools[0]!.annotations).toEqual({ readOnlyHint: true });
  expect(fake.tools[2]!.annotations).toBeUndefined();
  expect(listed.servers.find((s) => s.server === "Needs Auth")).toEqual({ server: "Needs Auth", authStatus: "needs_reauth", tools: [] });
  await expect(page.locator(".shell-consent")).toHaveCount(0);

  // Permissions before any call: the server is undecided, an unknown one absent.
  const perm = frame(page).locator("#perm");
  await expect(perm).toHaveAttribute("data-scoped", "prompt");
  await expect(perm).toHaveAttribute("data-agg", "prompt");
  await expect(perm).toHaveAttribute("data-unknown", "unavailable");

  // Refusals that never reach the viewer: outside the manifest, a device
  // server, and a caller bug.
  expect(await run(page, "call-undeclared")).toMatchObject({ state: "error", code: "not_in_manifest" });
  expect(await run(page, "call-host")).toMatchObject({ state: "error", code: "server_not_connected" });
  expect(await run(page, "call-badinput")).toMatchObject({ state: "error", code: "bad_request" });
  await expect(page.locator(".shell-consent")).toHaveCount(0);

  // The first real call asks the viewer, naming the server and its tools.
  const before = fakeCallCount();
  await frame(page).locator("#call-echo").click();
  const dialog = page.locator(".shell-consent");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Let this artifact use Fake Tools?");
  await expect(dialog).toContainText("echo, write, plain, fail, slow");
  await dialog.getByRole("button", { name: "Allow" }).click();
  const out = frame(page).locator("#out");
  await expect(out).toHaveAttribute("data-state", "done", { timeout: 20_000 });
  await expect(out).toHaveAttribute("data-call", String(before + 1));
  await expect(out).toHaveAttribute("data-cached", "no");
  await expect(frame(page).locator("#payload")).toHaveText(`{"echo":{"k":"one"},"call":${before + 1}}`);
  expect(await page.evaluate((key) => localStorage.getItem(key), `consent:${id}:mcp:Fake Tools`)).toBe("granted");

  // The same call again is served from the cache, with the shell's marker;
  // `cache: false` executes.
  expect(await run(page, "call-echo")).toMatchObject({ state: "done", call: String(before + 1), cached: "yes" });
  expect(await run(page, "call-echo-fresh")).toMatchObject({ state: "done", call: String(before + 2), cached: "no" });
  // A different input is a different call.
  await frame(page).locator("#k").fill("two");
  expect(await run(page, "call-echo")).toMatchObject({ state: "done", call: String(before + 3), cached: "no" });
  await frame(page).locator("#k").fill("one");
  expect(await run(page, "call-echo")).toMatchObject({ state: "done", call: String(before + 1), cached: "yes" });
  // invalidate(server, tool) drops it: the next call executes.
  expect(await run(page, "invalidate")).toMatchObject({ state: "done" });
  expect(await run(page, "call-echo")).toMatchObject({ state: "done", call: String(before + 4), cached: "no" });

  // A declared write is never cached; an unannotated tool is not by default.
  expect(await run(page, "call-write")).toMatchObject({ state: "done", cached: "no" });
  expect(await run(page, "call-write")).toMatchObject({ state: "done", cached: "no" });
  expect(await run(page, "call-plain")).toMatchObject({ state: "done", call: String(before + 7), cached: "no" });
  expect(await run(page, "call-plain")).toMatchObject({ state: "done", call: String(before + 8), cached: "no" });

  // A tool-level failure rejects with tool_error and carries the result.
  expect(await run(page, "call-fail")).toMatchObject({ state: "error", code: "tool_error" });
  await expect(out).toHaveAttribute("data-has-result", "yes");

  // A connector whose credentials lapsed asks its own question first, then rejects.
  await frame(page).locator("#call-reauth").click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Let this artifact use Needs Auth?");
  await dialog.getByRole("button", { name: "Allow" }).click();
  await expect(out).toHaveAttribute("data-state", "error", { timeout: 20_000 });
  await expect(out).toHaveAttribute("data-code", "needs_reauth");
  await expect(out).toHaveAttribute("data-server", "Needs Auth");

  // Abort: the page's signal cancels promptly.
  expect(await run(page, "call-cancel")).toMatchObject({ state: "error", code: "cancelled" });

  // Permissions after the calls: the decided server reads granted; the
  // aggregate is still waiting on host:local.
  await frame(page).locator("#perm-read").click();
  await expect(perm).toHaveAttribute("data-scoped", "granted");
  await expect(perm).toHaveAttribute("data-agg", "prompt");
  await frame(page).locator("#perm-request").click();
  await expect(perm).toHaveAttribute("data-requested", "granted");
  await expect(dialog).toHaveCount(0);

  await expect(frame(page).locator("#errors")).toHaveAttribute("data-count", "0");
  expect(errors).toEqual([]);
});

test("a watch replays the cache, hears invalidate, and stops on unsubscribe", async ({ page }) => {
  const id = await createArtifact();
  await open(page, id);
  const watch = frame(page).locator("#watch");

  // First data: nothing stored, so the watch executes (behind the consent).
  await frame(page).locator("#watch-start").click();
  const dialog = page.locator(".shell-consent");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Allow" }).click();
  await expect(watch).toHaveAttribute("data-events", "1", { timeout: 20_000 });
  await expect(watch).toHaveAttribute("data-last-cached", "no");
  const first = (await watch.getAttribute("data-last-call")) ?? "";

  // A cached call of the same identity is served from the store: no new event.
  expect(await run(page, "call-echo")).toMatchObject({ state: "done", call: first, cached: "yes" });
  await expect(watch).toHaveAttribute("data-events", "1");

  // invalidate re-executes the watched identity and delivers.
  await frame(page).locator("#invalidate").click();
  await expect(watch).toHaveAttribute("data-events", "2", { timeout: 20_000 });
  const second = (await watch.getAttribute("data-last-call")) ?? "";
  expect(Number(second)).toBe(Number(first) + 1);

  // A fresh cached call feeds the watcher too.
  expect(await run(page, "call-echo-fresh")).toMatchObject({ state: "done", cached: "no" });
  if (!FOREIGN_RUNTIME) await expect(watch).toHaveAttribute("data-events", "2");
  await frame(page).locator("#k").fill("one");
  await frame(page).locator("#invalidate").click();
  await expect(watch).toHaveAttribute("data-events", "3", { timeout: 20_000 });

  // After unsubscribe nothing more arrives.
  await frame(page).locator("#watch-stop").click();
  await frame(page).locator("#invalidate").click();
  expect(await run(page, "call-echo")).toMatchObject({ state: "done", cached: "no" });
  await page.waitForTimeout(500);
  await expect(watch).toHaveAttribute("data-events", "3");
  await expect(frame(page).locator("#errors")).toHaveAttribute("data-count", "0");
});

test("a declined server rejects not_granted and is never asked again", async ({ page }) => {
  const id = await createArtifact();
  await open(page, id);

  await frame(page).locator("#call-echo").click();
  const dialog = page.locator(".shell-consent");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Not now" }).click();
  const out = frame(page).locator("#out");
  await expect(out).toHaveAttribute("data-state", "error", { timeout: 20_000 });
  await expect(out).toHaveAttribute("data-code", "not_granted");

  expect(await run(page, "call-echo")).toMatchObject({ state: "error", code: "not_granted" });
  await expect(dialog).toHaveCount(0);
  await frame(page).locator("#perm-read").click();
  await expect(frame(page).locator("#perm")).toHaveAttribute("data-scoped", "denied");
  // The aggregate still has undecided servers, so it reads prompt, not denied.
  await expect(frame(page).locator("#perm")).toHaveAttribute("data-agg", "prompt");
  expect(await page.evaluate((key) => localStorage.getItem(key), `consent:${id}:mcp:Fake Tools`)).toBe("denied");
});
