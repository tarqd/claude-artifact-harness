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
  /**
   * Conformance mode: serve `/_runtime/*.js` and the inline preamble from this
   * directory instead of `dist/` (e.g. `reference/runtime`, holding the
   * platform's own modules fetched by `scripts/fetch-runtime.sh`, plus
   * `preamble.js` and `preamble-config.json`). `null` serves our runtime.
   */
  runtimeDir: string | null;
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
  /**
   * Serve the frame origin's `/_a/<artifactId>/...` prefix form. Opt-in
   * (`ARTIFACT_PREFIX_HOSTS=1`) because every artifact reached that way
   * shares one browser origin: it is a tooling path for hosts without
   * wildcard DNS, not a way to open an artifact.
   */
  allowPrefixHosts: boolean;
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
    runtimeDir: process.env.RUNTIME_DIR ? resolve(process.env.RUNTIME_DIR) : null,
    secret: process.env.ARTIFACT_SECRET ?? randomBytes(32).toString("hex"),
    bindHost: process.env.BIND_HOST ?? "127.0.0.1",
    ownerToken: process.env.ARTIFACT_OWNER_TOKEN ?? null,
    defaultLevel: level === "admin" ? "admin" : level === "view" ? "view" : "interact",
    openAdminApi: process.env.ARTIFACT_OPEN_ADMIN === "1",
    allowPrefixHosts: process.env.ARTIFACT_PREFIX_HOSTS === "1",
    assetTokenTtlSec: intEnv("ARTIFACT_TOKEN_TTL", 30 * 60),
    versionPollMs: intEnv("VERSION_POLL_MS", 5000),
    ...overrides,
  };
  return config;
}

/** Loopback: a server bound here is reachable only from this machine. */
function isLoopbackHost(host: string): boolean {
  const bare = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return bare === "localhost" || bare === "::1" || bare === "::ffff:127.0.0.1" || /^127\./.test(bare);
}

/**
 * Lines to print at boot when the configuration puts the operator's
 * credentials behind nothing. `ARTIFACT_DEFAULT_LEVEL=interact` — the
 * default — makes every visitor an `interact` viewer, and `interact` buys
 * the capability calls: `sample` spends `ANTHROPIC_API_KEY`, `mcp` spends
 * whatever `MCP_SERVERS` authenticates with, and both are shared by every
 * viewer. On loopback the visitor is the operator, so this is silent; once
 * `BIND_HOST` reaches further, anyone who can open a published artifact can
 * spend those credentials, and the operator is told so.
 */
export function exposureWarnings(
  config: ServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (isLoopbackHost(config.bindHost)) return [];
  if (config.defaultLevel === "view") return [];
  const assets: string[] = [];
  if (env.ANTHROPIC_API_KEY?.trim()) assets.push("ANTHROPIC_API_KEY");
  if (env.MCP_SERVERS?.trim() || env.MCP_SERVERS_FILE?.trim()) assets.push("MCP_SERVERS");
  if (assets.length === 0) return [];
  return [
    `warn   BIND_HOST=${config.bindHost} with ARTIFACT_DEFAULT_LEVEL=${config.defaultLevel} and ${assets.join(" and ")} set:`,
    `warn   every visitor of a published artifact gets ${config.defaultLevel} and may spend those credentials.`,
    "warn   Set ARTIFACT_DEFAULT_LEVEL=view (only the owner then reaches sample and mcp), or stay on loopback.",
  ];
}

export function shellOrigin(config: ServerConfig, port = config.shellPort): string {
  return `http://${config.shellHost}:${port}`;
}

export function frameOrigin(config: ServerConfig, artifactId: string, port = config.framePort): string {
  return `http://${artifactId}.${config.frameHostSuffix}:${port}`;
}
