/**
 * A frame-side room under a fake clock, a fake animation frame and a fake
 * shell. No DOM: everything the module observes goes through `RoomEnv`.
 */
import { CAP_BUDGETS } from "../../src/protocol/messages.ts";
import type { FrameContext } from "../../src/frame/types.ts";
import { createRoom, type RoomEnv, type RoomNamespace } from "../../src/capabilities/room/frame.ts";

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

export interface CapCall {
  id: string;
  method: string;
  args: unknown[];
  activation: boolean;
}

export class Harness implements RoomEnv {
  clock = 1_000_000;
  reported: unknown[] = [];
  posted: CapCall[] = [];
  randomValue = 0.5;

  private timers: Timer[] = [];
  private nextTimer = 1;
  private frames: Array<() => void> = [];
  private listeners: Array<(data: unknown) => void> = [];
  private visible: Array<() => void> = [];

  post(message: unknown, activation?: boolean): void {
    const call = message as { method?: string; id?: string; args?: unknown[] };
    this.posted.push({
      id: String(call.id),
      method: String(call.method),
      args: call.args ?? [],
      activation: activation === true,
    });
  }
  listen(handler: (data: unknown) => void): () => void {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter((h) => h !== handler);
    };
  }
  now(): number {
    return this.clock;
  }
  setTimer(fn: () => void, ms: number): unknown {
    const timer: Timer = { id: this.nextTimer++, at: this.clock + ms, fn };
    this.timers.push(timer);
    return timer.id;
  }
  clearTimer(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }
  schedule(fn: () => void): void {
    this.frames.push(fn);
  }
  reportError(err: unknown): void {
    this.reported.push(err);
  }
  random(): number {
    return this.randomValue;
  }
  onVisible(fn: () => void): void {
    this.visible.push(fn);
  }

  /* ------------------------------ driving ---------------------------- */

  /** Run every animation-frame callback queued so far. */
  frame(): void {
    const queued = this.frames;
    this.frames = [];
    for (const fn of queued) fn();
  }

  becameVisible(): void {
    for (const fn of this.visible) fn();
  }

  /** Advance the clock, firing timers in order. */
  advance(ms: number): void {
    const target = this.clock + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.clock = Math.max(this.clock, due.at);
      due.fn();
    }
    this.clock = target;
  }

  /** Deliver a shell → frame message. */
  deliver(data: unknown): void {
    for (const handler of [...this.listeners]) handler(data);
  }

  reply(id: string, result: unknown): void {
    this.deliver({ __frame_cap_r: true, id, result });
  }

  fail(id: string, error: { code: string; message: string }): void {
    this.deliver({ __frame_cap_r: true, id, error });
  }

  roomEvent(ev: Record<string, unknown>): void {
    this.deliver({ __frame_room_ev: true, ev });
  }

  /** The most recent call for `method`, or undefined. */
  last(method: string): CapCall | undefined {
    return [...this.posted].reverse().find((c) => c.method === method);
  }

  calls(method: string): CapCall[] {
    return this.posted.filter((c) => c.method === method);
  }
}

export function fakeContext(config?: unknown): FrameContext {
  return {
    shellOrigin: "https://shell.test",
    capabilities: { room: { config } },
    capBudgets: CAP_BUDGETS,
    changes: new Set<string>(),
    flags: new Set<string>(),
    hooks: {},
    mount: () => undefined,
    pipe: () => ({
      wrap<A extends unknown[], R>(_method: string, fn: (...args: A) => R | Promise<R>) {
        return (...args: A): Promise<R> => {
          try {
            return Promise.resolve(fn(...args));
          } catch (err) {
            return Promise.reject(err);
          }
        };
      },
    }),
  };
}

export interface Fixture {
  env: Harness;
  room: RoomNamespace;
}

/** A room whose `hello` has been answered with `peer` and `up: true`. */
export async function connectedRoom(config?: unknown): Promise<Fixture> {
  const env = new Harness();
  const room = createRoom(fakeContext(config), env);
  const hello = env.last("hello");
  env.reply(hello!.id, { peer: "mypeer0000000001", up: true });
  await tick();
  return { env, room };
}

export function newRoom(config?: unknown): Fixture {
  const env = new Harness();
  return { env, room: createRoom(fakeContext(config), env) };
}

/** Let queued microtasks (and one promise chain hop) run. */
export async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
