/**
 * `user` broker: the four backend-facing verbs the frame module can send.
 *
 *   profile   GET  /api/account?slug=<artifactId>
 *   email     POST /api/frame/user/email/<artifactId>
 *   profiles  POST /api/frame/user/profiles/<artifactId>
 *   search    POST /api/frame/user/search/<artifactId>
 *
 * Identity is the shell's own viewer cookie, carried by `ctx.api` on a
 * same-origin fetch — the frame is never handed a token or a session, and
 * cannot ask about a viewer of another artifact: the artifact id comes from
 * the boot record, never from the call.
 *
 * The frame swallows every error into a benign default, so this layer is
 * free to be strict: a malformed argument is refused rather than guessed at.
 */
import { CAPABILITY_DISABLED } from "../../protocol/errors.ts";
import type { BrokerCall, BrokerContext } from "../../shell/types.ts";
import {
  FRAME_TOKEN_HEADER,
  normalizeIds,
  normalizeQuery,
  readWireProfile,
  type WireProfile,
} from "./identity.ts";

/**
 * The signed asset token minted with the boot record. The backend needs it
 * before it will record the viewer in the artifact's directory, so a cookie
 * alone cannot join a peer list. It travels shell -> backend only; the frame
 * is never handed it (it is already in the iframe's own URL).
 */
function assetToken(ctx: BrokerContext): string | null {
  try {
    return new URL(ctx.boot.frameUrl, "http://shell.invalid").searchParams.get("__frame_t");
  } catch {
    return null;
  }
}

function headers(ctx: BrokerContext, contentType: boolean): Record<string, string> {
  const token = assetToken(ctx);
  return {
    ...(contentType ? { "content-type": "application/json" } : {}),
    ...(token ? { [FRAME_TOKEN_HEADER]: token } : {}),
  };
}

/**
 * An address only ever travels over the scope-gated `email` verb. Whatever an
 * account or directory row claims, this layer strips it, so a page that never
 * declared the email scope cannot receive one through `profile`.
 */
function withoutEmail(wire: WireProfile | null): WireProfile | null {
  return wire === null ? null : { ...wire, email: null };
}

interface AccountResponse {
  account?: unknown;
}
interface EmailResponse {
  email?: unknown;
}
interface ProfilesResponse {
  profiles?: unknown;
}

function post(ctx: BrokerContext, body: unknown): RequestInit {
  return { method: "POST", headers: headers(ctx, true), body: JSON.stringify(body) };
}

export async function handle(call: BrokerCall, ctx: BrokerContext): Promise<unknown> {
  const artifactId = encodeURIComponent(ctx.boot.artifactId);

  switch (call.method) {
    case "profile": {
      // `?slug=` both scopes the answer and records this viewer as a peer of
      // the artifact, which is what makes `profiles`/`search` resolvable.
      const body = await ctx.api<AccountResponse>(`/api/account?slug=${artifactId}`, {
        headers: headers(ctx, false),
      });
      return withoutEmail(readWireProfile(body.account));
    }

    case "email": {
      const body = await ctx.api<EmailResponse>(
        `/api/frame/user/email/${artifactId}`,
        post(ctx, {}),
      );
      return { email: typeof body.email === "string" && body.email ? body.email : null };
    }

    case "profiles": {
      const ids = normalizeIds(call.args[0]);
      if (ids.length === 0) return {};
      const body = await ctx.api<ProfilesResponse>(
        `/api/frame/user/profiles/${artifactId}`,
        post(ctx, { ids }),
      );
      const out: Record<string, WireProfile> = {};
      if (typeof body.profiles === "object" && body.profiles !== null) {
        for (const value of Object.values(body.profiles as Record<string, unknown>)) {
          const profile = withoutEmail(readWireProfile(value));
          // Only ids that were asked for come back out: a backend cannot use
          // one lookup to push a page profiles it never requested.
          if (profile && ids.includes(profile.id)) out[profile.id] = profile;
        }
      }
      return out;
    }

    case "search": {
      const q = normalizeQuery(call.args[0]);
      if (q === "") return [];
      const body = await ctx.api<ProfilesResponse>(
        `/api/frame/user/search/${artifactId}`,
        post(ctx, { q }),
      );
      if (!Array.isArray(body.profiles)) return [];
      const out: WireProfile[] = [];
      for (const value of body.profiles) {
        const profile = withoutEmail(readWireProfile(value));
        if (profile) out.push(profile);
      }
      return out;
    }

    default:
      throw CAPABILITY_DISABLED(`user.${call.method}`);
  }
}
