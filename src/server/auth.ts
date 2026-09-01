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
import type { ServerConfig, SharingLevel } from "./config.ts";
import type { ArtifactMeta } from "./store.ts";

export const VIEWER_COOKIE = "av";
export const OWNER_COOKIE = "ao";

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
  constructor(private readonly config: ServerConfig) {}

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
    const existing = this.unseal(getCookie(c, VIEWER_COOKIE));
    const id = isUserId(existing) ? existing : mintUserId();
    if (id !== existing) {
      setCookie(c, VIEWER_COOKIE, this.seal(id), {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        maxAge: 60 * 60 * 24 * 365,
      });
    }
    const owner = this.unseal(getCookie(c, OWNER_COOKIE));
    return { id, isOwner: owner === id };
  }

  /** `/login?token=<ARTIFACT_OWNER_TOKEN>` promotes this browser to owner. */
  login(c: Context, token: string): boolean {
    const expected = this.config.ownerToken;
    if (!expected || !secretEquals(token, expected)) return false;
    const viewer = this.viewer(c);
    setCookie(c, OWNER_COOKIE, this.seal(viewer.id), {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 365,
    });
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
