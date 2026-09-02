/**
 * The one throttle in the spine: a coarse fixed-window counter keyed by
 * client address. It is not a load balancer — it exists so a script cannot
 * guess the owner token, or mint identities, in a loop faster than a person
 * ever would. Slices reuse it (`user`) rather than growing their own.
 */
import type { Context } from "hono";

/** Default window for every budget built on this. */
export const RATE_WINDOW_MS = 60_000;

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = RATE_WINDOW_MS,
  ) {}

  allow(key: string, now: number = Date.now()): boolean {
    const slot = this.hits.get(key);
    if (!slot || slot.resetAt <= now) {
      // Bounded memory: a flood of distinct addresses resets the table
      // rather than growing it without end.
      if (this.hits.size >= 4096) this.hits.clear();
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    slot.count += 1;
    return slot.count <= this.limit;
  }
}

/** The address this request came from; one bucket for everything unknown. */
export function clientKey(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: unknown } } } | null | undefined;
  const address = env?.incoming?.socket?.remoteAddress;
  return typeof address === "string" && address ? address : "unknown";
}
