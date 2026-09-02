/**
 * The room end to end: two browser contexts (two viewers, two cookie jars)
 * open the same artifact through the real shell, frame, broker and server.
 * Presence set in one page reaches the other, a moment emitted in one is
 * heard in the other, and the sender hears its own echo marked `sameTab`.
 */
import { expect, test, type Frame, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/index.ts";

let server: RunningServer;
let dataDir: string;

const OWNER_TOKEN = "room-e2e-owner";

async function createArtifact(capabilities: unknown): Promise<string> {
  const html = await readFile("fixtures/room.html", "utf8");
  const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify({ html, capabilities }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { id: string };
  return body.id;
}

function content(page: Page): Frame {
  const frame = page.frames().find((f) => f.url().includes("/_f/"));
  if (!frame) throw new Error("the artifact frame is not mounted");
  return frame;
}

/** Open one view and wait until its room has answered. */
async function openView(page: Page, id: string): Promise<void> {
  await page.goto(`${server.shellOrigin}/a/${id}`);
  await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 20_000 });
  const ns = page.frameLocator("#frame-content").locator("#ns");
  await expect(ns).toHaveAttribute("data-state", "resolved", { timeout: 20_000 });
  await expect(ns).toHaveAttribute("data-room", "yes");
  await expect(page.frameLocator("#frame-content").locator("#status")).toHaveAttribute(
    "data-conn",
    "yes",
    { timeout: 20_000 },
  );
}

function view(page: Page) {
  return page.frameLocator("#frame-content");
}

async function myPeer(page: Page): Promise<string> {
  const value = await view(page).locator("#status").getAttribute("data-me");
  expect(value).toBeTruthy();
  return value!;
}

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "room-e2e-"));
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

