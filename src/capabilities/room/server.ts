/**
 * `room` backend: one in-memory room per artifact, over a websocket lane on
 * the shell origin.
 *
 * The room is exactly the set of open documents: nothing is stored, nothing
 * is replayed. A connection is one peer, named by the id the shell minted
 * for that view and carrying the viewer id from the shell cookie, which is
 * used only to answer "is this me?" — the id itself never leaves the server,
 * so `by` stays null on the wire exactly as the v1 contract says.
 *
 * Sending is enforced here as well as in the broker: a moment a viewer may
 * not send never reaches anyone, so pages need no role checks.
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { isArtifactId } from "../../protocol/paths.ts";
import { OWNER_COOKIE, VIEWER_COOKIE } from "../../server/auth.ts";
import type { ServerApps, ServerContext } from "../../server/types.ts";
import type { ArtifactMeta } from "../../server/store.ts";
import {
  isPeerId,
  mayEmit,
  readLimits,
  readTopics,
  MAX_LIMIT_BYTES,
  type LaneEvent,
} from "./protocol.ts";
import { isTopic } from "./validate.ts";

/**
 * The largest frame the lane will read at all. Every message is checked
 * again against the artifact's own `maxBytes` (4 KiB by default); this is
 * only the ceiling that stops `ws` from buffering a 100 MiB frame — its
 * default — before we get to look at it.
 */
const MAX_FRAME_BYTES = MAX_LIMIT_BYTES + 4096;

/** Per connection, mirroring the frame's own budgets. */
const EMIT_PER_SEC = 40;
const EMIT_BURST = 80;
const MESSAGE_PER_SEC = 120;
const MESSAGE_BURST = 240;

/**
 * The most sockets one signed-in viewer may hold open in one room. A viewer
 * driving the lane directly (devtools, many tabs) would otherwise multiply
 * both the ingress budget and the fan-out cost without limit; a handful of
 * tabs on one document is the legitimate case this still allows.
 */
const MAX_SOCKETS_PER_VIEWER = 8;

interface Bucket {
  tokens: number;
  at: number;
}

function takeToken(bucket: Bucket, perSec: number, burst: number, now: number): boolean {
  const elapsed = Math.max(0, now - bucket.at) / 1000;
  bucket.at = now;
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed * perSec);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

interface Conn {
  socket: WebSocket;
  peerId: string;
  /** The signed-in viewer this peer id belongs to; never null. */
  viewerId: string;
  level: string;
  maxBytes: number;
  messages: Bucket;
  emits: Bucket;
}

interface Room {
  artifactId: string;
  conns: Map<string, Conn>;
}

function readCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function declaresRoom(meta: ArtifactMeta): boolean {
  return Object.prototype.hasOwnProperty.call(meta.capabilities, "room");
}

