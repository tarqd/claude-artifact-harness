/**
 * The frame side of `user`, driven through a fake `RpcHost` — no browser,
 * no shell. What matters here is the contract's hardest promise: no method
 * ever rejects, whatever the shell says or fails to say.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAP_BUDGETS } from "../../src/protocol/messages.ts";
import type { RpcEvent, RpcHost } from "../../src/frame/rpc.ts";
import type { FrameContext } from "../../src/frame/types.ts";
import { avatarDataUri, colorForId } from "../../src/capabilities/user/identity.ts";
import {
  createUser,
  readConfig,
  unresolvedProfile,
  USER_TIMEOUT_MS,
  type UserNamespace,
  type VisibilityDoc,
} from "../../src/capabilities/user/frame.ts";

const OWNER = "u_ownerownerownerownerab";
const PEER = "u_peerpeerpeerpeerpeerpp";
const STRANGER = "u_strangerstrangerstrang";

interface Sent {
  message: Record<string, unknown>;
  targetOrigin: string;
}

interface FakeHost extends RpcHost {
  sent: Sent[];
  deliver(data: unknown, from?: { origin?: string; source?: unknown }): void;
  /** Reply to the nth call this host has seen. */
  reply(index: number, result: unknown): void;
  fail(index: number, code: string, message?: string): void;
  idOf(index: number): string;
}

function fakeHost(): FakeHost {
  const sent: Sent[] = [];
  const handlers: Array<(ev: RpcEvent) => void> = [];
  const host: FakeHost = {
    sent,
    post(message, targetOrigin) {
      sent.push({ message: message as Record<string, unknown>, targetOrigin });
    },
    listen(handler) {
      handlers.push(handler);
      return () => handlers.splice(handlers.indexOf(handler), 1);
    },
    accepts: (ev) => ev.origin === "http://shell.test" && ev.source === "parent",
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    deliver(data, from) {
      const ev: RpcEvent = {
        data,
        origin: from?.origin ?? "http://shell.test",
        source: from && "source" in from ? from.source : "parent",
      };
      for (const handler of [...handlers]) handler(ev);
    },
    idOf(index) {
      return sent[index]?.message.id as string;
    },
    reply(index, result) {
      host.deliver({ __frame_cap_r: true, id: host.idOf(index), result });
    },
    fail(index, code, message = "refused") {
      host.deliver({ __frame_cap_r: true, id: host.idOf(index), error: { code, message } });
    },
  };
  return host;
}

/** A fake `document` whose visibility can be flipped from a test. */
function fakeDoc(): VisibilityDoc & { show(): void; hide(): void } {
  const listeners: Array<() => void> = [];
  let state = "visible";
  return {
    get visibilityState() {
      return state;
    },
    addEventListener(type, listener) {
      if (type === "visibilitychange") listeners.push(listener);
    },
    show() {
      state = "visible";
      for (const l of [...listeners]) l();
    },
    hide() {
      state = "hidden";
      for (const l of [...listeners]) l();
    },
  };
}

function context(config: unknown): FrameContext {
  return {
    shellOrigin: "http://shell.test",
    capabilities: { user: { config } },
    capBudgets: CAP_BUDGETS,
    changes: new Set(),
    flags: new Set(),
    hooks: {},
    mount: () => undefined,
    pipe: () => ({
      // Exactly what the preamble does: a synchronous throw becomes a rejection.
      wrap<A extends unknown[], R>(_method: string, fn: (...args: A) => R | Promise<R>) {
        return (...args: A): Promise<R> => {
          try {
            return Promise.resolve(fn(...args));
          } catch (err) {
            return Promise.reject(err);
          }
        };
      },
    }),
  };
}

const FULL = { id: OWNER, owner: true, canEdit: true, profile: true, email: false };

function makeUser(
  config: unknown = FULL,
  host: FakeHost = fakeHost(),
  doc: VisibilityDoc | null = null,
): { user: UserNamespace; host: FakeHost } {
  const user = createUser(context(config), { host, doc });
  return { user, host };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readConfig", () => {
  it("reads the documented shape", () => {
    expect(readConfig({ id: OWNER, owner: true, canEdit: true, profile: true, email: true })).toEqual(
      { id: OWNER, owner: true, canEdit: true, profile: true, email: true },
    );
  });

  it("is conservative about anything missing or malformed", () => {
    const empty = { id: null, owner: false, canEdit: false, profile: false, email: false };
    expect(readConfig(undefined)).toEqual(empty);
    expect(readConfig(null)).toEqual(empty);
    expect(readConfig("nope")).toEqual(empty);
    expect(readConfig({ id: "", owner: "yes", canEdit: 1, profile: "true" })).toEqual(empty);
  });
});

