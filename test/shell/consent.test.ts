/**
 * The shell's consent dialog — the one surface that turns a page's ask into a
 * sticky grant, so its input handling is a security control (security review
 * 2026-09, finding 5).
 *
 * The rules pinned here: the iframe is inert while a dialog is up, no button
 * is focused when it opens (a keypress the page timed activates nothing), and
 * "Allow" ignores every activation for the first 500 ms. Refusing — the
 * cancel button and Escape — is never delayed.
 *
 * Nothing here needs a browser: `fakeDom()` is the handful of DOM calls
 * `consent.ts` makes, plus the two activation rules a real browser applies
 * (a disabled button gets no click; Enter/Space on a focused button clicks).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConsent, CONSENT_SETTLE_MS } from "../../src/shell/consent.ts";

/* --------------------------------- fake DOM -------------------------------- */

interface FakeEvent {
  key?: string;
  type: string;
}

class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  id = "";
  className = "";
  textContent = "";
  type = "";
  disabled = false;
  tabIndex = 0;
  inert = false;
  readonly attributes = new Map<string, string>();
  readonly listeners: Array<{ type: string; fn: (ev: FakeEvent) => void }> = [];

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, fn: (ev: FakeEvent) => void): void {
    this.listeners.push({ type, fn });
  }

  remove(): void {
    const parent = this.parent;
    if (!parent) return;
    const at = parent.children.indexOf(this);
    if (at !== -1) parent.children.splice(at, 1);
    this.parent = null;
  }

  focus(): void {
    focused = this;
  }

  /** Bubble an event from this node up through its ancestors. */
  dispatch(ev: FakeEvent): void {
    // A disabled control is not an event target in a real browser.
    if (ev.type === "click" && this.disabled) return;
    for (let node: FakeElement | null = this; node; node = node.parent) {
      for (const entry of [...node.listeners]) {
        if (entry.type === ev.type) entry.fn(ev);
      }
    }
  }

  /** Depth-first search, the stand-in for `querySelector`. */
  find(match: (el: FakeElement) => boolean): FakeElement | null {
    for (const child of this.children) {
      if (match(child)) return child;
      const deeper = child.find(match);
      if (deeper) return deeper;
    }
    return null;
  }

  all(match: (el: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.children) {
      if (match(child)) out.push(child);
      out.push(...child.all(match));
    }
    return out;
  }
}

let focused: FakeElement | null = null;
let body: FakeElement;
let head: FakeElement;

function fakeDom(): void {
  focused = null;
  body = new FakeElement("body");
  head = new FakeElement("head");
  const document = {
    body,
    head,
    createElement: (tag: string) => new FakeElement(tag),
    getElementById: (id: string) =>
      head.find((el) => el.id === id) ?? body.find((el) => el.id === id),
  };
  Object.defineProperty(globalThis, "document", {
    value: document,
    configurable: true,
    writable: true,
  });
}

function removeDom(): void {
  Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, "document");
}

/** What a real browser does with Enter/Space on the focused element. */
function pressKey(key: string): void {
  const target = focused;
  if (!target) return;
  target.dispatch({ type: "keydown", key });
  if ((key === "Enter" || key === " ") && target.tagName === "button") {
    target.dispatch({ type: "click" });
  }
}

/* -------------------------------- fixtures -------------------------------- */

function dialogParts() {
  const buttons = body.all((el) => el.tagName === "button");
  const confirm = buttons.find((el) => el.className.includes("primary")) ?? null;
  const cancel = buttons.find((el) => !el.className.includes("primary")) ?? null;
  const dialog = body.find((el) => el.className === "shell-consent");
  return { confirm, cancel, dialog, count: body.children.length };
}

function host() {
  const frame = new FakeElement("iframe");
  frame.inert = false;
  let restored = 0;
  return {
    frame: () => frame as unknown as HTMLIFrameElement,
    restoreInert: () => {
      frame.inert = false;
      restored++;
    },
    iframe: frame,
    get restored() {
      return restored;
    },
  };
}

const REQUEST = { title: "Let this artifact ask Claude?", body: "…" };

beforeEach(() => {
  vi.useFakeTimers();
  fakeDom();
});

afterEach(() => {
  vi.useRealTimers();
  removeDom();
});

/* ---------------------------------- tests --------------------------------- */

