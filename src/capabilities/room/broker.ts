/**
 * `room` broker: the shell half of the room.
 *
 * One websocket lane per mounted view (`/api/frame/room/ws` on the shell
 * origin, opened once and reopened with backoff), and the translation in
 * both directions:
 *
 *   frame  → `hello` / `presence` / `emit` / the send-to-Claude pair
 *   server → `__frame_room_ev` with the `presence` / `event` / `gone` /
 *            `conn` / `revoked` arms the frame module expects.
 *
 * The ACL lives here as well as on the server: the declaration's
 * `{topics: {name: "interact" | "admin"}}` is checked against this viewer's
 * sharing level so the page gets a real `not_permitted` rejection rather
 * than a silent drop. No token ever crosses to the frame: the lane carries
 * the viewer's cookie because it is same-origin with the shell.
 */
import { capError } from "../../protocol/errors.ts";
import type { BrokerCall, BrokerContext } from "../../shell/types.ts";
import { isTopic } from "./validate.ts";
import {
  mayEmit,
  mintPeerId,
  readLimits,
  readTopics,
  type LaneEvent,
  type TopicLevel,
} from "./protocol.ts";

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

interface ViewState {
  peerId: string;
  topics: Map<string, TopicLevel>;
  /**
   * The artifact's own presence cap — the same number the frame applied to
   * the merged object. A patch past it is one the frame should never have
   * sent: the last line of defence before the wire.
   */
  maxBytes: number;
  socket: WebSocket | null;
  open: boolean;
  disposed: boolean;
  /** The terminal code the server sent, or `null` while the view is live. */
  revoked: string | null;
  backoffMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** The last presence the frame sent, replayed when the lane comes back. */
  lastPresence: Record<string, unknown> | null;
}

const states = new WeakMap<BrokerContext, ViewState>();

function stateFor(ctx: BrokerContext): ViewState {
  const existing = states.get(ctx);
  if (existing) return existing;
  const state: ViewState = {
    peerId: mintPeerId(),
    topics: readTopics(ctx.boot.capabilities.room?.config),
    maxBytes: readLimits(ctx.boot.capabilities.room?.config).maxBytes,
    socket: null,
    open: false,
    disposed: false,
    revoked: null,
    backoffMs: RECONNECT_MIN_MS,
    reconnectTimer: null,
    lastPresence: null,
  };
  states.set(ctx, state);
  return state;
}

/* ------------------------------------------------------------------ */
/* the lane                                                            */
/* ------------------------------------------------------------------ */

