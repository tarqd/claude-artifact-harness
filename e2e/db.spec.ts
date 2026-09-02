/**
 * The db slice end to end: two independent viewers (two browser contexts,
 * two viewer cookies) open the same artifact through the real shell, and
 * one page's `set()` reaches the other page's `onSnapshot` live. The same
 * run proves the per-viewer subtree under `data/users/` stays private.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/index.ts";

let server: RunningServer;
let dataDir: string;

async function createArtifact(): Promise<string> {
  const html = await readFile("fixtures/db.html", "utf8");
  const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ html, capabilities: { db: {} } }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { id: string };
  return body.id;
}

function frame(page: Page) {
  return page.frameLocator("#frame-content");
}

/** Open one artifact in its own browser context, i.e. as its own viewer. */
async function openViewer(browser: Browser, id: string, errors: string[]): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(`${server.shellOrigin}/a/${id}`);
  await expect(page.locator("iframe#frame-content.ready")).toHaveCount(1, { timeout: 15_000 });
  await expect(frame(page).locator("#ns")).toHaveAttribute("data-db", "yes", { timeout: 15_000 });
  return page;
}

async function addTask(page: Page, title: string): Promise<void> {
  await frame(page).locator("#title").fill(title);
  await frame(page).locator("#add").click();
  await expect(frame(page).locator("#status")).toHaveAttribute("data-state", "added", {
    timeout: 15_000,
  });
}

function titles(page: Page) {
  return frame(page).locator("#tasks li");
}

/** The viewer id the shell page was booted with. */
function viewerId(page: Page): Promise<string> {
  return page.evaluate(
    () => (window as unknown as { __SHELL_BOOT: { viewer: { id: string } } }).__SHELL_BOOT.viewer.id,
  );
}

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "db-e2e-"));
  server = await startServer({
    shellPort: 0,
    framePort: 0,
    dataDir,
    versionPollMs: 0,
    openAdminApi: true,
  });
});

