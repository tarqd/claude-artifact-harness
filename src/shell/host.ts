/**
 * The host: mounts the artifact iframe, runs the handshake, reveals it, and
 * relays everything the frame posts. Attribute-for-attribute the same iframe
 * claude.ai builds (shell.md §1.4), because those attributes are the
 * security model, not decoration.
 */
import { CAP_BUDGETS, CONTRACT_VERSION, isFrameConnect, isFrameNav, isFrameReady, isFrameSize, type FrameInit, type Theme } from "../protocol/messages.ts";
import { disposeBrokers, dispatch, readCapCall } from "./broker.ts";
import { createConsent } from "./consent.ts";
import { browserActivation, createNavGate } from "./nav.ts";
import type { BrokerContext, ConsentRequest, HostOptions, ShellBoot } from "./types.ts";

const SANDBOX = "allow-scripts allow-same-origin allow-forms";
const ALLOW = "fullscreen; clipboard-write; gamepad";
/** Reveal this long after `load` even if `__frame_ready` never arrives. */
const EARLY_REVEAL_MS = 2000;
const MAX_PRINT_HEIGHT = 500_000;

export class FrameHost {
  private readonly container: HTMLElement;
  private readonly themeOf: () => Theme;
  private boot: ShellBoot;
  private iframe: HTMLIFrameElement | null = null;
  private frameOrigin: string;
  private ready = false;
  private loaded = false;
  private revealed = false;
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  private version: string;
  /** One broker context per mounted view: where a slice keeps per-view state. */
  private brokerContext: BrokerContext | null = null;
  private readonly consent = createConsent({
    frame: () => this.iframe,
    restoreInert: () => {
      const iframe = this.iframe;
      if (iframe) iframe.inert = !this.revealed;
    },
  });
  private readonly navGate = createNavGate({
    isActivated: () => browserActivation(),
    // Consent is asked before the dialog's own `inert` lands in some paths,
    // so both halves of "the frame may not act right now" are checked.
    isFrameInert: () => this.consent.isOpen || this.iframe?.inert !== false,
    now: () => Date.now(),
    open: (url) => {
      // Everything opens in a new tab, severing the opener as claude.ai does.
      window.open(url, "_blank", "noopener,noreferrer");
    },
  });
  private readonly onMessage = (ev: MessageEvent): void => this.handleMessage(ev);

  constructor(options: HostOptions) {
    this.container = options.container;
    this.themeOf = options.theme;
    this.boot = options.boot;
    this.version = options.boot.version;
    this.frameOrigin = new URL(options.boot.frameUrl).origin;
    window.addEventListener("message", this.onMessage);
  }

  /** The version this view is currently running. */
  get currentVersion(): string {
    return this.version;
  }

