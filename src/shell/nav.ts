/**
 * The `__frame_nav` gate.
 *
 * Relaying a nav is the one place where the page's own JavaScript reaches
 * `window.open` on the shell origin, and nothing about the message proves a
 * link was clicked: a page can `parent.postMessage({__frame_nav: true, …})`
 * in a loop, with no anchor and no gesture, including while a consent dialog
 * holds the iframe inert. So the shell applies the platform's gates
 * (`analysis/shell.md` §4.3) before it opens anything: transient user
 * activation on the shell document, an iframe that is not inert (not
 * pre-reveal, no decision surface up), and a minimum interval between opens.
 */

/** Minimum gap between two relayed navigations, ms (`NAV_MIN_INTERVAL_MS`). */
export const NAV_MIN_INTERVAL_MS = 300;

/** Why a nav was refused, or `"opened"` when it was relayed. */
export type NavOutcome =
  | "opened"
  | "bad_url"
  | "bad_scheme"
  | "no_activation"
  | "frame_inert"
  | "rate_limited";

export interface NavHost {
  /** Transient user activation on the shell document. */
  isActivated(): boolean;
  /**
   * True while the frame may not act on the viewer's behalf: it has not been
   * revealed yet, or a consent dialog has made it inert.
   */
  isFrameInert(): boolean;
  now(): number;
  /** Open the URL, severing the opener as claude.ai does. */
  open(url: string): void;
}

export interface NavGate {
  /** Apply the gates to one `__frame_nav`, opening it if all of them pass. */
  request(url: string): NavOutcome;
}

export function createNavGate(host: NavHost): NavGate {
  let lastOpen = Number.NEGATIVE_INFINITY;
  return {
    request(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return "bad_url";
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "bad_scheme";
      // A gesture the browser attributes to this page, not one the message
      // claims: activation propagates to the shell from a click in the frame.
      if (!host.isActivated()) return "no_activation";
      if (host.isFrameInert()) return "frame_inert";
      const now = host.now();
      if (now - lastOpen < NAV_MIN_INTERVAL_MS) return "rate_limited";
      // Only an opened tab moves the window: a refused burst cannot push the
      // next legitimate click past the interval.
      lastOpen = now;
      host.open(parsed.href);
      return "opened";
    },
  };
}

/** `navigator.userActivation` where the browser has it; no gesture where it does not. */
export function browserActivation(): boolean {
  return typeof navigator !== "undefined" && navigator.userActivation?.isActive === true;
}
