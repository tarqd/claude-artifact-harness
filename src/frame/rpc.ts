/**
 * The `__frame_cap` request/reply client every capability module uses.
 *
 * One instance per capability, exactly as the platform's modules do: its own
 * id counter (`<prefix><n>`), its own listener, a 130 s default reply budget
 * that an `__frame_cap_ack` extends to 900 s, and a cloneability rejection
 * when `postMessage` refuses the arguments.
 */
import { capIdPrefix } from "../protocol/capabilities.ts";
import { capError, isCapError, type CapError } from "../protocol/errors.ts";
import {
  isFrameCapAck,
  isFrameCapProgress,
  isFrameCapReply,
  RPC_ACK_TIMEOUT_MS,
  RPC_DEFAULT_TIMEOUT_MS,
} from "../protocol/messages.ts";

export interface RpcEvent {
  data: unknown;
  origin: string;
  source: unknown;
}

/** The seam that lets the client run under a test double instead of a window. */
export interface RpcHost {
  post(message: unknown, targetOrigin: string): void;
  listen(handler: (ev: RpcEvent) => void): () => void;
  /** True when the event really came from the shell window at its origin. */
  accepts(ev: RpcEvent): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** What a call that never got a reply settles as. */
export type RpcTimeoutOutcome = CapError | { resolve: unknown };

export interface RpcOptions {
  cap: string;
  shellOrigin: string;
  timeoutMs?: number;
  ackTimeoutMs?: number;
  host?: RpcHost;
  /**
   * Per-capability timeout behaviour: `db` rejects `unavailable`, `user`
   * resolves `null` rather than rejecting, and so on. The default is
   * `upstream_error` "no reply from shell".
   */
  onTimeout?(id: string): RpcTimeoutOutcome;
}

export interface CallOptions {
  timeoutMs?: number;
  onProgress?: (p: unknown) => void;
}

export interface RpcClient {
  call<R = unknown>(method: string, args: unknown[], opts?: CallOptions): Promise<R>;
  dispose(): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: CapError) => void;
  timer: unknown;
  acked: boolean;
  onProgress?: (p: unknown) => void;
}

/** The default host: `parent.postMessage`, with the strict origin/source check. */
export function browserRpcHost(shellOrigin: string): RpcHost {
  return {
    post(message, targetOrigin) {
      window.parent.postMessage(message, targetOrigin);
    },
    listen(handler) {
      const fn = (ev: MessageEvent): void =>
        handler({ data: ev.data, origin: ev.origin, source: ev.source });
      window.addEventListener("message", fn);
      return () => window.removeEventListener("message", fn);
    },
    accepts(ev) {
      return ev.source === window.parent && ev.origin === shellOrigin;
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

export function createRpc(opts: RpcOptions): RpcClient {
  const host = opts.host ?? browserRpcHost(opts.shellOrigin);
  const defaultTimeout = opts.timeoutMs ?? RPC_DEFAULT_TIMEOUT_MS;
  const ackTimeout = opts.ackTimeoutMs ?? RPC_ACK_TIMEOUT_MS;
  const pending = new Map<string, Pending>();
  const idPrefix = capIdPrefix(opts.cap);
  let counter = 0;

  const settle = (id: string): Pending | undefined => {
    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      host.clearTimer(entry.timer);
    }
    return entry;
  };

  const unlisten = host.listen((ev) => {
    if (!host.accepts(ev)) return;
    const data = ev.data;
    if (isFrameCapReply(data)) {
      const entry = settle(data.id);
      if (!entry) return;
      if (data.error !== undefined && data.error !== null) entry.reject(data.error);
      else entry.resolve(data.result);
      return;
    }
    if (isFrameCapAck(data)) {
      const entry = pending.get(data.id);
      if (!entry || entry.acked) return;
      entry.acked = true;
      host.clearTimer(entry.timer);
      entry.timer = host.setTimer(() => expire(data.id), ackTimeout);
      return;
    }
    if (isFrameCapProgress(data)) {
      pending.get(data.id)?.onProgress?.(data.p);
    }
  });

  function expire(id: string): void {
    const entry = settle(id);
    if (!entry) return;
    const outcome = opts.onTimeout?.(id) ?? capError("upstream_error", "no reply from shell");
    if (isCapError(outcome)) entry.reject(outcome);
    else entry.resolve(outcome.resolve);
  }

  return {
    call<R>(method: string, args: unknown[], callOpts?: CallOptions): Promise<R> {
      const id = `${idPrefix}${++counter}`;
      const budgetMs = callOpts?.timeoutMs ?? defaultTimeout;
      return new Promise<R>((resolve, reject) => {
        const entry: Pending = {
          resolve: resolve as (v: unknown) => void,
          reject,
          timer: host.setTimer(() => expire(id), budgetMs),
          acked: false,
          onProgress: callOpts?.onProgress,
        };
        pending.set(id, entry);
        try {
          host.post({ __frame_cap: true, cap: opts.cap, id, method, args }, opts.shellOrigin);
        } catch {
          settle(id);
          reject(capError("invalid_content", "arguments must be cloneable"));
        }
      });
    },
    dispose() {
      for (const id of [...pending.keys()]) {
        const entry = settle(id);
        entry?.reject(capError("capability_removed", "the frame runtime was torn down"));
      }
      unlisten();
    },
  };
}
