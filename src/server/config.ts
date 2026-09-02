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
  /**
   * Scheme both public origins are built with (`PUBLIC_SCHEME`, or the scheme
   * of `PUBLIC_SHELL_URL`). `https` is also what turns on `Secure` cookies and
   * the `__Host-` prefix, so a deployment behind a TLS terminator must say so
   * here: `X-Forwarded-Proto` is a client-settable header and is deliberately
   * not trusted for this.
   */
  publicScheme: "http" | "https";
  /**
   * Port the shell's public origin carries, or `null` for the port it listens
   * on. The scheme's default port (443/80) renders as no port at all, which is
   * what a terminator in front of us wants.
   */
  publicShellPort: number | null;
  /** The same for the per-artifact frame origin. */
  publicFramePort: number | null;
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
  /**
   * Posting this to `/login` makes a browser the owner of every artifact. It
   * is also the admin API's bearer credential, and the owner cookie is bound
   * to it: rotating it logs every owner session out.
   */
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

/** A public origin, with the scheme's default port left off. */
function renderOrigin(scheme: "http" | "https", host: string, port: number): string {
  const bare = port === (scheme === "https" ? 443 : 80);
  return bare ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
}

interface PublicUrl {
  scheme: "http" | "https";
  host: string;
  /** `null` when the URL named no port, i.e. the scheme's default. */
  port: number | null;
}

/**
 * `PUBLIC_SHELL_URL`: the origin browsers actually reach the shell at, which
 * behind a TLS terminator is not the address we bind. Only an origin is
 * accepted — a path, a query or credentials in it means the operator meant
 * something else, and guessing would silently mis-build `frame-ancestors`.
 */
function parsePublicUrl(name: string, raw: string | undefined): PublicUrl | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be http: or https:`);
  }
  const bare = url.pathname === "/" || url.pathname === "";
  if (url.username || url.password || url.search || url.hash || !bare) {
    throw new Error(`${name} must be a bare origin, e.g. https://artifacts.example.com`);
  }
  return {
    scheme: url.protocol === "https:" ? "https" : "http",
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : null,
  };
}

function schemeEnv(raw: string | undefined, fallback: "http" | "https"): "http" | "https" {
  if (raw === undefined || raw === "") return fallback;
  if (raw !== "http" && raw !== "https") throw new Error(`PUBLIC_SCHEME must be http or https`);
  return raw;
}

function portEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} is not a port: ${raw}`);
  return n;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const level = process.env.ARTIFACT_DEFAULT_LEVEL;
  const publicShell = parsePublicUrl("PUBLIC_SHELL_URL", process.env.PUBLIC_SHELL_URL);
  const scheme = schemeEnv(process.env.PUBLIC_SCHEME, publicShell?.scheme ?? "http");
  const defaultPort = scheme === "https" ? 443 : 80;
  const config: ServerConfig = {
    shellPort: intEnv("SHELL_PORT", 8787),
    framePort: intEnv("FRAME_PORT", 8788),
    shellHost: publicShell?.host ?? process.env.SHELL_HOST ?? "localhost",
    frameHostSuffix: process.env.FRAME_HOST_SUFFIX ?? "localhost",
    publicScheme: scheme,
    publicShellPort: publicShell ? (publicShell.port ?? defaultPort) : portEnv("PUBLIC_SHELL_PORT"),
    // A `PUBLIC_SHELL_URL` with no port is a terminator on the scheme's own
    // port; the wildcard frame host is behind the same one, so it inherits it.
    publicFramePort:
      portEnv("PUBLIC_FRAME_PORT") ?? (publicShell && publicShell.port === null ? defaultPort : null),
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

export function shellOrigin(config: ServerConfig, port = config.shellPort): string {
  return renderOrigin(config.publicScheme, config.shellHost, config.publicShellPort ?? port);
}

export function frameOrigin(config: ServerConfig, artifactId: string, port = config.framePort): string {
  const host = `${artifactId}.${config.frameHostSuffix}`;
  return renderOrigin(config.publicScheme, host, config.publicFramePort ?? port);
}

/**
 * Whether the public origins are https. Cookies get `Secure` and the
 * `__Host-` prefix exactly here, so this is the one switch a TLS deployment
 * has to throw.
 */
export function usesTls(config: ServerConfig): boolean {
  return config.publicScheme === "https";
}

/** A bind address that only the machine itself can reach. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bare === "127.0.0.1" || bare === "::1" || bare === "localhost" || bare.startsWith("127.");
}
