/**
 * The frame preamble: a clean-room reimplementation of the runtime the
 * platform injects ahead of every served artifact (surface-area.md §3).
 *
 * It runs as the first script in `<head>`, before any page markup, and is
 * responsible for: `window.claude.use()`, the `__frame_connect` /
 * `__frame_init` handshake, theme stamping, loading the capability modules,
 * `__frame_ready`, cross-origin link interception and the size reporter.
 * It never talks to a backend — everything goes through the shell.
 */
import {
  INIT_TIMEOUT_MS,
  isFrameInitMessage,
  isFrameSizePoke,
  isFrameThemeMessage,
  type CapBudgets,
  type CapabilityInit,
  type FrameInit,
  type Theme,
} from "../protocol/messages.ts";
import { capError, isCapError } from "../protocol/errors.ts";
import type { CapPipe, FrameContext } from "./types.ts";

interface PreambleConfig {
  v: 1;
  capabilities: Record<string, string>;
  origins: string[];
}

interface Deferred {
  promise: Promise<object | null>;
  resolve(value: object | null): void;
  settled: boolean;
}

interface SampleLike {
  (input: unknown): Promise<{ text?: unknown }>;
}

const RTC_GLOBALS = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "mozRTCPeerConnection",
  "RTCDataChannel",
  "RTCSessionDescription",
  "RTCIceCandidate",
  "RTCRtpSender",
] as const;

const SIZE_DEBOUNCE_MS = 200;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function readPreambleConfig(): PreambleConfig | null {
  const raw: unknown = (window as unknown as Record<string, unknown>).__FRAME_PREAMBLE;
  if (!isRecord(raw)) return null;
  const caps: Record<string, string> = {};
  if (isRecord(raw.capabilities)) {
    for (const [name, file] of Object.entries(raw.capabilities)) {
      if (typeof file === "string" && /^[A-Za-z0-9_.-]+\.js$/.test(file)) caps[name] = file;
    }
  }
  const origins: string[] = [];
  if (Array.isArray(raw.origins)) {
    for (const o of raw.origins) if (typeof o === "string" && o) origins.push(o);
  }
  return { v: 1, capabilities: caps, origins };
}

/** `scheme://host:*` wildcards are supported, as on the platform. */
function originAllowed(origin: string, allowed: readonly string[]): boolean {
  for (const entry of allowed) {
    if (entry === origin) return true;
    if (entry.endsWith(":*")) {
      const prefix = entry.slice(0, -1);
      if (origin.startsWith(prefix)) return true;
    }
  }
  return false;
}

function deferred(): Deferred {
  let resolve!: (v: object | null) => void;
  const promise = new Promise<object | null>((r) => {
    resolve = r;
  });
  const d: Deferred = {
    promise,
    settled: false,
    resolve(value) {
      if (d.settled) return;
      d.settled = true;
      resolve(value);
    },
  };
  return d;
}

/**
 * Freeze a namespace the way the platform does: a null-prototype object with
 * no `then` member, so it can never be mistaken for a thenable. A callable
 * namespace keeps its call signature and gets a frozen null-prototype
 * prototype holding only `call`, `apply` and `bind`.
 *
 * The result is cached per source object, so a module that mounts one object
 * under two names (`artifact` and `self`) hands out one identity.
 */
const hardened = new WeakMap<object, object>();

function harden(namespace: object): object {
  const cached = hardened.get(namespace);
  if (cached) return cached;
  const frozen = hardenOnce(namespace);
  hardened.set(namespace, frozen);
  return frozen;
}

function hardenOnce(namespace: object): object {
  if (typeof namespace === "function") {
    const fn = namespace as unknown as (...args: unknown[]) => unknown;
    for (const key of Object.getOwnPropertyNames(fn)) {
      if (key === "then") {
        try {
          delete (fn as unknown as Record<string, unknown>).then;
        } catch {
          /* non-configurable: nothing more we can do */
        }
      }
    }
    const proto = Object.create(null) as Record<string, unknown>;
    proto.call = Function.prototype.call;
    proto.apply = Function.prototype.apply;
    proto.bind = Function.prototype.bind;
    try {
      Object.setPrototypeOf(fn, Object.freeze(proto));
    } catch {
      /* ignore */
    }
    return Object.freeze(fn);
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(namespace)) {
    if (key === "then") continue;
    out[key] = (namespace as Record<string, unknown>)[key];
  }
  return Object.freeze(out);
}

function stampTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  } else {
    delete root.dataset.theme;
    root.style.removeProperty("color-scheme");
  }
}

