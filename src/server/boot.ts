/**
 * Builds the boot record the shell page carries: which capabilities this
 * view is granted, with which config, plus the tokenised frame URL.
 * Tokens live here and in the URL — never in `__frame_init` (shell.md §2).
 */
import { CONTRACT_VERSION, type CapabilityInit } from "../protocol/messages.ts";
import type { ShellBoot, ShellViewer } from "../shell/types.ts";
import type { Auth, Viewer } from "./auth.ts";
import { frameOrigin, type ServerConfig, type SharingLevel } from "./config.ts";
import type { ArtifactMeta } from "./store.ts";

/** Never forwarded to the frame, whatever the declaration says. */
const NEVER_FORWARDED = new Set(["remote_control"]);

function isOptional(config: unknown): boolean {
  return (
    typeof config === "object" &&
    config !== null &&
    (config as { optional?: unknown }).optional === true
  );
}

/**
 * `__frame_init.capabilities`: the declaration, minus what this view cannot
 * have, plus the synthesized configs the platform adds.
 */
export function buildInitCapabilities(
  meta: ArtifactMeta,
  viewer: ShellViewer,
): Record<string, CapabilityInit> {
  const out: Record<string, CapabilityInit> = {};
  for (const [declared, entry] of Object.entries(meta.capabilities)) {
    if (NEVER_FORWARDED.has(declared)) continue;
    // `self` is the legacy spelling of `artifact`; one spelling is
    // authoritative from here on, so the broker's gate has a single key.
    const name = declared === "self" ? "artifact" : declared;
    const config = entry?.config;
    // Optional declarations are dropped, except artifact/self.
    if (isOptional(config) && name !== "artifact" && name !== "self") continue;
    if (name === "user") {
      out[name] = {
        config: {
          id: viewer.id,
          owner: viewer.isOwner,
          canEdit: viewer.canEdit,
          profile: true,
          email: false,
        },
      };
      continue;
    }
    if (name === "permissions") {
      out[name] = { config: {} };
      continue;
    }
    out[name] = { config: config ?? {} };
  }
  return out;
}

export interface BuildBootInput {
  config: ServerConfig;
  auth: Auth;
  meta: ArtifactMeta;
  viewer: Viewer;
  level: SharingLevel;
  shellPort: number;
  framePort: number;
}

export function buildShellBoot(input: BuildBootInput): ShellBoot {
  const { config, auth, meta, viewer, level } = input;
  const canEdit = auth.canEdit(level);
  const shellViewer: ShellViewer = {
    id: viewer.id,
    level,
    canEdit,
    isOwner: level === "owner",
  };
  const origin = frameOrigin(config, meta.id, input.framePort);
  const token = auth.mintAssetToken(viewer.id, meta.id);
  const frameUrl = `${origin}/_f/${meta.currentVersion}/?__frame_t=${encodeURIComponent(token)}`;

  return {
    artifactId: meta.id,
    version: meta.currentVersion,
    title: meta.title,
    frameOrigin: origin,
    frameUrl,
    contract: CONTRACT_VERSION,
    changes: [],
    // `artifact_files` is the only flag the platform emits today; a view that
    // cannot write never gets it.
    flags: canEdit ? ["artifact_files"] : [],
    capabilities: buildInitCapabilities(meta, shellViewer),
    viewer: shellViewer,
    versionPollMs: config.versionPollMs,
  };
}
