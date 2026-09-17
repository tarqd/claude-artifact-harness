/**
 * The suites start real servers, and a server serves the preamble, the runtime
 * modules and the shell bundle straight off disk. Build them once per run so
 * `vitest` alone is enough — without this the frame origin answers 500 with a
 * "run `npm run build`" hint and a dozen tests fail on the symptom.
 */
import { buildClients } from "../scripts/build-clients.ts";

export default async function setup(): Promise<void> {
  await buildClients({ logLevel: "silent" });
}
