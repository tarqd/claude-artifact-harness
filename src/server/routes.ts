/**
 * Mounts every slice's `server.ts`, and asks each one whether it can run the
 * config an author declared. Like `src/shell/registry.ts`, this is the one
 * spine file that names the slices; a slice only edits its own directory.
 */
import * as artifact from "../capabilities/artifact/server.ts";
import * as assets from "../capabilities/assets/server.ts";
import * as db from "../capabilities/db/server.ts";
import * as downloads from "../capabilities/downloads/server.ts";
import * as mcp from "../capabilities/mcp/server.ts";
import * as network from "../capabilities/network/server.ts";
import * as permissions from "../capabilities/permissions/server.ts";
import * as room from "../capabilities/room/server.ts";
import * as sample from "../capabilities/sample/server.ts";
import * as user from "../capabilities/user/server.ts";
import type { CapabilityServer, ServerApps, ServerContext } from "./types.ts";

const SLICES: ReadonlyArray<readonly [string, CapabilityServer]> = [
  ["artifact", artifact],
  ["assets", assets],
  ["db", db],
  ["downloads", downloads],
  ["mcp", mcp],
  // `network` mounts nothing: its whole backend is the `connect-src` that
  // `serve.ts` builds from its validator, so the module has no `routes`.
  ["network", network as CapabilityServer],
  ["permissions", permissions],
  ["room", room],
  ["sample", sample],
  ["user", user],
];

export function mountCapabilityRoutes(apps: ServerApps, ctx: ServerContext): void {
  for (const [, slice] of SLICES) {
    slice.routes?.(apps, ctx);
  }
}

/**
 * What is wrong with a capability declaration, asked of each declared slice
 * that cares (`CapabilityServer.validateConfig`). The admin API refuses a
 * create when this is non-empty: a slice that closes itself over a broken
 * config would otherwise do so silently, long after publish.
 */
export function validateCapabilityDeclaration(
  capabilities: Record<string, { config?: unknown }>,
): string[] {
  const problems: string[] = [];
  for (const [name, slice] of SLICES) {
    const entry = capabilities[name];
    if (!entry || !slice.validateConfig) continue;
    for (const message of slice.validateConfig(entry.config)) {
      problems.push(`${name}: ${message}`);
    }
  }
  return problems;
}
