/**
 * A minimal consent dialog. The only rule that matters for security: while a
 * decision surface is open the artifact iframe is `inert`, so the page cannot
 * clickjack the viewer's answer (surface-area.md §10.1).
 */
import type { ConsentRequest } from "./types.ts";

const STYLE_ID = "shell-consent-style";

const CSS = `
.shell-consent-backdrop{position:fixed;inset:0;background:rgba(20,20,19,.45);
  display:flex;align-items:center;justify-content:center;z-index:2147483646}
.shell-consent{background:var(--shell-surface,#fff);color:var(--shell-ink,#141413);
  border-radius:12px;padding:20px;max-width:420px;width:calc(100% - 32px);
  box-shadow:0 12px 40px rgba(0,0,0,.25);font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}
.shell-consent h2{margin:0 0 8px;font-size:15px}
.shell-consent p{margin:0 0 16px}
.shell-consent .row{display:flex;gap:8px;justify-content:flex-end}
.shell-consent button{font:inherit;padding:6px 14px;border-radius:8px;border:1px solid #d6d3cd;
  background:#fff;color:inherit;cursor:pointer}
.shell-consent button.primary{background:#141413;color:#fff;border-color:#141413}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

export interface ConsentDialogHost {
  /** The iframe to make inert while a dialog is open. */
  frame(): HTMLIFrameElement | null;
  /**
   * Put the iframe's `inert` back the way the host wants it once the last
   * dialog closes. The host owns that state — a frame that has not been
   * revealed yet must stay inert.
   */
  restoreInert(): void;
}

export function createConsent(host: ConsentDialogHost) {
  let open = 0;

  return {
    /** True while any decision surface is up (the shell keeps the frame inert). */
    get isOpen(): boolean {
      return open > 0;
    },
    ask(request: ConsentRequest): Promise<boolean> {
      ensureStyle();
      const frame = host.frame();
      if (frame) frame.inert = true;
      open++;

      const backdrop = document.createElement("div");
      backdrop.className = "shell-consent-backdrop";
      const dialog = document.createElement("div");
      dialog.className = "shell-consent";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");

      const heading = document.createElement("h2");
      heading.textContent = request.title;
      const body = document.createElement("p");
      body.textContent = request.body;
      const row = document.createElement("div");
      row.className = "row";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = request.cancelLabel ?? "Not now";
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "primary";
      confirm.textContent = request.confirmLabel ?? "Allow";
      row.append(cancel, confirm);
      dialog.append(heading, body, row);
      backdrop.append(dialog);
      document.body.append(backdrop);
      confirm.focus();

      return new Promise<boolean>((resolve) => {
        const close = (answer: boolean): void => {
          backdrop.remove();
          open--;
          if (open === 0) host.restoreInert();
          resolve(answer);
        };
        cancel.addEventListener("click", () => close(false));
        confirm.addEventListener("click", () => close(true));
        backdrop.addEventListener("keydown", (ev) => {
          if (ev.key === "Escape") close(false);
        });
      });
    },
  };
}

export type Consent = ReturnType<typeof createConsent>;
