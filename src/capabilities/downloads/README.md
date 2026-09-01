# `downloads` — stub

Not implemented. `frame.ts` mounts nothing (so `claude.use("downloads")`
resolves `null`), `broker.ts` rejects every call with
`capability_disabled`, and `server.ts` registers no routes.

The downloads slice replaces these three files and this README. Nothing outside
`src/capabilities/downloads/`, `test/downloads/` and `fixtures/downloads*.html`
needs to change: the shell registry (`src/shell/registry.ts`), the server
route mount (`src/server/routes.ts`) and the build already name this slice.