test.afterAll(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("two viewers share a task list live and keep their own subtree private", async ({
  browser,
}) => {
  const errors: string[] = [];
  const id = await createArtifact();
  const alice = await openViewer(browser, id, errors);
  const bob = await openViewer(browser, id, errors);

  // The namespace is the frozen object the contract promises.
  await expect(frame(alice).locator("#ns")).toHaveAttribute("data-frozen", "yes");

  // Both views start empty, and the first snapshot arrives without a write.
  await expect(frame(alice).locator("#count")).toHaveText("0", { timeout: 15_000 });
  await expect(frame(bob).locator("#count")).toHaveText("0", { timeout: 15_000 });

  /* ---------------- one page's set() reaches the other ---------------- */

  await addTask(alice, "buy milk");
  await expect(titles(alice)).toHaveText(["buy milk"], { timeout: 15_000 });
  // The live one: bob never called anything, the lane pushed it.
  await expect(titles(bob)).toHaveText(["buy milk"], { timeout: 15_000 });
  await expect(frame(bob).locator("#changes")).toHaveAttribute("data-last", /^added:.*:-1->0$/);
  // Delivered over the realtime lane, so the snapshot is server-definitive.
  await expect(frame(bob).locator("#meta")).toHaveAttribute("data-fromcache", "no");

  await addTask(bob, "walk dog");
  await expect(titles(bob)).toHaveText(["buy milk", "walk dog"], { timeout: 15_000 });
  await expect(titles(alice)).toHaveText(["buy milk", "walk dog"], { timeout: 15_000 });

  // An update is a `modified` op, not a remove-and-add.
  await frame(alice).locator("#toggle").click();
  await expect(frame(bob).locator("#tasks li").first()).toHaveAttribute("data-done", "yes", {
    timeout: 15_000,
  });
  await expect(frame(bob).locator("#changes")).toHaveAttribute("data-last", /^modified:/);

  // A delete is a `removed` op at the index the listener held it.
  await frame(alice).locator("#clear").click();
  await expect(frame(bob).locator("#count")).toHaveText("0", { timeout: 15_000 });
  await expect(frame(alice).locator("#count")).toHaveText("0", { timeout: 15_000 });

  /* --------------------- the private per-user doc --------------------- */

  // The contract's own spelling: each viewer addresses its subtree by its
  // real id (what `claude.user.id()` resolves to), never by an alias.
  const aliceId = await viewerId(alice);
  const bobId = await viewerId(bob);
  expect(aliceId).not.toBe(bobId);

  await frame(alice).locator("#note-path").fill(`data/users/${aliceId}/profile`);
  await frame(alice).locator("#watch-note").click();
  await frame(bob).locator("#note-path").fill(`data/users/${bobId}/profile`);
  await frame(bob).locator("#watch-note").click();

  await frame(alice).locator("#note").fill("alpha");
  await frame(alice).locator("#save-note").click();
  await frame(bob).locator("#note").fill("bravo");
  await frame(bob).locator("#save-note").click();

  // Two documents under one prefix, each private to the viewer who owns it.
  await expect(frame(alice).locator("#note-view")).toHaveText("alpha", { timeout: 15_000 });
  await expect(frame(bob).locator("#note-view")).toHaveText("bravo", { timeout: 15_000 });

  // Bob reads Alice's actual subtree: a document that does not exist.
  await frame(bob).locator("#peek-path").fill(`data/users/${aliceId}/profile`);
  await frame(bob).locator("#peek").click();
  await expect(frame(bob).locator("#peek-result")).toHaveAttribute("data-exists", "no", {
    timeout: 15_000,
  });
  // And writing into it is `invalid_argument`, never a permission code.
  await frame(bob).locator("#poke").click();
  await expect(frame(bob).locator("#poke-result")).toHaveAttribute(
    "data-code",
    "invalid_argument",
    { timeout: 15_000 },
  );
  // Alice's note is untouched.
  await expect(frame(alice).locator("#note-view")).toHaveText("alpha");

  // And Bob's own document is there under his own id.
  await frame(bob).locator("#peek-path").fill(`data/users/${bobId}/profile`);
  await frame(bob).locator("#peek").click();
  await expect(frame(bob).locator("#peek-result")).toHaveAttribute("data-exists", "yes", {
    timeout: 15_000,
  });

  /* ---------------------------- the grammar ---------------------------- */

  await frame(alice).locator("#grammar").click();
  await expect(frame(alice).locator("#grammar-result")).toHaveAttribute("data-thrown", "yes");
  await expect(frame(alice).locator("#grammar-result")).toHaveAttribute("data-name", "TypeError");
  await expect(frame(alice).locator("#grammar-result")).toContainText("even number of segments");

  expect(errors).toEqual([]);
  await alice.context().close();
  await bob.context().close();
});

test("the page-facing surface behaves as db.d.ts documents it", async ({ browser }) => {
  const errors: string[] = [];
  const id = await createArtifact();
  const page = await openViewer(browser, id, errors);
  const content = page.frames().find((f) => f.url().includes("/_f/"));
  expect(content).toBeTruthy();

  const results = await content!.evaluate(async () => {
    const db = (await (
      window as unknown as { claude: { use(name: string): Promise<Record<string, any>> } }
    ).claude.use("db"))!;

    const outcome = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
        return "resolved";
      } catch (err) {
        const e = err as { code?: string; message?: string };
        return String(e.code);
      }
    };

    const ref = db.doc("suite/one");
    const snapBefore = await ref.get();
    await ref.set({ n: 1, nested: { a: 1 } });
    await ref.update({ nested: { b: 2 } });
    const snapAfter = await ref.get();

    const added = await db.collection("suite").add({ n: 2 });
    const all = await db.collection("suite").orderBy("n").get();

    const lease = await db.doc("locks/turn").acquire({ holder: "tab-1", ttlMs: 5000 });
    const busy = await db.doc("locks/turn").acquire({ holder: "tab-2" });

    // Two live subscriptions on the same document keep their own identity.
    const seen: number[] = [];
    const stop = ref.onSnapshot((snap: { data(): { n: number } }) => seen.push(snap.data().n));
    await new Promise((r) => setTimeout(r, 300));
    stop();
    stop(); // idempotent
    await ref.set({ n: 99 });
    await new Promise((r) => setTimeout(r, 300));

    return {
      existsBefore: snapBefore.exists,
      dataBefore: snapBefore.data() === undefined,
      idBefore: snapBefore.id,
      merged: snapAfter.data(),
      frozenBody: Object.isFrozen(snapAfter.data()),
      addedIdLength: added.id.length,
      addedPath: added.path,
      querySize: all.size,
      queryEmpty: all.empty,
      queryFrozen: Object.isFrozen(all),
      queryChanges: all.docChanges().map((c: { type: string }) => c.type),
      leaseGranted: lease.acquired && lease.holder === "tab-1",
      busy: busy.acquired === false && busy.holder === undefined && typeof busy.expiresAt === "string",
      seenAfterUnsubscribe: seen,
      // Every method rejects rather than throwing, with the store's codes.
      badBody: await outcome(() => ref.set("not an object" as never)),
      updateMissing: await outcome(() => db.doc("suite/ghost").update({ a: 1 })),
      badLimit: await outcome(() => db.collection("suite").limit(0).get()),
      badOperator: await outcome(() => db.collection("suite").where("n", "~", 1).get()),
      // Building a ref is synchronous and throws a TypeError.
      docParity: (() => {
        try {
          db.doc("suite");
          return "no throw";
        } catch (err) {
          return (err as Error).name;
        }
      })(),
      collectionParity: (() => {
        try {
          db.collection("suite/one");
          return "no throw";
        } catch (err) {
          return (err as Error).name;
        }
      })(),
      badSegment: (() => {
        try {
          db.doc("suite/a b");
          return "no throw";
        } catch (err) {
          return (err as Error).name;
        }
      })(),
      // A ref built from a ref keeps the parity right.
      nestedPath: db.doc("suite/one").collection("notes").doc("n1").path,
      // A query the store would refuse reaches the error callback, not a throw.
      subscribeError: await new Promise<string>((resolve) => {
        const off = db.collection("suite").limit(0).onSnapshot(
          () => resolve("delivered"),
          (e: { code: string }) => resolve(e.code),
        );
        setTimeout(() => {
          off();
          resolve("silent");
        }, 2000);
      }),
      // The cap is 64 per view: this page already holds the fixture's one
      // (the task query), so 63 more are accepted and every one after that
      // is refused on the error callback.
      overLimit: await new Promise<string[]>((resolve) => {
        const stops: Array<() => void> = [];
        const refusals: string[] = [];
        for (let i = 0; i < 70; i++) {
          stops.push(ref.onSnapshot(() => undefined, (e: { code: string }) => refusals.push(e.code)));
        }
        setTimeout(() => {
          for (const stop of stops) stop();
          resolve(refusals);
        }, 500);
      }),
    };
  });

  expect(results.existsBefore).toBe(false);
  expect(results.dataBefore).toBe(true);
  expect(results.idBefore).toBe("one");
  expect(results.merged).toEqual({ n: 1, nested: { a: 1, b: 2 } });
  expect(results.frozenBody).toBe(true);
  expect(results.addedIdLength).toBe(20);
  expect(results.addedPath).toMatch(/^suite\/[a-z0-9]{20}$/);
  expect(results.querySize).toBe(2);
  expect(results.queryEmpty).toBe(false);
  expect(results.queryFrozen).toBe(true);
  expect(results.queryChanges).toEqual(["added", "added"]);
  expect(results.leaseGranted).toBe(true);
  expect(results.busy).toBe(true);
  expect(results.seenAfterUnsubscribe).toEqual([1]);
  expect(results.badBody).toBe("invalid_argument");
  expect(results.updateMissing).toBe("invalid_argument");
  expect(results.badLimit).toBe("invalid_argument");
  expect(results.badOperator).toBe("invalid_argument");
  expect(results.docParity).toBe("TypeError");
  expect(results.collectionParity).toBe("TypeError");
  expect(results.badSegment).toBe("TypeError");
  expect(results.nestedPath).toBe("suite/one/notes/n1");
  expect(results.subscribeError).toBe("invalid_argument");
  expect(results.overLimit).toEqual(Array.from({ length: 70 - 63 }, () => "resource_exhausted"));

  expect(errors).toEqual([]);
  await page.context().close();
});
