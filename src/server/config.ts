/**
 * Server configuration. Every knob is an environment variable with a
 * development default, so `npm run dev` works with no setup.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

export type SharingLevel = "view" | "interact" | "admin" | "owner";

export interface ServerConfig {
  shellPort: number;
  framePort: number;
  /** Hostname the shell is served on (the frame's `frame-ancestors`). */
  shellHost: string;
  /** Suffix appended to the artifact id for the frame origin. */
  frameHostSuffix: string;
  dataDir: string;
  distDir: string;
  /** HMAC secret for cookies and asset tokens. */
  secret: string;
  /** Address the two apps bind to. Loopback unless `BIND_HOST` says otherwise. */
  bindHost: string;
  /** `/login?token=<this>` makes a viewer the owner of every artifact. */
  ownerToken: string | null;
  /**
   * Level a non-owner viewer gets. Only `owner` and `admin` may write, so an
   * `interact` viewer reaches the capabilities but never publishes.
   */
  defaultLevel: SharingLevel;
  /**
   * Serve the admin API (create/publish) to unauthenticated callers. Opt-in
   * (`ARTIFACT_OPEN_ADMIN=1`) because it is a write API with no credential.
   */
  openAdminApi: boolean;
  /** Asset-token lifetime in seconds. */
  assetTokenTtlSec: number;
  /** How often an idle view polls for a new version (ms; 0 disables). */
  versionPollMs: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const level = process.env.ARTIFACT_DEFAULT_LEVEL;
  const config: ServerConfig = {
    shellPort: intEnv("SHELL_PORT", 8787),
    framePort: intEnv("FRAME_PORT", 8788),
    shellHost: process.env.SHELL_HOST ?? "localhost",
    frameHostSuffix: process.env.FRAME_HOST_SUFFIX ?? "localhost",
    dataDir: resolve(process.env.DATA_DIR ?? "./data"),
    distDir: resolve(process.env.DIST_DIR ?? "./dist"),
    secret: process.env.ARTIFACT_SECRET ?? randomBytes(32).toString("hex"),
    bindHost: process.env.BIND_HOST ?? "127.0.0.1",
    ownerToken: process.env.ARTIFACT_OWNER_TOKEN ?? null,
    defaultLevel: level === "admin" ? "admin" : level === "view" ? "view" : "interact",
    openAdminApi: process.env.ARTIFACT_OPEN_ADMIN === "1",
    assetTokenTtlSec: intEnv("ARTIFACT_TOKEN_TTL", 30 * 60),
    versionPollMs: intEnv("VERSION_POLL_MS", 5000),
    ...overrides,
  };
  return config;
}

export function shellOrigin(config: ServerConfig, port = config.shellPort): string {
  return `http://${config.shellHost}:${port}`;
}

export function frameOrigin(config: ServerConfig, artifactId: string, port = config.framePort): string {
  return `http://${artifactId}.${config.frameHostSuffix}:${port}`;
}
