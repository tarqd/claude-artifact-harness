/**
 * The boot context the preamble hands to every capability module's
 * `install(ctx)`. Capability modules import this type only — the preamble
 * builds the object at runtime, so nothing is bundled across the seam.
 */
import type { CapBudgets, CapabilityInit } from "../protocol/messages.ts";

export type AnyFn = (...args: never[]) => unknown;

export interface CapPipe {
  /**
   * Wrap one namespace method. The preamble converts synchronous throws into
   * rejections here, which is why every documented method "rejects, never
   * throws"; transforms named by `changes` would also hook in here.
   */
  wrap<A extends unknown[], R>(
    method: string,
    fn: (...args: A) => R | Promise<R>,
  ): (...args: A) => Promise<R>;
}

export interface FrameContext {
  /** Origin that sent `__frame_init`; target origin for every postMessage. */
  shellOrigin: string;
  /** `__frame_init.capabilities` verbatim (config only, never tokens). */
  capabilities: Readonly<Record<string, CapabilityInit>>;
  capBudgets: CapBudgets;
  changes: ReadonlySet<string>;
  flags: ReadonlySet<string>;
  /** Mutable slot bag shared between modules (live-doc engine hooks etc.). */
  hooks: Record<string, unknown>;
  /** Publish a namespace under `name`; resolves that name's `use()` promise. */
  mount(name: string, namespace: object): void;
  pipe(cap: string): CapPipe;
}

export interface CapabilityModule {
  install(ctx: FrameContext): void;
}