test("presence and moments cross between two viewers, echo included", async ({ browser }) => {
  const id = await createArtifact({ room: { config: { topics: { reaction: "interact" } } } });

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const errors: string[] = [];
  pageA.on("pageerror", (err) => errors.push(`A: ${err}`));
  pageB.on("pageerror", (err) => errors.push(`B: ${err}`));

  await openView(pageA, id);
  await openView(pageB, id);

  // Each view sees itself and the other: the room is the open documents.
  await expect(view(pageA).locator("#peer-count")).toHaveAttribute("data-count", "2", {
    timeout: 20_000,
  });
  await expect(view(pageB).locator("#peer-count")).toHaveAttribute("data-count", "2", {
    timeout: 20_000,
  });

  const peerA = await myPeer(pageA);
  const peerB = await myPeer(pageB);
  expect(peerA).not.toBe(peerB);

  // Exactly one peer is "you" on each page, and it is not the same one.
  await expect(view(pageA).locator('#peers li[data-me="yes"]')).toHaveAttribute(
    "data-peer",
    peerA,
  );
  await expect(view(pageB).locator('#peers li[data-me="yes"]')).toHaveAttribute(
    "data-peer",
    peerB,
  );

  /* ------------------------------ presence ----------------------------- */

  await view(pageA).locator("#move").click();
  const aSeenFromB = view(pageB).locator(`#peers li[data-peer="${peerA}"]`);
  await expect(aSeenFromB).toHaveAttribute("data-x", "0.42", { timeout: 20_000 });
  await expect(aSeenFromB).toHaveAttribute("data-y", "0.31");
  await expect(aSeenFromB).toHaveAttribute("data-me", "no");
  // …and it is rendered as a cursor, not just listed.
  await expect(view(pageB).locator(`#board .cursor[data-peer="${peerA}"]`)).toHaveCount(1);

  await view(pageB).locator("#rename").click();
  const bSeenFromA = view(pageA).locator(`#peers li[data-peer="${peerB}"]`);
  await expect(bSeenFromA).toHaveAttribute("data-who", /^viewer-\d{4}$/, { timeout: 20_000 });

  // A merge, not a replace: B's cursor arrives without losing its name.
  await view(pageB).locator("#move").click();
  await expect(bSeenFromA).toHaveAttribute("data-x", "0.42", { timeout: 20_000 });
  await expect(bSeenFromA).toHaveAttribute("data-who", /^viewer-\d{4}$/);

  /* ------------------------------- moments ----------------------------- */

  await view(pageA).locator("#wave").click();

  const echo = view(pageA).locator("#log li").first();
  await expect(echo).toHaveAttribute("data-topic", "reaction", { timeout: 20_000 });
  await expect(echo).toHaveAttribute("data-isme", "yes");
  await expect(echo).toHaveAttribute("data-sametab", "yes");
  await expect(echo).toHaveAttribute("data-peer", peerA);
  await expect(echo).toHaveText('reaction {"kind":"wave","n":1} (you, this tab)');

  const heard = view(pageB).locator("#log li").first();
  await expect(heard).toHaveAttribute("data-topic", "reaction", { timeout: 20_000 });
  await expect(heard).toHaveAttribute("data-isme", "no");
  await expect(heard).toHaveAttribute("data-sametab", "no");
  await expect(heard).toHaveAttribute("data-peer", peerA);
  await expect(heard).toHaveAttribute("data-kind", "viewer");
  await expect(heard).toHaveText('reaction {"kind":"wave","n":1}');

  // Nothing was stored: the moment arrives once, on the topic it was sent on.
  await expect(view(pageB).locator("#log-count")).toHaveAttribute("data-count", "1");

  /* ------------------------- the platform's rules ---------------------- */

  const outcomes = await content(pageA).evaluate(async () => {
    const room = (await (window as unknown as {
      claude: { use(name: string): Promise<Record<string, (...args: unknown[]) => unknown>> };
    }).claude.use("room"))!;
    const fail = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
        return "resolved";
      } catch (err) {
        const e = err as { code?: string; message?: string };
        return `${e.code}: ${e.message}`;
      }
    };
    return {
      // An undeclared topic stays admin-only, and this viewer is not an admin.
      adminOnly: await fail(() => room.emit!("admin.only", { x: 1 }) as Promise<unknown>),
      badTopic: await fail(() => room.emit!("Bad:Topic") as Promise<unknown>),
      bigPresence: await fail(
        () => room.presence!({ big: "x".repeat(5000) }) as Promise<unknown>,
      ),
      toClaude: await fail(() => room.sendToClaudeSession!({}) as Promise<unknown>),
      canSend: await room.canSendToClaudeSession!(),
      peersIsStable: room.peers!() === room.peers!(),
      connected: room.connected!(),
      frozen: Object.isFrozen(room),
    };
  });

  expect(outcomes.adminOnly).toBe(
    'not_permitted: this viewer may not send on the topic "admin.only"',
  );
  expect(outcomes.badTopic).toBe(
    "invalid_argument: emit topic must match ^[a-z][a-z0-9_.-]{0,47}$ (colon-free)",
  );
  expect(outcomes.bigPresence).toBe(
    "invalid_argument: your merged presence object serializes over 4096 bytes - the patch was not applied",
  );
  expect(outcomes.toClaude).toBe("invalid_argument: nothing to send: the object has no fields");
  expect(outcomes.canSend).toBe("off");
  expect(outcomes.peersIsStable).toBe(true);
  expect(outcomes.connected).toBe(true);
  expect(outcomes.frozen).toBe(true);

  // The admin-only topic really was never delivered anywhere.
  await expect(view(pageB).locator("#log-count")).toHaveAttribute("data-count", "1");

  /* ------------------------------ departure ---------------------------- */

  await pageB.close();
  await expect(view(pageA).locator("#peer-count")).toHaveAttribute("data-count", "1", {
    timeout: 20_000,
  });
  await expect(view(pageA).locator(`#peers li[data-peer="${peerB}"]`)).toHaveCount(0);

  expect(errors).toEqual([]);
  await contextA.close();
  await contextB.close();
});

test("an artifact that does not declare room leaves the page running alone", async ({ page }) => {
  const id = await createArtifact({ db: {} });
  await page.goto(`${server.shellOrigin}/a/${id}`);
  await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 20_000 });
  const ns = view(page).locator("#ns");
  await expect(ns).toHaveAttribute("data-state", "resolved", { timeout: 20_000 });
  await expect(ns).toHaveAttribute("data-room", "no");
  await expect(view(page).locator("#peer-count")).toHaveAttribute("data-count", "0");
});

test("an admin viewer may send on an admin-only topic", async ({ browser }) => {
  const id = await createArtifact({ room: { config: { topics: { reaction: "interact" } } } });
  const context = await browser.newContext();
  const page = await context.newPage();
  // The owner token makes this browser the owner of every artifact.
  await page.goto(`${server.shellOrigin}/login?token=${OWNER_TOKEN}`);
  await openView(page, id);

  const outcome = await content(page).evaluate(async () => {
    const room = (await (window as unknown as {
      claude: { use(name: string): Promise<Record<string, (...args: unknown[]) => unknown>> };
    }).claude.use("room"))!;
    try {
      await room.emit!("admin.only", { cleared: true });
      return "sent";
    } catch (err) {
      return String((err as { code?: string }).code);
    }
  });
  expect(outcome).toBe("sent");

  // The sender hears its own admin moment come back.
  const echo = view(page).locator("#log li").first();
  await expect(echo).toHaveAttribute("data-topic", "admin.only", { timeout: 20_000 });
  await expect(echo).toHaveAttribute("data-sametab", "yes");
  await context.close();
});
