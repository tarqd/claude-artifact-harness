/**
 * The capability registry. This is the only spine file that names every
 * slice: it imports `src/capabilities/<name>/broker.ts` and nothing else, so
 * a slice is implemented entirely inside its own directory.
 */
import type { CapabilityName } from "../protocol/capabilities.ts";
import type { CapabilityBroker } from "./types.ts";

import * as artifact from "../capabilities/artifact/broker.ts";
import * as assets from "../capabilities/assets/broker.ts";
import * as db from "../capabilities/db/broker.ts";
import * as downloads from "../capabilities/downloads/broker.ts";
import * as network from "../capabilities/network/broker.ts";
import * as permissions from "../capabilities/permissions/broker.ts";
import * as room from "../capabilities/room/broker.ts";
import * as sample from "../capabilities/sample/broker.ts";
import * as user from "../capabilities/user/broker.ts";

export const BROKERS: Readonly<Record<CapabilityName, CapabilityBroker>> = Object.freeze({
  artifact,
  assets,
  db,
  downloads,
  network,
  permissions,
  room,
  sample,
  user,
});
