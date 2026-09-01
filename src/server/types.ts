/**
 * The seam every capability slice's `server.ts` sees. A slice registers HTTP
 * routes on either app and, later, websocket lanes — and touches nothing
 * else in the server.
 */
import type { Hono } from "hono";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Auth } from "./auth.ts";
import type { ServerConfig, SharingLevel } from "./config.ts";
import type { Store } from "./store.ts";

/**
 * Who is asking on the frame origin. Identity there comes only from the
 * signed `__frame_t` asset token in the iframe URL, so a subresource fetch
 * that carries none is anonymous — never "the last viewer we saw".
 */
export interface FrameViewer {
  /** `null` when the request carried no asset token. */
  id: string | null;
  /** The artifact this origin serves, or `null` on an unlabelled host. */
  artifactId: string | null;
  level: SharingLevel;
}

/** Hono variables every frame-origin handler (spine or slice) can read. */
export type FrameEnv = { Variables: { frameViewer: FrameViewer } };
export type FrameApp = Hono<FrameEnv>;

export interface ServerApps {
  /** The shell origin (viewer cookie, broker backends, admin API). */
  shell: Hono;
  /** The per-artifact frame origin (content, runtime, blobs). */
  frame: FrameApp;
}

export type WsUpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
) => void;

export interface WsRegistry {
  /** Claim a pathname on the shell origin for a websocket lane. */
  register(pathname: string, handler: WsUpgradeHandler): void;
  handlerFor(pathname: string): WsUpgradeHandler | undefined;
}

export interface ServerContext {
  config: ServerConfig;
  store: Store;
  auth: Auth;
  /** Live ports: with `port: 0` these are only known after listen. */
  shellPort: number;
  framePort: number;
  shellOrigin: string;
  frameOriginFor(artifactId: string): string;
  ws: WsRegistry;
}

export interface CapabilityServer {
  routes?(apps: ServerApps, ctx: ServerContext): void;
}
