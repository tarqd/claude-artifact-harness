/**
 * `room` — the page-facing namespace from
 * `reference/contract/0.2.32/room.d.ts`, rebuilt from
 * `docs/analysis/sample-room.md` §2 so a page written for claude.ai sees the
 * same objects, the same timings and the same error codes here.
 *
 * Everything that decides what a page observes lives in this file: the
 * presence merge and its 4 KiB cap, the coalesced 30 Hz send, the keepalive
 * and newcomer answers, the silence sweep, the per-frame `onPeers` batching,
 * the emit token bucket, and the terminal state. The shell is only a
 * transport: it never invents a `Peer`.
 *
 * The whole module runs against a small `RoomEnv` seam (post, listen, timers,
 * animation frames) so the unit tests can drive real time and real
 * message traffic without a browser.
 */
import { capError, type CapError } from "../../protocol/errors.ts";
import { createRpc, type RpcHost } from "../../frame/rpc.ts";
import type { FrameContext } from "../../frame/types.ts";
import { readLimits } from "./protocol.ts";
import {
  asCapError,
  jsonBytes,
  mergePresence,
  TOPIC_RE,
  isTopic,
  validateEmit,
  validateToClaude,
} from "./validate.ts";

const CAP = "room";

/* ------------------------------------------------------------------ */
/* constants (docs/analysis/sample-room.md §2.11)                       */
/* ------------------------------------------------------------------ */

/** Token bucket: 40 emits per second, burst 80. */
const EMIT_REFILL_PER_SEC = 40;
const EMIT_BURST = 80;
/** A newcomer is answered within this many ms, jittered. */
const NEWCOMER_JITTER_MS = 500;
/** How often peers unseen for `silenceMs` are swept. */
const SWEEP_PERIOD_MS = 15_000;

const TERMINAL_MESSAGE = "The room channel is no longer available to this view.";

const RATE_LIMIT_NOTICE =
  "window.claude.room: rate limit - dropping emits sent faster than the budget " +
  "(about 40/s; the page keeps working; high-rate state belongs in presence; " +
  "this is reported once per page load)";

/* ------------------------------------------------------------------ */
/* limits                                                              */
/* ------------------------------------------------------------------ */

export { readLimits, type RoomLimits } from "./protocol.ts";

/* ------------------------------------------------------------------ */
/* the runtime seam                                                    */
/* ------------------------------------------------------------------ */

export interface RoomEnv {
  /** Post to the shell. `activation` asks for `includeUserActivation`. */
  post(message: unknown, activation?: boolean): void;
  /** Shell → frame messages, already filtered by origin and source. */
  listen(handler: (data: unknown) => void): () => void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Run `fn` on the next animation frame: the `onPeers` batch boundary. */
  schedule(fn: () => void): void;
  reportError(err: unknown): void;
  random(): number;
  /** The tab became visible again (a missed animation frame is flushed). */
  onVisible?(fn: () => void): void;
  /** The page is going away: drop the timers, keep the state. */
  onPageHide?(fn: () => void): void;
}