function lockRtc(post: (message: unknown) => void): void {
  let failed = 0;
  for (const name of RTC_GLOBALS) {
    try {
      Object.defineProperty(window, name, {
        value: undefined,
        writable: false,
        configurable: false,
      });
    } catch {
      failed++;
    }
  }
  if (failed > 0) post({ __frame_rtc_lockdown_failed: failed });
}

function readInit(value: unknown): FrameInit | null {
  if (!isFrameInitMessage(value)) return null;
  const raw = value.__frame_init as unknown as Record<string, unknown>;
  const capabilities: Record<string, CapabilityInit> = {};
  if (isRecord(raw.capabilities)) {
    for (const [name, entry] of Object.entries(raw.capabilities)) {
      capabilities[name] = isRecord(entry) ? { config: entry.config } : {};
    }
  }
  const changes = Array.isArray(raw.changes)
    ? raw.changes.filter((c): c is string => typeof c === "string")
    : [];
  const flags = Array.isArray(raw.flags)
    ? raw.flags.filter((f): f is string => typeof f === "string")
    : [];
  return {
    contract: String(raw.contract),
    changes,
    flags,
    theme: value.__frame_init.theme,
    capabilities,
    capBudgets: (isRecord(raw.capBudgets) ? raw.capBudgets : {}) as CapBudgets,
  };
}

/**
 * The shell mints `__frame_t` (a 30-minute bearer naming the viewer and
 * artifact) into the iframe's `src`, and the frame middleware consumes it
 * server-side while serving this page (`serve.ts`); nothing here ever reads
 * it. Once that happens the token has no further job, so it is scrubbed
 * from `location.search` here — otherwise it would sit in the address bar,
 * `document.referrer` of any onward navigation, and browser history.
 */
function stripFrameToken(): void {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has("__frame_t")) return;
    url.searchParams.delete("__frame_t");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  } catch {
    /* a sandboxed frame or an ancient browser: leave the URL as it is */
  }
}