  mount(version = this.version): void {
    this.version = version;
    const url = new URL(this.boot.frameUrl);
    url.pathname = url.pathname.replace(/\/_f\/[^/]+\//, `/_f/${version}/`);
    this.frameOrigin = url.origin;

    const iframe = document.createElement("iframe");
    iframe.title = "User-generated artifact content";
    iframe.setAttribute("sandbox", SANDBOX);
    iframe.setAttribute("allow", ALLOW);
    iframe.setAttribute("allowfullscreen", "");
    iframe.referrerPolicy = "no-referrer";
    iframe.dataset.ver = version;
    iframe.inert = true;
    iframe.className = "frame-content";
    iframe.src = url.href;
    iframe.addEventListener("load", () => {
      this.loaded = true;
      this.maybeReveal();
      if (this.revealTimer === null) {
        this.revealTimer = setTimeout(() => {
          this.revealTimer = null;
          this.reveal();
        }, EARLY_REVEAL_MS);
      }
    });

    const previous = this.iframe;
    this.ready = false;
    this.loaded = false;
    this.revealed = false;
    this.iframe = iframe;
    // The outgoing view's brokers lose their subscriptions with its window.
    this.disposeContext();
    this.brokerContext = this.buildContext();
    this.container.append(iframe);
    if (previous) previous.remove();
  }

  destroy(): void {
    window.removeEventListener("message", this.onMessage);
    this.disposeContext();
    this.iframe?.remove();
    this.iframe = null;
  }

  private disposeContext(): void {
    const context = this.brokerContext;
    this.brokerContext = null;
    if (context) disposeBrokers(context);
  }

  /** Forward a theme change to the frame. */
  sendTheme(theme: Theme): void {
    this.post({ __frame_theme: { theme } });
  }

  private post(message: unknown): void {
    this.iframe?.contentWindow?.postMessage(message, this.frameOrigin);
  }

  private buildInit(): FrameInit {
    return {
      contract: CONTRACT_VERSION,
      changes: this.boot.changes,
      flags: this.boot.flags,
      theme: this.themeOf(),
      capabilities: this.boot.capabilities,
      capBudgets: CAP_BUDGETS,
    };
  }

  /** Built once per mounted view; `version` follows the host as it publishes. */
  private buildContext(): BrokerContext {
    const host = this;
    return {
      boot: this.boot,
      get version() {
        return host.version;
      },
      viewer: this.boot.viewer,
      flags: new Set(this.boot.flags),
      toFrame: (message) => host.post(message),
      ack: (id) => host.post({ __frame_cap_ack: true, id }),
      progress: (id, p) => host.post({ __frame_cap_p: true, id, p }),
      reloadView: (version) => host.mount(version ?? host.version),
      setVersion: (version) => {
        host.version = version;
      },
      consent: (request: ConsentRequest) => host.consent.ask(request),
      async api<T>(path: string, init?: RequestInit): Promise<T> {
        const response = await fetch(path, {
          credentials: "same-origin",
          headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
          ...init,
        });
        const text = await response.text();
        const body: unknown = text ? JSON.parse(text) : null;
        if (!response.ok) {
          throw body && typeof body === "object" ? body : { code: "upstream_error", message: text };
        }
        return body as T;
      },
    };
  }

  private handleMessage(ev: MessageEvent): void {
    const iframe = this.iframe;
    if (!iframe) return;
    if (ev.source !== iframe.contentWindow) return;
    if (ev.origin !== this.frameOrigin) return;
    const data: unknown = ev.data;

    if (isFrameConnect(data)) {
      this.post({ __frame_init: this.buildInit() });
      return;
    }
    if (isFrameReady(data)) {
      this.ready = true;
      this.maybeReveal();
      return;
    }
    if (isFrameNav(data)) {
      this.handleNav(data.url, data.newTab);
      return;
    }
    if (isFrameSize(data)) {
      const height = Math.min(Math.max(data.h, iframe.getBoundingClientRect().height), MAX_PRINT_HEIGHT);
      document.documentElement.style.setProperty("--frame-print-h", `${height}px`);
      return;
    }
    const call = readCapCall(data);
    if (call) {
      const context = this.brokerContext ?? (this.brokerContext = this.buildContext());
      void dispatch(call, context).then((reply) => this.post(reply));
    }
  }

  /**
   * Relay one `__frame_nav`. The gate — a real gesture, an interactive frame,
   * a rate limit — is what keeps a page from driving `window.open` on its own
   * (`nav.ts`). Refusals are silent, as on claude.ai.
   */
  private handleNav(url: string, _newTab: boolean): void {
    this.navGate.request(url);
  }

  private maybeReveal(): void {
    if (this.ready && this.loaded) this.reveal();
  }

  private reveal(): void {
    const iframe = this.iframe;
    if (!iframe || this.revealed) return;
    this.revealed = true;
    if (this.revealTimer !== null) {
      clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
    iframe.id = "frame-content";
    iframe.classList.add("ready");
    if (!this.consent.isOpen) iframe.inert = false;
    this.post({ __frame_size_poke: true });
    document.dispatchEvent(new CustomEvent("frame-content-settled"));
  }
}
