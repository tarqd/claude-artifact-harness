/**
 * Shell-side types: the boot record the server inlines into the shell page,
 * and the context every capability broker is handed.
 */
import type { CapabilityInit, Theme } from "../protocol/messages.ts";

export interface ShellViewer {
  id: string;
  /** `view` | `interact` | `admin` | `owner` */
  level: string;
  canEdit: boolean;
  isOwner: boolean;
}

export interface ShellBoot {
  artifactId: string;
  version: string;
  title: string;
  frameOrigin: string;
  frameUrl: string;
  contract: string;
  changes: string[];
  flags: string[];
  capabilities: Record<string, CapabilityInit>;
  viewer: ShellViewer;
  /** How often to poll for a new version, ms (0 disables). */
  versionPollMs: number;
}

export interface ConsentRequest {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

/** A validated `__frame_cap` call, with the envelope keys stripped. */
export interface BrokerCall {
  cap: string;
  id: string;
  method: string;
  args: unknown[];
}

export interface BrokerContext {
  boot: ShellBoot;
  /** The version this view is currently running (updated after a publish). */
  version: string;
  viewer: ShellViewer;
  flags: ReadonlySet<string>;
  /** Send a push message (e.g. `__frame_db_ev`) to the frame. */
  toFrame(message: unknown): void;
  /** Tell the frame a call is waiting on the viewer; extends its budget. */
  ack(id: string): void;
  /** Stream progress for a call (`__frame_cap_p`). */
  progress(id: string, p: unknown): void;
  /** Remount the iframe, optionally at a new version. */
  reloadView(version?: string): void;
  /** Record the version this view is running without remounting. */
  setVersion(version: string): void;
  /** Ask the viewer; the iframe is inert while the dialog is open. */
  consent(request: ConsentRequest): Promise<boolean>;
  /** Same-origin JSON call to the shell's own backend. */
  api<T>(path: string, init?: RequestInit): Promise<T>;
}

/** Every capability slice exports this from `src/capabilities/<name>/broker.ts`. */
export interface CapabilityBroker {
  handle(call: BrokerCall, ctx: BrokerContext): Promise<unknown>;
  /** Optional teardown when the view is remounted. */
  dispose?(ctx: BrokerContext): void;
}

export interface HostOptions {
  boot: ShellBoot;
  container: HTMLElement;
  theme(): Theme;
}
