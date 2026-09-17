/**
 * Same reason as `test/global-setup.ts`: the in-process servers read the client
 * bundles off disk, so build them before the first spec runs. Conformance mode
 * (`RUNTIME_DIR=reference/runtime`) swaps the runtime modules out, not the
 * shell bundle, so the build is needed there too.
 */
import { buildClients } from "../scripts/build-clients.ts";

export default async function globalSetup(): Promise<void> {
  await buildClients({ logLevel: "silent" });
}