describe("local members", () => {
  it("answer from config without a single message to the shell", async () => {
    const { user, host } = makeUser();
    await expect(user.id()).resolves.toBe(OWNER);
    await expect(user.isOwner()).resolves.toBe(true);
    await expect(user.canEdit()).resolves.toBe(true);
    expect(host.sent).toEqual([]);
  });

  it("report a viewer with no identity as null/false", async () => {
    const { user } = makeUser({});
    await expect(user.id()).resolves.toBeNull();
    await expect(user.isOwner()).resolves.toBe(false);
    await expect(user.canEdit()).resolves.toBe(false);
  });
});

describe("profile-backed members", () => {
  it("send `profile` with the `u` id prefix and no arguments", async () => {
    const { user, host } = makeUser();
    const pending = user.name();
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]!.targetOrigin).toBe("http://shell.test");
    expect(host.sent[0]!.message).toMatchObject({
      __frame_cap: true,
      cap: "user",
      method: "profile",
      args: [],
    });
    expect(String(host.sent[0]!.message.id).startsWith("u")).toBe(true);
    host.reply(0, { id: OWNER, name: "Ada", avatarUrl: null });
    await expect(pending).resolves.toBe("Ada");
  });

  it("cache the answer: a second read sends nothing", async () => {
    const { user, host } = makeUser();
    const first = user.name();
    host.reply(0, { id: OWNER, name: "Ada", avatarUrl: null });
    await first;
    await expect(user.name()).resolves.toBe("Ada");
    expect(host.sent).toHaveLength(1);
  });

  it("answer null when the profile has no picture (only me() fills in the circle)", async () => {
    const { user, host } = makeUser();
    const pending = user.avatarUrl();
    host.reply(0, { id: OWNER, name: "Ada", avatarUrl: null });
    await expect(pending).resolves.toBeNull();
    await expect(user.me()).resolves.toMatchObject({ avatarUrl: avatarDataUri(OWNER) });
  });

  it("prefer a stored picture when there is one", async () => {
    const { user, host } = makeUser();
    const pending = user.avatarUrl();
    host.reply(0, { id: OWNER, name: "Ada", avatarUrl: "https://pics.test/ada.png" });
    await expect(pending).resolves.toBe("https://pics.test/ada.png");
  });

  it("never call the backend when the artifact has no profile scope", async () => {
    const { user, host } = makeUser({ ...FULL, profile: false });
    await expect(user.name()).resolves.toBe("");
    const me = await user.me();
    expect(me).toEqual({
      id: OWNER,
      name: "",
      avatarUrl: avatarDataUri(OWNER),
      color: colorForId(OWNER),
      email: null,
      isOwner: true,
      canEdit: true,
    });
    expect(host.sent).toEqual([]);
  });

  it("give a viewer with no id a null avatar but still a colour", async () => {
    const { user, host } = makeUser({ owner: false, canEdit: false, profile: true });
    await expect(user.avatarUrl()).resolves.toBeNull();
    const me = await user.me();
    expect(me.id).toBeNull();
    expect(me.avatarUrl).toBeNull();
    expect(me.color).toBe(colorForId(""));
    expect(host.sent).toEqual([]);
  });
});

describe("me()", () => {
  it("assembles the documented record from one profile call", async () => {
    const { user, host } = makeUser();
    const pending = user.me();
    host.reply(0, { id: OWNER, name: "Ada", avatarUrl: null });
    await expect(pending).resolves.toEqual({
      id: OWNER,
      name: "Ada",
      avatarUrl: avatarDataUri(OWNER),
      color: colorForId(OWNER),
      email: null,
      isOwner: true,
      canEdit: true,
    });
  });

  it("asks for the address only when the email scope was granted", async () => {
    const granted = makeUser({ ...FULL, email: true });
    const pending = granted.user.me();
    expect(granted.host.sent.map((s) => s.message.method)).toEqual(["profile", "email"]);
    granted.host.reply(0, { id: OWNER, name: "Ada", avatarUrl: null });
    granted.host.reply(1, { email: "ada@example.test" });
    await expect(pending).resolves.toMatchObject({ email: "ada@example.test" });

    const denied = makeUser();
    const second = denied.user.me();
    expect(denied.host.sent.map((s) => s.message.method)).toEqual(["profile"]);
    denied.host.reply(0, { id: OWNER, name: "Ada", avatarUrl: null });
    await expect(second).resolves.toMatchObject({ email: null });
  });

  it("reads v0's `{email: null}` as no address", async () => {
    const { user, host } = makeUser({ ...FULL, email: true });
    const pending = user.email();
    host.reply(0, { email: null });
    await expect(pending).resolves.toBeNull();
  });
});

