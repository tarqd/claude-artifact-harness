/**
 * The `__frame_*` envelope types and their validators. Every inbound message
 * on either side goes through a validator here before it is used, so no
 * handler ever sees an untyped payload.
 */
import type { CapError } from "./errors.ts";

export const CONTRACT_VERSION = "0.2.32";

export type Theme = "light" | "dark" | "system";

export function isTheme(v: unknown): v is Theme {
  return v === "light" || v === "dark" || v === "system";
}

/** Constant reply budgets the shell advertises, in ms (shell.md §2). */
export const CAP_BUDGETS = Object.freeze({
  mcp: { callTool: 130_000, listTools: 130_000 },
  sample: { sample: 330_000 },
  handlers: { fetch: 130_000 },
});

export type CapBudgets = typeof CAP_BUDGETS;

/** Per-capability declaration forwarded to the frame. Never carries tokens. */
export interface CapabilityInit {
  config?: unknown;
}

export interface FrameInit {
  contract: string;
  changes: string[];
  flags: string[];
  theme: Theme;
  capabilities: Record<string, CapabilityInit>;
  capBudgets: CapBudgets;
}

/** What the server writes into the served page as `window.__FRAME_PREAMBLE`. */
export interface FramePreambleConfig {
  v: 1;
  /** capability name → module file served from `/_runtime/<file>` */
  capabilities: Record<string, string>;
  /** origins allowed to send `__frame_init` */
  origins: string[];
}

/* ------------------------------------------------------------------ */
/* frame → shell                                                       */
/* ------------------------------------------------------------------ */

export interface FrameConnect {
  __frame_connect: true;
}
export interface FrameReady {
  __frame_ready: true;
}
export interface FrameSize {
  __frame_size: true;
  h: number;
}
export interface FrameNav {
  __frame_nav: true;
  url: string;
  rawHref?: string;
  newTab: boolean;
}
export interface FrameCapCall {
  __frame_cap: true;
  cap: string;
  id: string;
  method: string;
  args: unknown[];
}

/* ------------------------------------------------------------------ */
/* shell → frame                                                       */
/* ------------------------------------------------------------------ */

export interface FrameInitMessage {
  __frame_init: FrameInit;
}
export interface FrameThemeMessage {
  __frame_theme: { theme: Theme };
}
export interface FrameSizePoke {
  __frame_size_poke: true;
}
export interface FrameCapReply {
  __frame_cap_r: true;
  id: string;
  result?: unknown;
  error?: CapError;
}
export interface FrameCapAck {
  __frame_cap_ack: true;
  id: string;
}
export interface FrameCapProgress {
  __frame_cap_p: true;
  id: string;
  p: unknown;
}

/* ------------------------------------------------------------------ */
/* validators                                                          */
/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function hasKey<K extends string>(v: unknown, key: K): v is Record<K, unknown> {
  return isRecord(v) && key in v;
}

export function isFrameConnect(v: unknown): v is FrameConnect {
  return isRecord(v) && v.__frame_connect === true;
}

export function isFrameReady(v: unknown): v is FrameReady {
  return isRecord(v) && v.__frame_ready === true;
}

export function isFrameSize(v: unknown): v is FrameSize {
  return isRecord(v) && v.__frame_size === true && typeof v.h === "number";
}

export function isFrameNav(v: unknown): v is FrameNav {
  return (
    isRecord(v) &&
    v.__frame_nav === true &&
    typeof v.url === "string" &&
    typeof v.newTab === "boolean"
  );
}

export function isFrameCapCall(v: unknown): v is FrameCapCall {
  return (
    isRecord(v) &&
    v.__frame_cap === true &&
    typeof v.cap === "string" &&
    typeof v.id === "string" &&
    typeof v.method === "string" &&
    Array.isArray(v.args)
  );
}

export function isFrameInitMessage(v: unknown): v is FrameInitMessage {
  if (!isRecord(v) || !isRecord(v.__frame_init)) return false;
  const init = v.__frame_init;
  return (
    typeof init.contract === "string" &&
    Array.isArray(init.changes) &&
    Array.isArray(init.flags) &&
    isTheme(init.theme)
  );
}

export function isFrameThemeMessage(v: unknown): v is FrameThemeMessage {
  return isRecord(v) && isRecord(v.__frame_theme) && isTheme(v.__frame_theme.theme);
}

export function isFrameSizePoke(v: unknown): v is FrameSizePoke {
  return isRecord(v) && v.__frame_size_poke === true;
}

export function isFrameCapReply(v: unknown): v is FrameCapReply {
  return isRecord(v) && v.__frame_cap_r === true && typeof v.id === "string";
}

export function isFrameCapAck(v: unknown): v is FrameCapAck {
  return isRecord(v) && v.__frame_cap_ack === true && typeof v.id === "string";
}

export function isFrameCapProgress(v: unknown): v is FrameCapProgress {
  return isRecord(v) && v.__frame_cap_p === true && typeof v.id === "string";
}

/** Reply timeouts (ms). Frame-side defaults from surface-area.md §4. */
export const RPC_DEFAULT_TIMEOUT_MS = 130_000;
/** An `__frame_cap_ack` extends a pending call to this budget. */
export const RPC_ACK_TIMEOUT_MS = 900_000;
/** How long the frame waits for `__frame_init` before resolving every use() null. */
export const INIT_TIMEOUT_MS = 10_000;