export function browserEnv(shellOrigin: string): RoomEnv {
  return {
    post(message, activation) {
      const parent = window.parent;
      if (activation && "userActivation" in MessageEvent.prototype) {
        (parent.postMessage as (m: unknown, o: unknown) => void)(message, {
          targetOrigin: shellOrigin,
          includeUserActivation: true,
        });
        return;
      }
      parent.postMessage(message, shellOrigin);
    },
    listen(handler) {
      const fn = (ev: MessageEvent): void => {
        if (ev.source !== window.parent || ev.origin !== shellOrigin) return;
        handler(ev.data);
      };
      window.addEventListener("message", fn);
      return () => window.removeEventListener("message", fn);
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    schedule(fn) {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => fn());
      else setTimeout(fn, 16);
    },
    reportError(err) {
      try {
        const report = (globalThis as { reportError?: (e: unknown) => void }).reportError;
        if (typeof report === "function") report(err);
        else
          setTimeout(() => {
            throw err;
          }, 0);
      } catch {
        /* reporting must never affect the call */
      }
    },
    random: () => Math.random(),
    onVisible(fn) {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") fn();
      });
    },
    onPageHide(fn) {
      window.addEventListener("pagehide", (ev) => {
        if (!ev.persisted) fn();
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* namespace types (structurally the contract's)                        */
/* ------------------------------------------------------------------ */

export interface Sender {
  peer: string;
  by: string | null;
  isMe: boolean;
  sameTab: boolean;
  kind: "viewer" | "agent";
}

export interface Peer extends Sender {
  presence: Readonly<Record<string, unknown>>;
  updatedAt: number;
}

export interface Message extends Sender {
  topic: string;
  data?: unknown;
}

export interface PeersChange {
  peers: readonly Peer[];
  joined: readonly Peer[];
  left: readonly Peer[];
  updated: readonly Peer[];
}

type OnError = (e: { code: string; message: string }) => void;

interface TopicListener {
  handler: (msg: Message) => void;
  onError?: OnError;
  dead: boolean;
}

interface PeersListener {
  handler: (change: PeersChange) => void;
  onError?: OnError;
  dead: boolean;
  primed: boolean;
}

interface ConnectionListener {
  handler: (connected: boolean) => void;
  onError?: OnError;
  dead: boolean;
}

const EMPTY_PEERS: readonly Peer[] = Object.freeze([]);

/* ------------------------------------------------------------------ */
/* the room                                                            */
/* ------------------------------------------------------------------ */

interface HelloResult {
  peer?: unknown;
  up?: unknown;
  terminal?: unknown;
}

/** Does a presence object differ field by field? Identity holds when not. */
function samePresence(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  }
  return true;
}

export interface RoomNamespace {
  emit(topic: string, data?: unknown): Promise<void>;
  presence(patch: Record<string, unknown>): Promise<void>;
  peers(): readonly Peer[];
  connected(): boolean;
  on(topic: string, handler: (msg: Message) => void, onError?: OnError): () => void;
  onPeers(handler: (change: PeersChange) => void, onError?: OnError): () => void;
  onConnection(handler: (connected: boolean) => void, onError?: OnError): () => void;
  sendToClaudeSession(data: unknown, options?: unknown): Promise<{ to: string }>;
  canSendToClaudeSession(): Promise<string>;
}

export function createRoom(ctx: FrameContext, env: RoomEnv): RoomNamespace {
  const limits = readLimits(ctx.capabilities[CAP]?.config);
  const coalesceMs = Math.ceil(1000 / limits.presenceHz);
  const pipe = ctx.pipe(CAP);

  const rpcHost: RpcHost = {
    post: (message) => {
      const activation =
        typeof message === "object" &&
        message !== null &&
        (message as { method?: unknown }).method === "sendToClaudeSession";
      env.post(message, activation);
    },
    listen: (handler) =>
      env.listen((data) => handler({ data, origin: ctx.shellOrigin, source: null })),
    // `env.listen` already applied the origin and source check.
    accepts: () => true,
    setTimer: (fn, ms) => env.setTimer(fn, ms),
    clearTimer: (handle) => env.clearTimer(handle),
  };
  const rpc = createRpc({ cap: CAP, shellOrigin: ctx.shellOrigin, host: rpcHost });

  /* --------------------------- local state --------------------------- */

  let terminal: CapError | null = null;
  let connectedFlag = false;
  let myPeer: string | null = null;
  let ownPresence: Record<string, unknown> = {};

  const peerMap = new Map<string, Peer>();
  const lastSeen = new Map<string, number>();
  let snapshot: readonly Peer[] = EMPTY_PEERS;
  let snapshotDirty = false;

  /** What `onPeers` last saw, so a batch can report the net change. */
  const delivered = new Map<string, Peer>();
  const pendingJoined = new Set<string>();
  const pendingUpdated = new Set<string>();
  const pendingLeft = new Map<string, Peer>();
  let flushScheduled = false;

  const topicListeners = new Map<string, Set<TopicListener>>();
  const peersListeners = new Set<PeersListener>();
  const connectionListeners = new Set<ConnectionListener>();

  let coalesceTimer: unknown = null;
  let keepaliveTimer: unknown = null;
  let keepaliveDueAt = Infinity;
  let newcomerTimer: unknown = null;
  let sweepTimer: unknown = null;

  let helloSettled = false;
  let helloInFlight = false;
  let helloRetry = false;

  let emitTokens = EMIT_BURST;
  let emitRefilledAt = env.now();
  let rateNoticeSent = false;

  /* ---------------------------- peer bookkeeping --------------------- */

  function freezePeer(sender: Sender, presence: Record<string, unknown>, at: number): Peer {
    return Object.freeze({
      peer: sender.peer,
      by: sender.by,
      isMe: sender.isMe,
      sameTab: sender.sameTab,
      kind: sender.kind,
      presence: Object.freeze({ ...presence }),
      updatedAt: at,
    }) as Peer;
  }

  function markJoined(id: string): void {
    if (pendingLeft.delete(id)) pendingUpdated.add(id);
    else pendingJoined.add(id);
    scheduleFlush();
  }

  function markUpdated(id: string): void {
    if (!pendingJoined.has(id)) pendingUpdated.add(id);
    scheduleFlush();
  }

  function markLeft(id: string, last: Peer | undefined): void {
    pendingUpdated.delete(id);
    if (pendingJoined.delete(id)) {
      // Joined and left inside one frame: the room never saw them.
      scheduleFlush();
      return;
    }
    const previous = delivered.get(id) ?? last;
    if (previous) pendingLeft.set(id, previous);
    scheduleFlush();
  }

  function setPeer(id: string, peer: Peer, isNew: boolean): void {
    peerMap.set(id, peer);
    snapshotDirty = true;
    if (isNew) markJoined(id);
    else markUpdated(id);
  }

  function removePeer(id: string): void {
    // Unconditional: a peer we only ever heard an event from has a `lastSeen`
    // entry and no `Peer`, and the sweep must be able to forget it.
    lastSeen.delete(id);
    const last = peerMap.get(id);
    if (!last) return;
    peerMap.delete(id);
    snapshotDirty = true;
    markLeft(id, last);
  }

  function currentPeers(): readonly Peer[] {
    if (snapshotDirty) {
      snapshot = Object.freeze(Array.from(peerMap.values()));
      snapshotDirty = false;
    }
    return snapshot;
  }

  function scheduleFlush(): void {
    if (flushScheduled || terminal) return;
    flushScheduled = true;
    env.schedule(() => {
      flushScheduled = false;
      flush();
    });
  }

  function flush(): void {
    if (terminal) return;
    const joined: Peer[] = [];
    const updated: Peer[] = [];
    const left: Peer[] = [];
    for (const id of pendingJoined) {
      const peer = peerMap.get(id);
      if (peer) joined.push(peer);
    }
    for (const id of pendingUpdated) {
      const peer = peerMap.get(id);
      if (!peer) continue;
      if (delivered.get(id) === peer) continue;
      updated.push(peer);
    }
    for (const peer of pendingLeft.values()) left.push(peer);
    pendingJoined.clear();
    pendingUpdated.clear();
    pendingLeft.clear();
    if (joined.length === 0 && updated.length === 0 && left.length === 0) return;

    for (const peer of joined) delivered.set(peer.peer, peer);
    for (const peer of updated) delivered.set(peer.peer, peer);
    for (const peer of left) delivered.delete(peer.peer);

    const change: PeersChange = Object.freeze({
      peers: currentPeers(),
      joined: Object.freeze(joined),
      left: Object.freeze(left),
      updated: Object.freeze(updated),
    });
    for (const listener of [...peersListeners]) {
      if (listener.dead || !listener.primed) continue;
      safely(() => listener.handler(change));
    }
  }

  function safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      env.reportError(err);
    }
  }

  /* ------------------------------ self ------------------------------ */

  function selfSender(): Sender {
    return { peer: myPeer ?? "", by: null, isMe: true, sameTab: true, kind: "viewer" };
  }

  /** Apply the local presence object to our own `Peer` at once. */
  function refreshSelf(): void {
    if (myPeer === null) return;
    const existed = peerMap.has(myPeer);
    setPeer(myPeer, freezePeer(selfSender(), ownPresence, env.now()), !existed);
  }

  /* --------------------------- presence sends ------------------------ */

  function armKeepalive(): void {
    env.clearTimer(keepaliveTimer);
    keepaliveDueAt = env.now() + limits.keepaliveMs;
    keepaliveTimer = env.setTimer(() => {
      keepaliveTimer = null;
      sendPresenceNow();
    }, limits.keepaliveMs);
  }

  function sendPresenceNow(): void {
    if (terminal) return;
    if (coalesceTimer !== null) {
      env.clearTimer(coalesceTimer);
      coalesceTimer = null;
    }
    // The shell's reply to `presence` carries nothing a page can see.
    void rpc.call("presence", [ownPresence]).catch(() => undefined);
    armKeepalive();
  }

  function schedulePresenceSend(): void {
    if (terminal || coalesceTimer !== null) return;
    coalesceTimer = env.setTimer(() => {
      coalesceTimer = null;
      sendPresenceNow();
    }, coalesceMs);
  }

  /**
   * A peer we have never seen just spoke: answer with our own presence so
   * they learn us. Jittered, and skipped when the keepalive covers it —
   * this is how late joiners collect the room with no server-side storage.
   */
  function answerNewcomer(): void {
    if (terminal || newcomerTimer !== null) return;
    if (keepaliveDueAt - env.now() <= NEWCOMER_JITTER_MS) return;
    const delay = Math.floor(env.random() * NEWCOMER_JITTER_MS);
    newcomerTimer = env.setTimer(() => {
      newcomerTimer = null;
      sendPresenceNow();
    }, delay);
  }

  function armSweep(): void {
    sweepTimer = env.setTimer(() => {
      sweepTimer = null;
      if (terminal) return;
      const cutoff = env.now() - limits.silenceMs;
      for (const [id, seen] of [...lastSeen]) {
        if (id === myPeer) continue;
        if (seen <= cutoff) removePeer(id);
      }
      armSweep();
    }, SWEEP_PERIOD_MS);
  }

  /* ---------------------------- connection --------------------------- */

  function setConnected(up: boolean): void {
    if (terminal || up === connectedFlag) return;
    connectedFlag = up;
    // `up` re-asserts us: the room may have forgotten this document.
    if (up) sendPresenceNow();
    for (const listener of [...connectionListeners]) {
      if (listener.dead) continue;
      safely(() => listener.handler(up));
    }
  }

  function goTerminal(code: unknown): void {
    if (terminal) return;
    terminal = capError(typeof code === "string" && code ? code : "revoked", TERMINAL_MESSAGE);
    for (const handle of [coalesceTimer, keepaliveTimer, newcomerTimer, sweepTimer]) {
      env.clearTimer(handle);
    }
    coalesceTimer = keepaliveTimer = newcomerTimer = sweepTimer = null;
    keepaliveDueAt = Infinity;

    if (connectedFlag) {
      connectedFlag = false;
      for (const listener of [...connectionListeners]) {
        if (listener.dead) continue;
        safely(() => listener.handler(false));
      }
    }

    const self = myPeer !== null ? peerMap.get(myPeer) : undefined;
    peerMap.clear();
    lastSeen.clear();
    delivered.clear();
    pendingJoined.clear();
    pendingUpdated.clear();
    pendingLeft.clear();
    if (self && myPeer !== null) peerMap.set(myPeer, self);
    snapshot = Object.freeze(self ? [self] : []);
    snapshotDirty = false;

    const failure = terminal;
    for (const set of topicListeners.values()) {
      for (const listener of [...set]) {
        if (listener.dead) continue;
        listener.dead = true;
        const onError = listener.onError;
        if (onError) safely(() => onError(failure));
      }
    }
    topicListeners.clear();
    for (const listener of [...peersListeners]) {
      if (listener.dead) continue;
      listener.dead = true;
      const onError = listener.onError;
      if (onError) safely(() => onError(failure));
    }
    peersListeners.clear();
    for (const listener of [...connectionListeners]) {
      if (listener.dead) continue;
      listener.dead = true;
      const onError = listener.onError;
      if (onError) safely(() => onError(failure));
    }
    connectionListeners.clear();
  }

  /* ------------------------------ hello ------------------------------ */

  function sendHello(): void {
    if (terminal || helloSettled) return;
    if (helloInFlight) {
      helloRetry = true;
      return;
    }
    helloInFlight = true;
    helloRetry = false;
    void rpc.call<HelloResult>("hello", []).then(
      (result) => {
        helloInFlight = false;
        if (terminal) return;
        if (typeof result !== "object" || result === null) return;
        const failure = result.terminal;
        if (typeof failure === "object" && failure !== null) {
          goTerminal((failure as { code?: unknown }).code);
          return;
        }
        if (typeof result.peer === "string" && result.peer !== "" && myPeer === null) {
          myPeer = result.peer;
          helloSettled = true;
          refreshSelf();
          armSweep();
        }
        if (result.up === true) setConnected(true);
      },
      () => {
        helloInFlight = false;
        // A hello that never landed is retried only when the transport says
        // it came back: retrying into a dead shell buys nothing.
        if (helloRetry) sendHello();
      },
    );
  }

  /* --------------------------- inbound events ------------------------ */

  interface RoomEvent {
    arm?: unknown;
    peer?: unknown;
    p?: unknown;
    by?: unknown;
    isMe?: unknown;
    sameTab?: unknown;
    kind?: unknown;
    topic?: unknown;
    d?: unknown;
    up?: unknown;
    code?: unknown;
  }

  function senderOf(ev: RoomEvent, sameTab: boolean): Sender {
    return {
      peer: String(ev.peer),
      by: typeof ev.by === "string" ? ev.by : null,
      isMe: ev.isMe === true,
      sameTab,
      kind: ev.kind === "agent" ? "agent" : "viewer",
    };
  }

  function bytesOf(value: unknown): number {
    try {
      const text = JSON.stringify(value);
      return typeof text === "string" ? jsonBytes(text) : Number.POSITIVE_INFINITY;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  function onPresenceEvent(ev: RoomEvent): void {
    const id = ev.peer;
    if (typeof id !== "string" || id === "") return;
    if (typeof ev.p !== "object" || ev.p === null) return;
    // Our own echo: the local model is already ahead of it.
    if (ev.isMe === true && ev.sameTab === true) return;
    if (id === myPeer) return;

    const incoming = ev.p as Record<string, unknown>;
    // Inbound presence is another page's data: hold it to the same cap this
    // page's own merged object obeys, whatever the lane let through.
    if (bytesOf(incoming) > limits.maxBytes) return;
    const now = env.now();
    const known = peerMap.get(id);
    lastSeen.set(id, now);
    if (!known) {
      if (peerMap.size >= limits.maxPeers) return;
      // A peer built from an inbound event is never `sameTab`.
      setPeer(id, freezePeer(senderOf(ev, false), incoming, now), true);
      answerNewcomer();
      return;
    }
    if (samePresence(known.presence as Record<string, unknown>, incoming)) return;
    setPeer(id, freezePeer(senderOf(ev, false), incoming, now), false);
  }

  function onEventEvent(ev: RoomEvent): void {
    const topic = ev.topic;
    if (typeof topic !== "string" || typeof ev.peer !== "string") return;
    const set = topicListeners.get(topic);
    if (!set || set.size === 0) return;
    const sender = senderOf(ev, ev.sameTab === true);
    const message = Object.freeze({
      peer: sender.peer,
      by: sender.by,
      isMe: sender.isMe,
      sameTab: sender.sameTab,
      kind: sender.kind,
      topic,
      data: ev.d,
    }) as Message;
    if (typeof ev.peer === "string") lastSeen.set(ev.peer, env.now());
    for (const listener of [...set]) {
      if (listener.dead) continue;
      safely(() => listener.handler(message));
    }
  }

  function handleRoomEvent(ev: RoomEvent): void {
    if (typeof ev.arm !== "string") return;
    // After a terminal error the channel is closed; only a fresh revocation
    // is still meaningful (and it is already terminal).
    if (terminal && ev.arm !== "revoked") return;
    switch (ev.arm) {
      case "presence":
        onPresenceEvent(ev);
        return;
      case "event":
        onEventEvent(ev);
        return;
      case "gone":
        if (typeof ev.peer === "string" && ev.peer !== myPeer) removePeer(ev.peer);
        return;
      case "conn":
        if (typeof ev.up !== "boolean") return;
        setConnected(ev.up);
        if (ev.up && !helloSettled) sendHello();
        return;
      case "revoked":
        goTerminal(ev.code);
        return;
      default:
        return;
    }
  }

  env.listen((data) => {
    if (typeof data !== "object" || data === null) return;
    const message = data as { __frame_room_ev?: unknown; ev?: unknown };
    if (message.__frame_room_ev !== true) return;
    if (typeof message.ev !== "object" || message.ev === null) return;
    handleRoomEvent(message.ev as RoomEvent);
  });

  // A hidden tab gets no animation frames, so a batch can sit pending for as
  // long as the viewer looks elsewhere; deliver it the moment they come back.
  env.onVisible?.(() => flush());
  env.onPageHide?.(() => {
    for (const handle of [coalesceTimer, keepaliveTimer, newcomerTimer, sweepTimer]) {
      env.clearTimer(handle);
    }
    coalesceTimer = keepaliveTimer = newcomerTimer = sweepTimer = null;
  });

  /* ----------------------------- the API ----------------------------- */

  function takeEmitToken(): boolean {
    const now = env.now();
    const elapsed = Math.max(0, now - emitRefilledAt) / 1000;
    emitRefilledAt = now;
    emitTokens = Math.min(EMIT_BURST, emitTokens + elapsed * EMIT_REFILL_PER_SEC);
    if (emitTokens < 1) return false;
    emitTokens -= 1;
    return true;
  }

  const emit = pipe.wrap("emit", (topic: string, data?: unknown): Promise<void> => {
    if (terminal) return Promise.reject(terminal);
    validateEmit(topic, data, limits.maxBytes);
    if (!takeEmitToken()) {
      if (!rateNoticeSent) {
        rateNoticeSent = true;
        env.reportError(new Error(RATE_LIMIT_NOTICE));
      }
      // Over budget: the moment is dropped and the call still resolves.
      return Promise.resolve();
    }
    return rpc.call("emit", [topic, data]).then(() => undefined);
  });

  const presence = pipe.wrap("presence", (patch: Record<string, unknown>): Promise<void> => {
    if (terminal) return Promise.reject(terminal);
    ownPresence = mergePresence(ownPresence, patch, limits.maxBytes);
    refreshSelf();
    schedulePresenceSend();
    return Promise.resolve();
  });

  function readDeliver(options: unknown): "stage" | "send" {
    try {
      if (options === null || options === undefined) return "stage";
      return (options as { deliver?: unknown }).deliver === "send" ? "send" : "stage";
    } catch {
      throw capError(
        "invalid_argument",
        'room.sendToClaudeSession\'s options must be a plain object such as {deliver: "send"}',
      );
    }
  }

  const sendToClaudeSession = pipe.wrap(
    "sendToClaudeSession",
    (data: unknown, options?: unknown): Promise<{ to: string }> => {
      let payload: Record<string, unknown>;
      try {
        payload = validateToClaude(data);
      } catch (err) {
        throw asCapError(err, "room.sendToClaudeSession takes plain data");
      }
      const deliver = readDeliver(options);
      return rpc
        .call<{ to?: unknown }>("sendToClaudeSession", [payload, { deliver }])
        .then((result) => {
          const to = (result as { to?: unknown } | null)?.to;
          return { to: to === "session" || to === "new" ? to : "pane" };
        });
    },
  );

  const canSendToClaudeSession = pipe.wrap("canSendToClaudeSession", (): Promise<string> =>
    rpc
      .call<unknown>("canSendToClaudeSession", [])
      .then((result) => (typeof result === "string" ? result : "off")),
  );

  function microtask(fn: () => void): void {
    void Promise.resolve().then(fn);
  }

  function on(topic: string, handler: (msg: Message) => void, onError?: OnError): () => void {
    if (typeof handler !== "function") {
      throw new TypeError("room.on requires a handler function");
    }
    if (terminal) {
      const failure = terminal;
      if (onError) microtask(() => onError(failure));
      return () => undefined;
    }
    if (!isTopic(topic)) {
      if (onError) {
        microtask(() =>
          onError({
            code: "invalid_argument",
            message: `on topic must match ${TOPIC_RE.source} (colon-free)`,
          }),
        );
      }
      return () => undefined;
    }
    const listener: TopicListener = { handler, onError, dead: false };
    let set = topicListeners.get(topic);
    if (!set) {
      set = new Set();
      topicListeners.set(topic, set);
    }
    set.add(listener);
    return () => {
      listener.dead = true;
      set.delete(listener);
      if (set.size === 0) topicListeners.delete(topic);
    };
  }

  function onPeers(handler: (change: PeersChange) => void, onError?: OnError): () => void {
    if (typeof handler !== "function") {
      throw new TypeError("room.onPeers requires a handler function");
    }
    if (terminal) {
      const failure = terminal;
      if (onError) microtask(() => onError(failure));
      return () => undefined;
    }
    const listener: PeersListener = { handler, onError, dead: false, primed: false };
    peersListeners.add(listener);
    microtask(() => {
      if (listener.dead) return;
      // Everyone already waiting sees the pending diff first, so this
      // listener's own "room so far" cannot double-report a join.
      flush();
      if (listener.dead) return;
      listener.primed = true;
      const peers = currentPeers();
      if (peers.length === 0) return;
      for (const peer of peers) delivered.set(peer.peer, peer);
      safely(() =>
        listener.handler(
          Object.freeze({
            peers,
            joined: peers,
            left: EMPTY_PEERS,
            updated: EMPTY_PEERS,
          }),
        ),
      );
    });
    return () => {
      listener.dead = true;
      peersListeners.delete(listener);
    };
  }

  function onConnection(handler: (up: boolean) => void, onError?: OnError): () => void {
    if (typeof handler !== "function") {
      throw new TypeError("room.onConnection requires a handler function");
    }
    if (terminal) {
      const failure = terminal;
      if (onError) microtask(() => onError(failure));
      return () => undefined;
    }
    const listener: ConnectionListener = { handler, onError, dead: false };
    connectionListeners.add(listener);
    microtask(() => {
      if (listener.dead) return;
      safely(() => listener.handler(connectedFlag));
    });
    return () => {
      listener.dead = true;
      connectionListeners.delete(listener);
    };
  }

  sendHello();

  return {
    emit,
    presence,
    peers: () => currentPeers(),
    connected: () => connectedFlag,
    on,
    onPeers,
    onConnection,
    sendToClaudeSession,
    canSendToClaudeSession,
  };
}

export function install(ctx: FrameContext, env: RoomEnv = browserEnv(ctx.shellOrigin)): void {
  ctx.mount(CAP, createRoom(ctx, env) as unknown as object);
}