describe("the consent dialog", () => {
  it("makes the iframe inert while it is open and restores it after", async () => {
    const h = host();
    const consent = createConsent(h);
    const answer = consent.ask(REQUEST);
    expect(h.iframe.inert).toBe(true);
    expect(consent.isOpen).toBe(true);

    vi.advanceTimersByTime(CONSENT_SETTLE_MS);
    dialogParts().confirm?.dispatch({ type: "click" });
    expect(await answer).toBe(true);
    expect(consent.isOpen).toBe(false);
    expect(h.restored).toBe(1);
  });

  it("focuses no button, so a keypress in flight activates nothing", async () => {
    const consent = createConsent(host());
    const answer = consent.ask(REQUEST);
    const { confirm, cancel, dialog } = dialogParts();

    // The dialog itself takes focus (Escape still reaches it), not a button.
    expect(focused).toBe(dialog);
    expect(focused).not.toBe(confirm);
    expect(focused).not.toBe(cancel);

    // The page timed `request()` under a held key: nothing is decided.
    pressKey("Enter");
    pressKey(" ");
    let settled: boolean | null = null;
    void answer.then((v) => (settled = v));
    await Promise.resolve();
    expect(settled).toBeNull();

    // The viewer can still answer once they have read the question.
    vi.advanceTimersByTime(CONSENT_SETTLE_MS);
    dialogParts().confirm?.dispatch({ type: "click" });
    expect(await answer).toBe(true);
  });

  it("ignores an Allow click that lands before the input settles", async () => {
    const consent = createConsent(host());
    const answer = consent.ask(REQUEST);
    const { confirm } = dialogParts();
    expect(confirm?.disabled).toBe(true);

    // A click the page timed under the viewer's pointer: not a decision.
    confirm?.dispatch({ type: "click" });
    let settled: boolean | null = null;
    void answer.then((v) => (settled = v));
    await Promise.resolve();
    expect(settled).toBeNull();
    expect(body.children).toHaveLength(1);

    vi.advanceTimersByTime(CONSENT_SETTLE_MS);
    expect(confirm?.disabled).toBe(false);
    confirm?.dispatch({ type: "click" });
    expect(await answer).toBe(true);
  });

  it("keyboard-activates Allow once the delay has passed", async () => {
    const consent = createConsent(host());
    const answer = consent.ask(REQUEST);
    vi.advanceTimersByTime(CONSENT_SETTLE_MS);
    const { confirm } = dialogParts();
    confirm?.focus();
    pressKey("Enter");
    expect(await answer).toBe(true);
  });

  it("lets the viewer refuse immediately, by button or by Escape", async () => {
    const consent = createConsent(host());
    const first = consent.ask(REQUEST);
    dialogParts().cancel?.dispatch({ type: "click" });
    expect(await first).toBe(false);

    const second = consent.ask(REQUEST);
    // Focus is inside the dialog, so the keydown bubbles to the backdrop.
    pressKey("Escape");
    expect(await second).toBe(false);
    expect(body.children).toHaveLength(0);
  });

  it("still grants when the wall clock steps backwards while it is open", async () => {
    // The settle delay is a timer, not a timestamp comparison: an NTP
    // correction or a VM resume between opening and the click must not leave
    // the button enabled but every click swallowed, which would make the
    // dialog a dead end with no other way to grant.
    const consent = createConsent(host());
    const answer = consent.ask(REQUEST);
    vi.setSystemTime(new Date(Date.now() - 60_000));
    vi.advanceTimersByTime(CONSENT_SETTLE_MS);
    const { confirm } = dialogParts();
    expect(confirm?.disabled).toBe(false);
    confirm?.dispatch({ type: "click" });
    expect(await answer).toBe(true);
  });

  it("holds the decision even if the button is enabled early", async () => {
    // `disabled` is the first gate and the one a browser enforces; the click
    // handler's own check is the second. Enable the button behind the
    // dialog's back to reach it — a mistimed future edit to `disabled` must
    // still not turn a page-timed click into a grant.
    const consent = createConsent(host());
    const answer = consent.ask(REQUEST);
    const { confirm } = dialogParts();
    expect(confirm).not.toBeNull();
    confirm!.disabled = false;

    confirm!.dispatch({ type: "click" });
    let settled: boolean | null = null;
    void answer.then((v) => (settled = v));
    await Promise.resolve();
    expect(settled).toBeNull();
    expect(body.children).toHaveLength(1);

    vi.advanceTimersByTime(CONSENT_SETTLE_MS);
    confirm!.dispatch({ type: "click" });
    expect(await answer).toBe(true);
  });

  it("settles each dialog on its own clock", async () => {
    const consent = createConsent(host());
    const first = consent.ask(REQUEST);
    vi.advanceTimersByTime(CONSENT_SETTLE_MS);
    dialogParts().confirm?.dispatch({ type: "click" });
    expect(await first).toBe(true);

    const second = consent.ask(REQUEST);
    expect(dialogParts().confirm?.disabled).toBe(true);
    dialogParts().confirm?.dispatch({ type: "click" });
    let settled: boolean | null = null;
    void second.then((v) => (settled = v));
    await Promise.resolve();
    expect(settled).toBeNull();
    vi.advanceTimersByTime(CONSENT_SETTLE_MS);
    dialogParts().confirm?.dispatch({ type: "click" });
    expect(await second).toBe(true);
  });
});