describe("failure is always benign", () => {
  it("turns a refusal into the empty defaults", async () => {
    const { user, host } = makeUser();
    const name = user.name();
    host.fail(0, "not_granted", "no");
    await expect(name).resolves.toBe("");

    const me = user.me();
    host.fail(1, "unavailable");
    await expect(me).resolves.toMatchObject({ name: "", avatarUrl: avatarDataUri(OWNER) });
  });

  it("turns a malformed reply into the empty defaults", async () => {
    const { user, host } = makeUser();
    const name = user.name();
    host.reply(0, { nothing: "useful" });
    await expect(name).resolves.toBe("");
  });

  it("resolves null after the 20 s budget instead of rejecting", async () => {
    vi.useFakeTimers();
    const { user, host } = makeUser();
    const pending = user.me();
    expect(host.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(USER_TIMEOUT_MS + 10);
    await expect(pending).resolves.toMatchObject({ id: OWNER, name: "" });
  });

  it("never rejects, whatever it is handed", async () => {
    const { user } = makeUser();
    await expect(user.profiles(undefined)).resolves.toEqual({});
    await expect(user.profiles("not-an-array")).resolves.toEqual({});
    await expect(user.search(null)).resolves.toEqual([]);
    await expect(user.search("")).resolves.toEqual([]);
  });
});

describe("profiles()", () => {
  it("sends only well-formed ids and answers for every id asked", async () => {
    const { user, host } = makeUser();
    const pending = user.profiles([PEER, "not-an-id", PEER, "", 7]);
    expect(host.sent[0]!.message).toMatchObject({ method: "profiles", args: [[PEER]] });
    host.reply(0, { [PEER]: { id: PEER, name: "Grace", avatarUrl: null } });

    const map = await pending;
    expect(Object.keys(map)).toEqual([PEER, "not-an-id"]);
    expect(map[PEER]).toEqual({
      id: PEER,
      name: "Grace",
      avatarUrl: avatarDataUri(PEER),
      color: colorForId(PEER),
      email: null,
      isMe: false,
    });
    // An id that could never be a viewer never reaches the wire, and gets
    // the same placeholder as one the directory did not know.
    expect(map["not-an-id"]).toEqual(unresolvedProfile("not-an-id", false));
  });

  it("marks the viewer's own id", async () => {
    const { user, host } = makeUser();
    const pending = user.profiles([OWNER, PEER]);
    host.reply(0, {});
    const map = await pending;
    expect(map[OWNER]!.isMe).toBe(true);
    expect(map[PEER]!.isMe).toBe(false);
  });

  it("leaves unresolved ids resolvable later, but does not re-ask for known ones", async () => {
    const { user, host } = makeUser();
    const first = user.profiles([PEER, STRANGER]);
    host.reply(0, { [PEER]: { id: PEER, name: "Grace", avatarUrl: null } });
    await first;

    const second = user.profiles([PEER, STRANGER]);
    expect(host.sent[1]!.message).toMatchObject({ args: [[STRANGER]] });
    host.reply(1, { [STRANGER]: { id: STRANGER, name: "Alan", avatarUrl: null } });
    const map = await second;
    expect(map[PEER]!.name).toBe("Grace");
    expect(map[STRANGER]!.name).toBe("Alan");
  });

  it("answers for every id asked, even past the 128-id wire batch", async () => {
    const { user, host } = makeUser();
    const many = Array.from({ length: 200 }, (_, i) => `u_${String(i).padStart(22, "0")}`);
    const pending = user.profiles(many);
    // The wire batch stays at 128; the rest is a second batch.
    expect((host.sent[0]!.message.args as string[][])[0]).toHaveLength(128);
    host.reply(0, {});
    await vi.waitFor(() => expect(host.sent).toHaveLength(2));
    host.reply(1, {});
    const map = await pending;
    // The page can index the map for anything it asked about.
    expect(Object.keys(map)).toHaveLength(200);
    expect(map[many[199] as string]).toEqual(unresolvedProfile(many[199] as string, false));
  });

  it("skips the backend entirely without the profile scope", async () => {
    const { user, host } = makeUser({ ...FULL, profile: false });
    const map = await user.profiles([PEER]);
    expect(map[PEER]).toEqual(unresolvedProfile(PEER, false));
    expect(host.sent).toEqual([]);
  });
});

describe("one call for concurrent readers", () => {
  it("shares a single `profile` (and `email`) round trip", async () => {
    const { user, host } = makeUser({ ...FULL, email: true });
    const all = Promise.all([user.name(), user.avatarUrl(), user.me(), user.email()]);
    expect(host.sent.map((s) => s.message.method)).toEqual(["profile", "email"]);
    host.reply(0, { id: OWNER, name: "Ada", avatarUrl: null });
    host.reply(1, { email: "ada@example.test" });
    const [name, avatar, me, email] = await all;
    expect(name).toBe("Ada");
    expect(avatar).toBeNull();
    expect(me).toMatchObject({ name: "Ada", email: "ada@example.test" });
    expect(email).toBe("ada@example.test");
    expect(host.sent).toHaveLength(2);
  });
});

describe("the cache and tab visibility", () => {
  it("is dropped when the tab becomes visible again", async () => {
    const doc = fakeDoc();
    const { user, host } = makeUser(FULL, fakeHost(), doc);

    const first = user.name();
    host.reply(0, { id: OWNER, name: "Ada", avatarUrl: null });
    await first;
    expect(host.sent).toHaveLength(1);

    doc.hide();
    await expect(user.name()).resolves.toBe("Ada"); // still cached while hidden
    expect(host.sent).toHaveLength(1);

    doc.show();
    const again = user.name();
    expect(host.sent).toHaveLength(2);
    host.reply(1, { id: OWNER, name: "Ada Lovelace", avatarUrl: null });
    await expect(again).resolves.toBe("Ada Lovelace");
  });

  it("is not repopulated by a reply that was already in flight", async () => {
    const doc = fakeDoc();
    const { user, host } = makeUser(FULL, fakeHost(), doc);

    const pending = user.name();
    doc.show(); // the tab comes back while the first call is still out
    host.reply(0, { id: OWNER, name: "STALE", avatarUrl: null });
    await expect(pending).resolves.toBe("STALE"); // its own caller is answered

    // ...but the cleared cache stayed cleared: the next read refetches.
    const again = user.name();
    expect(host.sent).toHaveLength(2);
    host.reply(1, { id: OWNER, name: "Ada Lovelace", avatarUrl: null });
    await expect(again).resolves.toBe("Ada Lovelace");
  });

  it("drops a directory reply that raced the clear instead of caching it", async () => {
    const doc = fakeDoc();
    const { user, host } = makeUser(FULL, fakeHost(), doc);

    const pending = user.profiles([PEER]);
    doc.show();
    host.reply(0, { [PEER]: { id: PEER, name: "Grace", avatarUrl: null } });
    const map = await pending;
    expect(map[PEER]!.name).toBe("Grace"); // the caller still gets its answer

    void user.profiles([PEER]);
    expect(host.sent).toHaveLength(2); // and the id is asked about again
  });
});

describe("search()", () => {
  it("trims the query to 100 characters and skips an empty one", async () => {
    const { user, host } = makeUser();
    const pending = user.search(`  ${"x".repeat(300)}  `);
    expect((host.sent[0]!.message.args as string[])[0]).toHaveLength(100);
    host.reply(0, []);
    await expect(pending).resolves.toEqual([]);

    await expect(user.search("   ")).resolves.toEqual([]);
    expect(host.sent).toHaveLength(1);
  });

  it("maps rows to profiles with colours and isMe", async () => {
    const { user, host } = makeUser();
    const pending = user.search("a");
    host.reply(0, [
      { id: PEER, name: "Grace", avatarUrl: null },
      { id: OWNER, name: "Ada", avatarUrl: null },
      { name: "no id" },
    ]);
    const rows = await pending;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: PEER, name: "Grace", color: colorForId(PEER), isMe: false });
    expect(rows[1]).toMatchObject({ id: OWNER, isMe: true });
  });

  it("lets the latest call win: a superseded one resolves with the newest rows", async () => {
    const { user, host } = makeUser();
    const stale = user.search("ad");
    const fresh = user.search("ada");
    // The newest reply lands first, then the stale one.
    host.reply(1, [{ id: OWNER, name: "Ada", avatarUrl: null }]);
    host.reply(0, [{ id: PEER, name: "Grace", avatarUrl: null }]);
    await expect(fresh).resolves.toMatchObject([{ name: "Ada" }]);
    await expect(stale).resolves.toMatchObject([{ name: "Ada" }]);
  });

  it("lets an emptied query supersede an in-flight search", async () => {
    const { user, host } = makeUser();
    const stale = user.search("ad");
    // The box is cleared while "ad" is still out; nothing goes on the wire.
    await expect(user.search("")).resolves.toEqual([]);
    expect(host.sent).toHaveLength(1);
    host.reply(0, [{ id: PEER, name: "Grace", avatarUrl: null }]);
    // The stale rows must not repaint the list the page just emptied.
    await expect(stale).resolves.toEqual([]);
  });

  it("needs the profile scope", async () => {
    const { user, host } = makeUser({ ...FULL, profile: false });
    await expect(user.search("ada")).resolves.toEqual([]);
    expect(host.sent).toEqual([]);
  });
});
