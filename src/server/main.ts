/**
 * `npm run dev` / `npm start` entry point.
 */
import { isLoopbackHost, usesTls } from "./config.ts";
import { startServer } from "./index.ts";

const server = await startServer();

console.log(`shell  ${server.shellOrigin}`);
console.log(`frame  ${server.frameOriginFor("<artifactId>")}`);
console.log(`data   ${server.config.dataDir}`);
console.log(`bind   ${server.config.bindHost}`);
if (!isLoopbackHost(server.config.bindHost) && !usesTls(server.config)) {
  console.log(
    "warn   BIND_HOST is not loopback and the public origin is http: the viewer\n" +
      "       and owner cookies, and the owner token itself, would cross the\n" +
      "       network in clear text. Put a TLS terminator in front and set\n" +
      "       PUBLIC_SHELL_URL=https://<host> so cookies are Secure.",
  );
}
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