export function routes(_apps: ServerApps, ctx: ServerContext): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const rooms = new Map<string, Room>();
  const sockets = new Set<Duplex>();

  // `server.close()` waits for every open connection and an upgraded socket is
  // still one, so drop this lane's sockets when the server is shutting down.
  ctx.onShutdown(() => {
    for (const open of sockets) open.destroy();
    sockets.clear();
  });

  function roomFor(artifactId: string): Room {
    const existing = rooms.get(artifactId);
    if (existing) return existing;
    const room: Room = { artifactId, conns: new Map() };
    rooms.set(artifactId, room);
    return room;
  }

  /** Is this peer id currently held by a different viewer's connection? */
  function heldByAnother(artifactId: string, peerId: string, viewerId: string): boolean {
    const held = rooms.get(artifactId)?.conns.get(peerId);
    return held !== undefined && held.viewerId !== viewerId;
  }

  function send(conn: Conn, event: LaneEvent): void {
    if (conn.socket.readyState !== 1) return;
    try {
      conn.socket.send(JSON.stringify(event));
    } catch {
      /* the peer went away between the check and the write */
    }
  }

  /** Do two connections belong to the same signed-in viewer? */
  function sameViewer(a: Conn, b: Conn): boolean {
    return a.viewerId === b.viewerId;
  }

  function broadcastPresence(room: Room, from: Conn, presence: Record<string, unknown>): void {
    for (const conn of room.conns.values()) {
      // The sender's own document already applied this locally.
      if (conn === from) continue;
      send(conn, {
        kind: "presence",
        peer: from.peerId,
        p: presence,
        isMe: sameViewer(conn, from),
      });
    }
  }

  function broadcastEvent(room: Room, from: Conn, topic: string, data: unknown): void {
    for (const conn of room.conns.values()) {
      send(conn, {
        kind: "event",
        peer: from.peerId,
        topic,
        d: data,
        // Everyone hears it, the sender included: that is the echo pages
        // render on, and only the sending document gets `sameTab`.
        isMe: conn === from || sameViewer(conn, from),
        sameTab: conn === from,
      });
    }
  }

  function drop(room: Room, conn: Conn): void {
    if (room.conns.get(conn.peerId) !== conn) return;
    room.conns.delete(conn.peerId);
    for (const other of room.conns.values()) send(other, { kind: "gone", peer: conn.peerId });
    if (room.conns.size === 0) rooms.delete(room.artifactId);
  }

  function bytesOf(value: unknown): number {
    try {
      return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  /**
   * Complete the upgrade only to say no. The frame's terminal path is
   * driven by `revoked`, so a viewer this server will never connect hears
   * `not_granted` once rather than watching the broker reconnect forever.
   */
  function refuse(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    code: string,
  ): void {
    wss.handleUpgrade(request, socket, head, (ws) => {
      try {
        ws.send(JSON.stringify({ kind: "revoked", code } satisfies LaneEvent));
      } catch {
        /* the peer went away mid-handshake */
      }
      ws.close();
    });
  }

  /**
   * The lane is a shell-origin resource. The spine offers every registered
   * path on both listeners, so the port this upgrade arrived on is checked
   * here: the frame origin has no business opening a room, and a request
   * that reached the frame port is refused whatever it claims.
   */
  function onShellListener(request: IncomingMessage): boolean {
    const localPort = request.socket.localPort;
    if (typeof localPort === "number" && localPort > 0) return localPort === ctx.shellPort;
    const host = request.headers.host ?? "";
    return host !== "" && host === new URL(ctx.shellOrigin).host;
  }

  ctx.ws.register(
    "/api/frame/room/ws",
    (request: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => {
      // A shell-origin resource, and a credentialled one: no Origin, a
      // foreign Origin, the frame port, or no viewer cookie is not a room
      // this server has anything to say to — the socket is closed unread.
      if (!onShellListener(request) || request.headers.origin !== ctx.shellOrigin) {
        socket.destroy();
        return;
      }
      const artifactId = url.searchParams.get("artifact") ?? "";
      const peerId = url.searchParams.get("peer") ?? "";
      if (!isArtifactId(artifactId) || !isPeerId(peerId)) {
        socket.destroy();
        return;
      }
      // The same two cookies `Auth.viewer` reads on an HTTP request: the
      // lane must reach the same level the shell told the page it had, or
      // the backstop would silently contradict the broker.
      const cookies = readCookies(request.headers.cookie);
      const viewerId = ctx.auth.unseal(cookies[VIEWER_COOKIE]);
      if (viewerId === null) {
        socket.destroy();
        return;
      }
      const isOwner = ctx.auth.unseal(cookies[OWNER_COOKIE]) === viewerId;

      // A peer id is a label for one open document of one viewer. Presenting
      // one that another viewer holds is not a reconnect — it is an attempt
      // to speak as them — and it is refused rather than allowed to displace
      // the incumbent.
      if (heldByAnother(artifactId, peerId, viewerId)) {
        socket.destroy();
        return;
      }

          sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));

      void ctx.store
        .readMeta(artifactId)
        .then((meta) => {
          if (!meta || !declaresRoom(meta)) {
            refuse(request, socket, head, "not_granted");
            return;
          }
          const level = ctx.auth.levelFor({ id: viewerId, isOwner }, meta);
          const roomConfig = meta.capabilities.room?.config;
          const topics = readTopics(roomConfig);
          const { maxBytes, maxPeers } = readLimits(roomConfig);

          // Cap connections per (artifactId, viewerId) and per room, ahead of
          // the handshake so a capped viewer never gets a socket to hold
          // open. A reconnect on an already-held peer id displaces the
          // incumbent below and never grows either count, so it is exempt.
          const existingRoom = rooms.get(artifactId);
          const staleForPeer = existingRoom?.conns.get(peerId);
          const isReconnect = staleForPeer !== undefined && staleForPeer.viewerId === viewerId;
          if (!isReconnect) {
            const roomSize = existingRoom?.conns.size ?? 0;
            if (roomSize >= maxPeers) {
              refuse(request, socket, head, "resource_exhausted");
              return;
            }
            let viewerSockets = 0;
            if (existingRoom) {
              for (const conn of existingRoom.conns.values()) {
                if (conn.viewerId === viewerId) viewerSockets++;
              }
            }
            if (viewerSockets >= MAX_SOCKETS_PER_VIEWER) {
              refuse(request, socket, head, "resource_exhausted");
              return;
            }
          }

          wss.handleUpgrade(request, socket, head, (ws) => {
            const room = roomFor(artifactId);
            const now = Date.now();
            const conn: Conn = {
              socket: ws,
              peerId,
              viewerId,
              level,
              maxBytes,
              messages: { tokens: MESSAGE_BURST, at: now },
              emits: { tokens: EMIT_BURST, at: now },
            };
            // A second connection with the same peer id is this view
            // reconnecting: the stale one goes. Another viewer's id could
            // only have arrived between the check above and this callback.
            const stale = room.conns.get(peerId);
            if (stale && stale !== conn) {
              if (stale.viewerId !== viewerId) {
                ws.close();
                return;
              }
              room.conns.delete(peerId);
              try {
                stale.socket.close();
              } catch {
                /* already gone */
              }
            }
            room.conns.set(peerId, conn);
            send(conn, { kind: "welcome", peer: peerId });

            ws.on("close", () => drop(room, conn));
            ws.on("error", () => drop(room, conn));
            ws.on("message", (raw) => {
              // Unthrottled traffic is dropped here, not passed on: the
              // frame holds itself to the same budgets on the way out.
              if (!takeToken(conn.messages, MESSAGE_PER_SEC, MESSAGE_BURST, Date.now())) return;
              let message: { kind?: unknown; p?: unknown; topic?: unknown; d?: unknown };
              try {
                message = JSON.parse(String(raw)) as typeof message;
              } catch {
                return;
              }
              if (message.kind === "ping") {
                send(conn, { kind: "pong" });
                return;
              }
              if (message.kind === "presence") {
                const presence = message.p;
                if (typeof presence !== "object" || presence === null || Array.isArray(presence)) {
                  return;
                }
                if (bytesOf(presence) > conn.maxBytes) return;
                broadcastPresence(room, conn, presence as Record<string, unknown>);
                return;
              }
              if (message.kind === "emit") {
                const topic = message.topic;
                if (!isTopic(topic)) return;
                // The backstop behind the broker's `not_permitted`.
                if (!mayEmit(topic, conn.level, topics)) return;
                if (message.d !== undefined && bytesOf(message.d) > conn.maxBytes) return;
                if (!takeToken(conn.emits, EMIT_PER_SEC, EMIT_BURST, Date.now())) return;
                broadcastEvent(room, conn, topic, message.d);
              }
            });
          });
        })
        .catch(() => refuse(request, socket, head, "not_granted"));
    },
  );
}
