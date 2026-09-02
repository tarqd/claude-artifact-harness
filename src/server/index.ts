/**
 * Boot: two Hono apps — the shell origin and the per-artifact frame origin —
 * plus the websocket upgrade wiring the realtime slices will claim.
 */
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createAuth } from "./auth.ts";
import { frameOrigin, loadConfig, shellOrigin, type ServerConfig } from "./config.ts";
import { mountCapabilityRoutes } from "./routes.ts";
import { isArtifactId } from "../protocol/paths.ts";
import { mountFrameRoutes, mountShellRoutes } from "./serve.ts";
import { createStore } from "./store.ts";
import type {
  FrameApp,
  FrameEnv,
  ServerApps,
  ServerContext,
  WsRegistry,
  WsUpgradeHandler,
} from "./types.ts";

const ARTIFACT_PREFIX_RE = /^\/_a\/([0-9a-f]{32})(\/.*)?$/;

export interface RunningServer {
  config: ServerConfig;
  shellPort: number;
  framePort: number;
  shellOrigin: string;
  frameOriginFor(artifactId: string): string;
  context: ServerContext;
  close(): Promise<void>;
}

class Registry implements WsRegistry {
  private readonly lanes = new Map<string, WsUpgradeHandler>();
  register(pathname: string, handler: WsUpgradeHandler): void {
    this.lanes.set(pathname, handler);
  }
  handlerFor(pathname: string): WsUpgradeHandler | undefined {
    return this.lanes.get(pathname);
  }
}

export async function startServer(
  overrides: Partial<ServerConfig> = {},
): Promise<RunningServer> {
  const config = loadConfig(overrides);
  const store = createStore(config.dataDir);
  const auth = createAuth(config);
  const ws = new Registry();
  const shutdownHooks: Array<() => void | Promise<void>> = [];

  const shellApp = new Hono();
  const frameApp = new Hono<FrameEnv>();
  const apps: ServerApps = { shell: shellApp, frame: frameApp };

  // Ports are only known after listen when 0 was requested; these holders let
  // the request handlers build absolute URLs with the real ports.
  let shellPort = config.shellPort;
  let framePort = config.framePort;
  const originOfShell = (): string => shellOrigin(config, shellPort);

  const context: ServerContext = {
    config,
    store,
    auth,
    get shellPort() {
      return shellPort;
    },
    get framePort() {
      return framePort;
    },
    get shellOrigin() {
      return originOfShell();
    },
    frameOriginFor: (artifactId: string) => frameOrigin(config, artifactId, framePort),
    ws,
    onShutdown: (fn) => {
      shutdownHooks.push(fn);
    },
  };

  mountShellRoutes(shellApp, context);
  mountFrameRoutes(frameApp, context);

  mountCapabilityRoutes(apps, context);

  /* ------------------------------- listeners ------------------------------- */

  const shell = await listen({
    fetch: shellApp.fetch,
    port: config.shellPort,
    hostname: config.bindHost,
  });
  const frame = await listen({
    fetch: (request: Request) => frameFetch(request, frameApp, config.allowPrefixHosts),
    port: config.framePort,
    hostname: config.bindHost,
  });
  const shellServer = shell.server;
  const frameServer = frame.server;
  shellPort = shell.port;
  framePort = frame.port;

  // Websocket lanes (db rows, room broadcasts) are claimed by slices through
  // `ctx.ws.register(pathname, handler)`. Both origins accept upgrades; an
  // unclaimed path is closed rather than left hanging.
  const upgrade = (base: string) =>
    (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
      const url = new URL(request.url ?? "/", base);
      const handler = ws.handlerFor(url.pathname);
      if (!handler) {
        socket.destroy();
        return;
      }
      handler(request, socket, head, url);
    };
  shellServer.on("upgrade", upgrade(originOfShell()));
  frameServer.on("upgrade", upgrade(originOfShell()));

  return {
    config,
    shellPort,
    framePort,
    shellOrigin: originOfShell(),
    frameOriginFor: context.frameOriginFor,
    context,
    close: async () => {
      // Slice hooks first: an upgraded websocket counts as an open connection,
      // so `close()` would never settle while a lane is still attached.
      for (const hook of shutdownHooks) {
        try {
          await hook();
        } catch {
          /* one slice's cleanup must not hold the server open */
        }
      }
      await Promise.all([closeServer(shellServer), closeServer(frameServer)]);
    },
  };
}

/**
 * Accept the `/_a/<id>/...` prefix form for hosts without wildcard DNS —
 * but only when it is explicitly enabled (`ARTIFACT_PREFIX_HOSTS=1`), and
 * only on a host that is not itself an artifact origin. Off by default:
 * artifacts reached through the prefix share one browser origin, which is
 * the isolation the per-artifact host exists to provide. On
 * `<id>.localhost` the host label is the artifact, and neither the prefix
 * form nor a client-supplied `x-artifact-id` may name another one: that
 * would serve a foreign artifact's bytes under this artifact's origin.
 */
async function frameFetch(
  request: Request,
  app: FrameApp,
  allowPrefix: boolean,
): Promise<Response> {
  const url = new URL(request.url);
  const hostLabel = (request.headers.get("host") ?? "").split(":")[0]?.split(".")[0] ?? "";
  const labelled = isArtifactId(hostLabel);
  const match = allowPrefix ? ARTIFACT_PREFIX_RE.exec(url.pathname) : null;
  const usePrefix =
    match !== null && !labelled && (request.method === "GET" || request.method === "HEAD");
  if (!usePrefix && !request.headers.has("x-artifact-id")) return app.fetch(request);

  const headers = new Headers(request.headers);
  headers.delete("x-artifact-id"); // never trusted from the client
  if (usePrefix) {
    url.pathname = match![2] ?? "/";
    headers.set("x-artifact-id", match![1]!);
  }
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  return app.fetch(new Request(url, init));
}

type ListenOptions = Parameters<typeof serve>[0];

/** `serve()` binds asynchronously; wait for the real port (port 0 in tests). */
function listen(options: ListenOptions): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve) => {
    const server: ServerType = serve(options, (info: AddressInfo) => {
      resolve({ server, port: info.port });
    });
  });
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