function laneUrl(ctx: BrokerContext, state: ViewState): string | null {
  if (typeof location === "undefined" || typeof WebSocket === "undefined") return null;
  const url = new URL("/api/frame/room/ws", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("artifact", ctx.boot.artifactId);
  url.searchParams.set("peer", state.peerId);
  return url.href;
}

function toFrame(ctx: BrokerContext, ev: Record<string, unknown>): void {
  ctx.toFrame({ __frame_room_ev: true, ev });
}

function sendLane(state: ViewState, message: unknown): boolean {
  const socket = state.socket;
  if (!socket || !state.open) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function closeLane(state: ViewState): void {
  state.open = false;
  if (state.reconnectTimer !== null) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  const socket = state.socket;
  state.socket = null;
  if (!socket) return;
  socket.onopen = null;
  socket.onclose = null;
  socket.onerror = null;
  socket.onmessage = null;
  try {
    socket.close();
  } catch {
    /* already gone */
  }
}

function onLaneEvent(ctx: BrokerContext, state: ViewState, event: LaneEvent): void {
  switch (event.kind) {
    case "welcome":
      // The server is authoritative about the id it will stamp on our
      // messages; adopt it so `isMe`/`sameTab` line up on every page.
      if (typeof event.peer === "string" && event.peer !== "") state.peerId = event.peer;
      return;
    case "presence":
      toFrame(ctx, {
        arm: "presence",
        peer: event.peer,
        p: event.p,
        isMe: event.isMe === true,
        kind: "viewer",
      });
      return;
    case "event":
      toFrame(ctx, {
        arm: "event",
        topic: event.topic,
        peer: event.peer,
        d: event.d,
        isMe: event.isMe === true,
        sameTab: event.sameTab === true,
        kind: "viewer",
      });
      return;
    case "gone":
      toFrame(ctx, { arm: "gone", peer: event.peer });
      return;
    case "revoked":
      state.revoked = typeof event.code === "string" && event.code ? event.code : "revoked";
      closeLane(state);
      toFrame(ctx, { arm: "revoked", code: event.code ?? "revoked" });
      return;
    default:
      return;
  }
}

function ensureLane(ctx: BrokerContext, state: ViewState): void {
  if (state.disposed || state.revoked !== null || state.socket !== null) return;
  const url = laneUrl(ctx, state);
  if (url === null) return;
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch {
    return;
  }
  state.socket = socket;
  socket.onopen = () => {
    if (state.socket !== socket) return;
    state.open = true;
    state.backoffMs = RECONNECT_MIN_MS;
    // The frame re-asserts its own presence on `conn up`, but replaying the
    // last object closes the gap before that round trip lands.
    if (state.lastPresence) sendLane(state, { kind: "presence", p: state.lastPresence });
    toFrame(ctx, { arm: "conn", up: true });
  };
  socket.onmessage = (message: MessageEvent) => {
    if (state.socket !== socket) return;
    let event: LaneEvent;
    try {
      event = JSON.parse(String(message.data)) as LaneEvent;
    } catch {
      return;
    }
    if (typeof event !== "object" || event === null || typeof event.kind !== "string") return;
    onLaneEvent(ctx, state, event);
  };
  const dropped = (): void => {
    if (state.socket !== socket) return;
    state.socket = null;
    const wasOpen = state.open;
    state.open = false;
    if (state.disposed || state.revoked !== null) return;
    if (wasOpen) toFrame(ctx, { arm: "conn", up: false });
    const wait = state.backoffMs;
    state.backoffMs = Math.min(RECONNECT_MAX_MS, state.backoffMs * 2);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      ensureLane(ctx, state);
    }, wait);
  };
  socket.onclose = dropped;
  socket.onerror = dropped;
}

/* ------------------------------------------------------------------ */
/* the methods                                                         */
/* ------------------------------------------------------------------ */

function bytesOf(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export async function handle(call: BrokerCall, ctx: BrokerContext): Promise<unknown> {
  const state = stateFor(ctx);

  switch (call.method) {
    case "hello": {
      if (state.revoked !== null) return { terminal: { code: state.revoked } };
      ensureLane(ctx, state);
      // `up` is false until the socket opens; the `conn` arm follows and the
      // frame re-asserts its presence then.
      return { peer: state.peerId, up: state.open };
    }

    case "presence": {
      const patch = call.args[0];
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        throw capError("invalid_argument", "presence takes one object");
      }
      if (bytesOf(patch) > state.maxBytes) {
        throw capError("invalid_argument", "presence object is too large");
      }
      state.lastPresence = patch as Record<string, unknown>;
      ensureLane(ctx, state);
      sendLane(state, { kind: "presence", p: patch });
      return undefined;
    }

    case "emit": {
      const topic = call.args[0];
      if (!isTopic(topic)) {
        throw capError(
          "invalid_argument",
          "emit topic must match ^[a-z][a-z0-9_.-]{0,47}$ (colon-free)",
        );
      }
      if (!mayEmit(topic, ctx.viewer.level, state.topics)) {
        throw capError(
          "not_permitted",
          `this viewer may not send on the topic "${topic}"`,
        );
      }
      // A moment sent while the lane is down is dropped, never queued.
      if (state.open) sendLane(state, { kind: "emit", topic, d: call.args[1] });
      else ensureLane(ctx, state);
      return undefined;
    }

    case "canSendToClaudeSession":
      // v0 has no Claude pane beside the artifact, so the control is hidden
      // rather than offered and made to fail.
      return "off";

    case "sendToClaudeSession":
      throw capError(
        "claude_unavailable",
        "no conversation with Claude is open beside this view",
      );

    default:
      throw capError("invalid_argument", `room.${call.method} is not a method`);
  }
}

export function dispose(ctx: BrokerContext): void {
  const state = states.get(ctx);
  if (!state) return;
  state.disposed = true;
  closeLane(state);
  states.delete(ctx);
}
