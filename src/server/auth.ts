/**
 * Viewer identity and authorisation (design.md "Auth and sharing (v0)").
 *
 * The shell origin holds a signed viewer cookie; the frame origin learns who
 * is asking only from the signed asset token in the `/_f/` URL. Tokens never
 * reach the frame's page code.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { mintUserId, isUserId } from "../protocol/paths.ts";
import { usesTls, type ServerConfig, type SharingLevel } from "./config.ts";
import type { ArtifactMeta } from "./store.ts";

/**
 * Cookie names. Over https both gain the `__Host-` prefix, which a browser
 * only accepts with `Secure`, `Path=/` and no `Domain` — so a sibling host
 * under a shared registrable domain cannot toss one at the shell (this is
 * also why the names are read through `Auth`, never hardcoded by a slice).
 */
export const VIEWER_COOKIE = "av";
export const OWNER_COOKIE = "ao";
const HOST_PREFIX = "__Host-";

/** A year: the viewer id is a label, not a credential with a session. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export interface Viewer {
  id: string;
  isOwner: boolean;
}

export interface AssetTokenClaims {
  viewerId: string;
  artifactId: string;
  expiresAt: number;
}

export class Auth {
  private readonly secure: boolean;
  private readonly viewerCookie: string;
  private readonly ownerCookie: string;

  constructor(private readonly config: ServerConfig) {
    this.secure = usesTls(config);
    this.viewerCookie = this.secure ? HOST_PREFIX + VIEWER_COOKIE : VIEWER_COOKIE;
    this.ownerCookie = this.secure ? HOST_PREFIX + OWNER_COOKIE : OWNER_COOKIE;
  }

  /** The viewer cookie's name on this deployment (`__Host-` prefixed on https). */
  viewerCookieName(): string {
    return this.viewerCookie;
  }

  /** The owner cookie's name on this deployment. */
  ownerCookieName(): string {
    return this.ownerCookie;
  }

  /**
   * `Secure` whenever the public origin is https, so the session never
   * travels in clear text, and `__Host-` needs it anyway.
   */
  private cookieOptions(): {
    path: string;
    httpOnly: true;
    sameSite: "Lax";
    secure: boolean;
    maxAge: number;
  } {
    return {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: this.secure,
      maxAge: COOKIE_MAX_AGE,
    };
  }

  private sign(value: string): string {
    return createHmac("sha256", this.config.secret).update(value).digest("base64url");
  }

  /** `<value>.<sig>` */
  seal(value: string): string {
    return `${value}.${this.sign(value)}`;
  }

  unseal(sealed: string | undefined): string | null {
    if (!sealed) return null;
    const cut = sealed.lastIndexOf(".");
    if (cut <= 0) return null;
    const value = sealed.slice(0, cut);
    const sig = sealed.slice(cut + 1);
    const expected = this.sign(value);
    if (sig.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return value;
  }

  /** Read the viewer cookie, minting and setting one when absent. */
  viewer(c: Context): Viewer {
    const existing = this.unseal(getCookie(c, this.viewerCookie));
    const id = isUserId(existing) ? existing : mintUserId();
    if (id !== existing) {
      setCookie(c, this.viewerCookie, this.seal(id), this.cookieOptions());
    }
    return { id, isOwner: this.isOwnerCookie(getCookie(c, this.ownerCookie), id) };
  }

  /**
   * A fingerprint of the owner token as it is right now. It rides inside the
   * sealed owner cookie, so rotating `ARTIFACT_OWNER_TOKEN` (or clearing it)
   * ends every owner session instead of leaving year-long cookies that the
   * rotation was meant to revoke.
   */
  private ownerFingerprint(): string | null {
    const token = this.config.ownerToken;
    return token ? this.sign(`owner-token:${token}`).slice(0, 22) : null;
  }

  /** Is this sealed owner cookie this viewer's, and minted under this token? */
  isOwnerCookie(sealed: string | undefined, viewerId: string): boolean {
    const value = this.unseal(sealed);
    if (value === null || viewerId === "") return false;
    const cut = value.lastIndexOf(".");
    // No fingerprint at all is a cookie from before the binding existed: it
    // is not evidence of the current token, so it is not the owner.
    if (cut <= 0) return false;
    const expected = this.ownerFingerprint();
    if (expected === null) return false;
    return value.slice(0, cut) === viewerId && secretEquals(value.slice(cut + 1), expected);
  }

  /**
   * The owner cookie's value for this viewer under the current token, or
   * `null` when no owner token is configured (then nobody can be the owner).
   */
  sealOwnerCookie(viewerId: string): string | null {
    const fingerprint = this.ownerFingerprint();
    return fingerprint === null ? null : this.seal(`${viewerId}.${fingerprint}`);
  }

  /** `POST /login` with `ARTIFACT_OWNER_TOKEN` promotes this browser to owner. */
  login(c: Context, token: string): boolean {
    const expected = this.config.ownerToken;
    if (!expected || !secretEquals(token, expected)) return false;
    const viewer = this.viewer(c);
    const sealed = this.sealOwnerCookie(viewer.id);
    if (sealed === null) return false;
    setCookie(c, this.ownerCookie, sealed, this.cookieOptions());
    return true;
  }

  /** The viewer's level on one artifact. */
  levelFor(viewer: Viewer, meta: ArtifactMeta): SharingLevel {
    if (viewer.isOwner || (meta.owner !== null && meta.owner === viewer.id)) return "owner";
    return this.config.defaultLevel;
  }

  /**
   * Who may write the artifact. `interact` is deliberately not enough: it is
   * the level an anonymous visitor gets, and it buys the capability calls
   * (db, sample, ...) but never a publish.
   */
  canEdit(level: SharingLevel): boolean {
    return level === "owner" || level === "admin";
  }

  /** Mint the `__frame_t` asset token that names a viewer on the frame origin. */
  mintAssetToken(viewerId: string, artifactId: string): string {
    const expiresAt = Math.floor(Date.now() / 1000) + this.config.assetTokenTtlSec;
    const nonce = randomBytes(16).toString("base64url").slice(0, 22);
    return this.seal([nonce, viewerId, artifactId, String(expiresAt)].join("."));
  }

  verifyAssetToken(token: string | undefined): AssetTokenClaims | null {
    const value = this.unseal(token);
    if (!value) return null;
    const parts = value.split(".");
    if (parts.length !== 4) return null;
    const [, viewerId, artifactId, exp] = parts as [string, string, string, string];
    const expiresAt = Number.parseInt(exp, 10);
    if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return null;
    if (!isUserId(viewerId)) return null;
    return { viewerId, artifactId, expiresAt };
  }

  /** Admin API guard: the owner cookie, or the owner token as a bearer. */
  isAdminRequest(c: Context): boolean {
    const viewer = this.viewer(c);
    if (viewer.isOwner) return true;
    const expected = this.config.ownerToken;
    const header = c.req.header("authorization") ?? "";
    if (expected && secretEquals(header, `Bearer ${expected}`)) return true;
    // Without a credential the admin API is open only when explicitly opened
    // (`ARTIFACT_OPEN_ADMIN=1`): it creates and publishes artifacts.
    return this.config.openAdminApi;
  }
}

/** Constant-time secret comparison that does not leak the expected length. */
function secretEquals(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export function createAuth(config: ServerConfig): Auth {
  return new Auth(config);
}