function boot(): void {
  stripFrameToken();
  const config = readPreambleConfig();
  const framed = window !== window.top;
  const names = config ? Object.keys(config.capabilities) : [];

  const deferreds = new Map<string, Deferred>();
  for (const name of names) deferreds.set(name, deferred());

  const use = (name: unknown): Promise<object | null> => {
    if (typeof name !== "string") return Promise.resolve(null);
    const d = deferreds.get(name);
    return d ? d.promise : Promise.resolve(null);
  };

  /** Legacy chat-artifact API: a thin wrapper over `sample`. */
  const complete = async (prompt: string): Promise<string> => {
    const ns = (await use("sample")) as SampleLike | null;
    if (typeof ns !== "function") {
      throw capError("capability_disabled", "sampling is not available in this view");
    }
    const result = await ns(String(prompt));
    return typeof result?.text === "string" ? result.text : "";
  };

  const claude = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(claude, "use", { value: use, enumerable: false });
  Object.defineProperty(claude, "complete", { value: complete, enumerable: false });
  try {
    Object.defineProperty(window, "claude", {
      value: claude,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  } catch {
    /* another copy of the preamble already installed it */
  }

  const resolveRest = (): void => {
    for (const d of deferreds.values()) d.resolve(null);
  };

  if (!framed || !config) {
    // Inert mode (a saved copy, or a page served without a preamble config):
    // `use()` resolves null for every name, exactly as top-level views do.
    resolveRest();
    return;
  }

  const postToParent = (message: unknown, origin = "*"): void => {
    try {
      window.parent.postMessage(message, origin);
    } catch {
      /* the parent went away */
    }
  };

  lockRtc((m) => postToParent(m));

  const moduleFiles = config.capabilities;
  const allowedOrigins = config.origins;

  let shellOrigin: string | null = null;
  let initTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    initTimer = null;
    resolveRest();
  }, INIT_TIMEOUT_MS);

  const onMessage = (ev: MessageEvent): void => {
    if (ev.source !== window.parent) return;
    if (shellOrigin === null) {
      if (!allowedOrigins.length || !originAllowed(ev.origin, allowedOrigins)) return;
      const init = readInit(ev.data);
      if (!init) return;
      shellOrigin = ev.origin;
      if (initTimer !== null) {
        clearTimeout(initTimer);
        initTimer = null;
      }
      void start(init, ev.origin);
      return;
    }
    if (ev.origin !== shellOrigin) return;
    if (isFrameThemeMessage(ev.data)) {
      stampTheme(ev.data.__frame_theme.theme);
      return;
    }
    if (isFrameSizePoke(ev.data)) {
      reportSize(true);
      return;
    }
  };

  window.addEventListener("message", onMessage);
  postToParent({ __frame_connect: true }, "*");

  /* ---------------- size reporting ---------------- */

  let lastHeight = -1;
  let sizeTimer: ReturnType<typeof setTimeout> | null = null;

  function reportSize(force = false): void {
    if (shellOrigin === null) return;
    const h = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
    );
    if (!force && h === lastHeight) return;
    lastHeight = h;
    postToParent({ __frame_size: true, h }, shellOrigin);
  }

  function scheduleSize(): void {
    if (sizeTimer !== null) return;
    sizeTimer = setTimeout(() => {
      sizeTimer = null;
      reportSize();
    }, SIZE_DEBOUNCE_MS);
  }

  function installSizeReporter(): void {
    try {
      const ro = new ResizeObserver(() => scheduleSize());
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    } catch {
      /* no ResizeObserver: fall back to the events below */
    }
    window.addEventListener("load", () => reportSize(true), { capture: true });
    window.addEventListener("beforeprint", () => reportSize(true));
    reportSize(true);
  }

  /* ---------------- navigation interception ---------------- */

  function installNavInterception(): void {
    const handler = (ev: MouseEvent): void => {
      if (shellOrigin === null || ev.defaultPrevented) return;
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href], area[href]");
      if (!(anchor instanceof HTMLAnchorElement || anchor instanceof HTMLAreaElement)) return;
      const rawHref = anchor.getAttribute("href") ?? "";
      let url: URL;
      try {
        url = new URL(anchor.href, location.href);
      } catch {
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      const newTab =
        ev.button === 1 ||
        ev.metaKey ||
        ev.ctrlKey ||
        ev.shiftKey ||
        ev.altKey ||
        !["", "_self", "_top", "_parent"].includes(anchor.target);
      if (url.origin === location.origin) {
        if (rawHref.startsWith("#")) {
          postToParent({ __frame_nav: true, url: url.href, rawHref, newTab }, shellOrigin);
        }
        return;
      }
      ev.preventDefault();
      postToParent({ __frame_nav: true, url: url.href, rawHref, newTab }, shellOrigin);
    };
    document.addEventListener("click", handler, true);
    document.addEventListener("auxclick", handler, true);
  }

  /* ---------------- boot after init ---------------- */

  function buildContext(init: FrameInit, origin: string): {
    ctx: FrameContext;
    mounted: Set<string>;
  } {
    const mounted = new Set<string>();
    const pipe = (cap: string): CapPipe => ({
      wrap<A extends unknown[], R>(method: string, fn: (...args: A) => R | Promise<R>) {
        return (...args: A): Promise<R> => {
          try {
            return Promise.resolve(fn(...args));
          } catch (err) {
            // A capability's own rejection travels unchanged: its code is the
            // contract (`capability_disabled`, `invalid_content`, ...) and the
            // page's retry policy keys off it. Only a genuine failure of the
            // wrapper itself becomes `transform_error`.
            if (isCapError(err)) return Promise.reject(err);
            const message = err instanceof Error ? err.message : String(err);
            return Promise.reject(
              capError("transform_error", `${cap}.${method}: ${message}`),
            );
          }
        };
      },
    });
    const ctx: FrameContext = {
      shellOrigin: origin,
      capabilities: init.capabilities,
      capBudgets: init.capBudgets,
      changes: new Set(init.changes),
      flags: new Set(init.flags),
      hooks: {},
      mount(name, namespace) {
        const d = deferreds.get(name);
        if (!d || d.settled) return;
        mounted.add(name);
        d.resolve(harden(namespace));
      },
      pipe,
    };
    return { ctx, mounted };
  }

  async function start(init: FrameInit, origin: string): Promise<void> {
    stampTheme(init.theme);
    const { ctx } = buildContext(init, origin);

    // One import per module file: `artifact` and `self` share one.
    const files = new Map<string, string[]>();
    for (const name of Object.keys(init.capabilities)) {
      const file = moduleFiles[name];
      if (!file) continue;
      const list = files.get(file);
      if (list) list.push(name);
      else files.set(file, [name]);
    }

    await Promise.all(
      [...files.entries()].map(async ([file, capNames]) => {
        try {
          const url = new URL(`/_runtime/${file}`, location.origin).href;
          const mod: unknown = await import(/* @vite-ignore */ url);
          const install = isRecord(mod) ? mod.install : undefined;
          if (typeof install === "function") {
            (install as (c: FrameContext) => void)(ctx);
          }
        } catch {
          postToParent(
            { __frame_cap_telemetry: { kind: "cap-load-error", cap: capNames[0] ?? file } },
            origin,
          );
        }
      }),
    );

    // Anything not mounted resolves null: "design for absence".
    resolveRest();

    installNavInterception();

    const ready = (): void => {
      postToParent({ __frame_ready: true }, origin);
      installSizeReporter();
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", ready, { once: true });
    } else {
      ready();
    }
  }
}

boot();
