/**
 * Command-line build: the three client artefacts, from a clean `dist/`.
 * See `scripts/build-clients.ts` for what is built and why.
 */
import { buildClients } from "./build-clients.ts";

const dist = await buildClients({ clean: true });

console.log(`built ${dist}/frame, ${dist}/runtime, ${dist}/shell`);
