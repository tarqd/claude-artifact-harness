/**
 * The `__frame_nav` gate: the page can post the message itself, so the shell
 * opens a tab only for a real gesture, only into a live frame, and only every
 * `NAV_MIN_INTERVAL_MS`. The second half drives the real `FrameHost` over a
 * minimal DOM to prove the gate is actually wired to the iframe's `inert` and
 * to `navigator.userActivation`, not just to a unit-testable helper.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameHost } from "../../src/shell/host.ts";
import { browserActivation, createNavGate, NAV_MIN_INTERVAL_MS, type NavHost } from "../../src/shell/nav.ts";
import type { ShellBoot } from "../../src/shell/types.ts";

function gate(overrides: Partial<NavHost> = {}) {
  const opened: string[] = [];
  let clock = 100_000;
  const host: NavHost = {
    isActivated: () => true,
    isFrameInert: () => false,
    now: () => clock,
    open: (url) => opened.push(url),
    ...overrides,
  };
  return {
    opened,
    gate: createNavGate(host),
    advance(ms: number): void {
      clock += ms;
    },
  };
}

describe("the nav gate", () => {
  it("opens a gesture-backed link into a live frame", () => {
    const g = gate();
    expect(g.gate.request("https://example.com/docs")).toBe("opened");
    expect(g.opened).toEqual(["https://example.com/docs"]);
  });

  it("refuses what is not an http(s) URL", () => {
    const g = gate();
    expect(g.gate.request("not a url")).toBe("bad_url");
    expect(g.gate.request("javascript:alert(1)")).toBe("bad_scheme");
    expect(g.gate.request("data:text/html,<script>1</script>")).toBe("bad_scheme");
    expect(g.opened).toEqual([]);
  });

  it("refuses a nav with no user activation", () => {
    const g = gate({ isActivated: () => false });
    expect(g.gate.request("https://evil.example/")).toBe("no_activation");
    expect(g.opened).toEqual([]);
  });

  it("refuses a nav while the frame is inert (pre-reveal or consent open)", () => {
    const g = gate({ isFrameInert: () => true });
    expect(g.gate.request("https://evil.example/")).toBe("frame_inert");
    expect(g.opened).toEqual([]);
  });

  it("rate limits a burst to one tab per interval", () => {
    const g = gate();
    expect(g.gate.request("https://example.com/1")).toBe("opened");
    for (let i = 0; i < 20; i++) expect(g.gate.request("https://example.com/x")).toBe("rate_limited");
    g.advance(NAV_MIN_INTERVAL_MS - 1);
    expect(g.gate.request("https://example.com/2")).toBe("rate_limited");
    g.advance(1);
    expect(g.gate.request("https://example.com/3")).toBe("opened");
    expect(g.opened).toEqual(["https://example.com/1", "https://example.com/3"]);
  });

  it("does not let a refused burst push the next real click out", () => {
    const g = gate();
    expect(g.gate.request("https://example.com/1")).toBe("opened");
    g.advance(NAV_MIN_INTERVAL_MS);
    for (let i = 0; i < 5; i++) g.gate.request("https://example.com/x");
    // The refusals above (all but the first) must not have moved the window.
    g.advance(NAV_MIN_INTERVAL_MS);
    expect(g.gate.request("https://example.com/2")).toBe("opened");
    expect(g.opened).toEqual([
      "https://example.com/1",
      "https://example.com/x",
      "https://example.com/2",
    ]);
  });

  it("reads activation from the browser, and refuses where there is none", () => {
    vi.stubGlobal("navigator", { userActivation: { isActive: true } });
    expect(browserActivation()).toBe(true);
    vi.stubGlobal("navigator", { userActivation: { isActive: false } });
    expect(browserActivation()).toBe(false);
    vi.stubGlobal("navigator", {});
    expect(browserActivation()).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* the host relay, over a minimal DOM                                   */
/* ------------------------------------------------------------------ */

