/**
 * Mounts every slice's `server.ts`. Like `src/shell/registry.ts`, this is the
 * one spine file that names the slices; a slice only edits its own directory.
 */
import * as artifact from "../capabilities/artifact/server.ts";
import * as assets from "../capabilities/assets/server.ts";
import * as db from "../capabilities/db/server.ts";
import * as downloads from "../capabilities/downloads/server.ts";
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
  ["network", network],
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
