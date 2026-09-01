# `room` — stub

Not implemented. `frame.ts` mounts nothing (so `claude.use("room")`
resolves `null`), `broker.ts` rejects every call with
`capability_disabled`, and `server.ts` registers no routes.

The room slice replaces these three files and this README. Nothing outside
`src/capabilities/room/`, `test/room/` and `fixtures/room*.html`
needs to change: the shell registry (`src/shell/registry.ts`), the server
route mount (`src/server/routes.ts`) and the build already name this slice.
