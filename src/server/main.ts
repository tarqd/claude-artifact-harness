/**
 * `npm run dev` / `npm start` entry point.
 */
import { startServer } from "./index.ts";

const server = await startServer();

console.log(`shell  ${server.shellOrigin}`);
console.log(`frame  ${server.frameOriginFor("<artifactId>")}`);
console.log(`data   ${server.config.dataDir}`);
console.log(`bind   ${server.config.bindHost}`);
if (!server.config.ownerToken && !server.config.openAdminApi) {
  console.log(
    "admin  no ARTIFACT_OWNER_TOKEN and no ARTIFACT_OPEN_ADMIN=1: the admin API is closed",
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
