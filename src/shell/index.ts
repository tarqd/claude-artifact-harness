/**
 * Shell entry point. The server inlines `window.__SHELL_BOOT` into the shell
 * page and loads this bundle; everything else the viewer sees is this file.
 */
import { isTheme, type Theme } from "../protocol/messages.ts";
import { FrameHost } from "./host.ts";
import type { ShellBoot } from "./types.ts";

function readBoot(): ShellBoot | null {
  const raw: unknown = (window as unknown as Record<string, unknown>).__SHELL_BOOT;
  if (typeof raw !== "object" || raw === null) return null;
  const boot = raw as Partial<ShellBoot>;
  if (typeof boot.artifactId !== "string" || typeof boot.frameUrl !== "string") return null;
  if (typeof boot.version !== "string") return null;
  return boot as ShellBoot;
}

function currentTheme(): Theme {
  const mode = document.documentElement.dataset.mode;
  if (isTheme(mode)) return mode;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function start(): void {
  const boot = readBoot();
  const container = document.getElementById("frame-slot");
  if (!boot || !container) return;

  const host = new FrameHost({ boot, container, theme: currentTheme });
  host.mount();

  let lastTheme = currentTheme();
  const pushTheme = (): void => {
    const theme = currentTheme();
    if (theme === lastTheme) return;
    lastTheme = theme;
    host.sendTheme(theme);
  };
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", pushTheme);
  new MutationObserver(pushTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-mode"],
  });

  // v0 live-reload: other open views notice a new version by polling. The
  // publishing view is reloaded by its own broker as soon as the call lands.
  if (boot.versionPollMs > 0) {
    setInterval(() => {
      void fetch(`/api/artifacts/${boot.artifactId}/version`, { credentials: "same-origin" })
        .then((r) => (r.ok ? (r.json() as Promise<{ version?: unknown }>) : null))
        .then((body) => {
          const version = body?.version;
          if (typeof version === "string" && version !== host.currentVersion) {
            host.mount(version);
          }
        })
        .catch(() => undefined);
    }, boot.versionPollMs);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