interface FakeIframe {
  inert: boolean;
  contentWindow: { postMessage(): void };
  [key: string]: unknown;
}

function fakeElement(): FakeIframe {
  return {
    inert: false,
    contentWindow: { postMessage: (): void => {} },
    style: { setProperty: (): void => {} },
    dataset: {},
    classList: { add: (): void => {} },
    setAttribute: (): void => {},
    addEventListener: (): void => {},
    append: (): void => {},
    remove: (): void => {},
    getBoundingClientRect: () => ({ height: 100 }),
  };
}

const FRAME_ORIGIN = "http://a.localhost:8788";

function boot(): ShellBoot {
  return {
    artifactId: "0123456789abcdef0123456789abcdef",
    version: "v1",
    title: "t",
    frameOrigin: FRAME_ORIGIN,
    frameUrl: `${FRAME_ORIGIN}/_f/v1/index.html`,
    contract: "0.2.32",
    changes: [],
    flags: [],
    capabilities: {},
    viewer: { id: "u_test", level: "interact", canEdit: false, isOwner: false },
    versionPollMs: 0,
  };
}

/** A shell page with one mounted, revealed frame and a captured `window.open`. */
function shell(activated: boolean) {
  const listeners: ((ev: unknown) => void)[] = [];
  const opened: { url: string; target: string; features: string }[] = [];
  vi.stubGlobal("window", {
    addEventListener: (_type: string, fn: (ev: unknown) => void) => listeners.push(fn),
    removeEventListener: () => {},
    open: (url: string, target: string, features: string) => {
      opened.push({ url, target, features });
      return null;
    },
  });
  vi.stubGlobal("document", {
    createElement: () => fakeElement(),
    documentElement: { style: { setProperty: (): void => {} } },
    dispatchEvent: () => true,
  });
  vi.stubGlobal("CustomEvent", class {});
  vi.stubGlobal("navigator", { userActivation: { isActive: activated } });

  const host = new FrameHost({ container: fakeElement() as never, theme: () => "light", boot: boot() });
  host.mount();
  const iframe = (host as unknown as { iframe: FakeIframe }).iframe;
  const post = (data: unknown): void => {
    for (const fn of listeners) fn({ source: iframe.contentWindow, origin: FRAME_ORIGIN, data });
  };
  // The frame's handshake: `__frame_ready` plus `load` reveals it (un-inert).
  post({ __frame_ready: true });
  (host as unknown as { loaded: boolean }).loaded = true;
  (host as unknown as { maybeReveal(): void }).maybeReveal();
  return { host, iframe, opened, post };
}

describe("the host's __frame_nav relay", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens one tab per click, with the opener severed", () => {
    const s = shell(true);
    s.post({ __frame_nav: true, url: "https://example.com/docs", newTab: true });
    expect(s.opened).toEqual([
      { url: "https://example.com/docs", target: "_blank", features: "noopener,noreferrer" },
    ]);
    s.host.destroy();
  });

  it("ignores a gesture-free burst from the page (finding 6)", () => {
    const s = shell(false);
    for (let i = 0; i < 5; i++) {
      s.post({ __frame_nav: true, url: `https://evil.example/${i}`, newTab: true });
    }
    expect(s.opened).toEqual([]);
    s.host.destroy();
  });

  it("rate limits a burst that does carry a gesture", () => {
    const s = shell(true);
    for (let i = 0; i < 5; i++) {
      s.post({ __frame_nav: true, url: `https://evil.example/${i}`, newTab: true });
    }
    expect(s.opened.map((o) => o.url)).toEqual(["https://evil.example/0"]);
    s.host.destroy();
  });

  it("ignores a nav while a consent dialog holds the frame inert", () => {
    const s = shell(true);
    s.iframe.inert = true;
    s.post({ __frame_nav: true, url: "https://evil.example/", newTab: true });
    expect(s.opened).toEqual([]);
    s.host.destroy();
  });
});
