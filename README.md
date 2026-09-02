# claude-artifact-harness

A compatibility layer for self-hosting Artifacts created by Claude Code and
claude.ai: serve the same HTML on your own infrastructure and provide the
`window.claude` runtime the pages expect.

The layer is the **shell architecture** (`docs/surface-area.md` §12, option
B): each artifact is served in a sandboxed iframe on its own origin behind a
clean-room frame runtime, and the parent shell brokers every capability call
over the same `__frame_*` postMessage protocol claude.ai uses. Nothing here
is Anthropic code — the wire protocol is reimplemented from the analysis in
`docs/`.

## Status

Everything in the v0 roster is implemented and tested end to end: the page
envelope, the handshake, `claude.use()`, the capability RPC, and all ten
capability slices. `npm run build && npm test && npm run e2e` is green.

| Capability | What a page gets |
|---|---|
| `artifact` / `self` | `publish(html)` and `publish(files)` with compare-and-set and live reload. `edit`/`sync` reject `capability_disabled` — live documents are out of scope for v0 |
| `db` | `doc`/`collection` refs, query builders, `onSnapshot` over a websocket lane, per-viewer `data/users/{self}` privacy, declared access rules |
| `sample` | `sample(input, opts)`, `sample.json()`, `sample.limits()` — streaming over SSE, page tools, images, per-artifact consent, a 5-minute reply cache. Also the legacy `window.claude.complete(prompt)` wrapper |
| `user` | `id`, `isOwner`, `canEdit`, `name`, `avatarUrl`, `email`, `me`, `profiles`, `search`. No account service: names are self-service, `email()` resolves `null` |
| `permissions` | `state(name?)` and `request(names?)`; shares the `consent:<artifactId>:<cap>` key with `sample`, so one decision governs both. Must be declared (on claude.ai it is implicit) |
| `downloads` | `save({filename, data, mimeType?})` for strings, `ArrayBuffer` (transferred), views and Blobs, behind a viewer prompt. No backend: the bytes never leave the browser |
| `room` | `emit`/`on`, `presence`/`onPeers`, `connected`/`onConnection` over a websocket lane; one in-memory room per artifact, nothing stored or replayed |
| `assets` | `upload(blob, {type?})`, `list()`, `delete(idOrUrl)`; blobs are served from the artifact's own origin at `/_blob/<id>` and from nobody else's |
| `network` | `origins()`, and the enforcement half: the declared list is validated and becomes the frame origin's CSP `connect-src` |
| `mcp` | `listTools()`, `callTool()` with the result cache and cancellation, `watchTool()` with replay and polling, `invalidate()`; consent per server, shared with `permissions.state("mcp:<server>")`. Connectors are server-wide (`MCP_SERVERS`), reached through the official SDK; `host:` servers reject `server_not_connected` |
| `comments`, `notifications`, `embed` | not in the roster; `use()` resolves `null` |

Each slice's `src/capabilities/<name>/README.md` lists what it implements,
where it deviates from the platform and why, and how to test it.

## Running it

```bash
npm install
npm run build        # tsc --noEmit + esbuild (preamble, runtime modules, shell bundle)
npm run dev          # build, then the server with watch on http://localhost:8787
```

### Publishing a page

```bash
npm run publish -- fixtures/kitchen-sink.html \
  --capabilities '{"artifact":{},"db":{},"sample":{"config":{"images":{},"tools":{}}},
                   "user":{},"permissions":{},"downloads":{},
                   "room":{"config":{"topics":{"reaction":"interact"}}},
                   "assets":{},"network":{"origins":["https://api.example.com"]}}'
```

`npm run publish` prints the artifact id and its shell URL; open that URL.
Add `--id <artifactId>` to publish a new version of an existing artifact,
`--server http://host:port` to target another server, and `--token` (or
`ARTIFACT_OWNER_TOKEN`) when the server has an owner token configured. A
server with neither an owner token nor `ARTIFACT_OPEN_ADMIN=1` refuses the
admin API.

**What a page must declare.** A capability the artifact did not declare
resolves `null` from `use()` — "design for absence" is the contract, and this
harness holds to it, including for `permissions` (see the table above). Both
spellings of a declaration are accepted: `{"db": {}}` and
`{"db": {"config": {…}}}` mean the same thing, and a bare object is read as
the config. `self` is normalised to `artifact`.

For `sample` to answer, the server needs either `ANTHROPIC_API_KEY` or
`SAMPLE_BACKEND=fake` (see the environment table).

### Tests

```bash
npm run build
npm test             # vitest unit tests, per slice
npm run e2e          # Playwright: each fixture through the real shell and server
```

`e2e/kitchen-sink.spec.ts` is the integration spec: one artifact declaring
every capability, asserting each `use()` resolves non-null, that the `db` and
`room` websocket lanes coexist, that `/_blob` and the CSP agree, and that the
legacy `claude.complete()` reaches the sample backend.

Playwright uses the preinstalled Chromium at `/opt/pw-browsers/chromium`
(`playwright.config.ts` falls back to it when the pinned revision is not
installed). Never run `playwright install` in this environment.

## Conformance against the platform's runtime

```
scripts/fetch-runtime.sh <artifact-uuid> <served-artifact.html>   # into reference/runtime (gitignored)
npm run e2e:conformance                                            # RUNTIME_DIR=reference/runtime
```

The second command runs the same specs with claude.ai's own `/_runtime/*.js`
modules and preamble served in place of ours, so the fixtures reach our shell
through Anthropic's code. It passes 38 of 38; the handful of assertions that
describe extras only our runtime provides are gated on `FOREIGN_RUNTIME`
(`e2e/foreign.ts`). See docs/design.md, "Conformance", for what it proved.

## Origins

| What | Where |
|---|---|
| Shell page | `http://localhost:8787/a/<artifactId>` |
| Frame content | `http://<artifactId>.localhost:8788/_f/<ver>/index.html` |
| Runtime modules | `http://<artifactId>.localhost:8788/_runtime/<name>.js` |
| Blobs | `http://<artifactId>.localhost:8788/_blob/<id>` (the `assets` slice) |

Chromium resolves `*.localhost` to loopback, which is what gives each
artifact its own origin. Where wildcard DNS is unavailable, the frame origin
can also accept an `/_a/<artifactId>/…` prefix form for tooling, but it is
off unless `ARTIFACT_PREFIX_HOSTS=1` asks for it: artifacts opened that way
all share one browser origin, which is the isolation the per-artifact host
exists to give them.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `SHELL_PORT` | `8787` | shell origin port |
| `FRAME_PORT` | `8788` | frame origin port |
| `SHELL_HOST` | `localhost` | hostname the shell is reached at |
| `FRAME_HOST_SUFFIX` | `localhost` | suffix after `<artifactId>.` for the frame origin |
| `DATA_DIR` | `./data` | filesystem store root |
| `DIST_DIR` | `./dist` | where the built client bundles are read from |
| `ARTIFACT_SECRET` | random per boot | HMAC secret for the viewer cookie and asset tokens |
| `ARTIFACT_OWNER_TOKEN` | unset | `/login?token=…` promotes a browser to owner; also guards the admin API as `Authorization: Bearer …` |
| `ARTIFACT_OPEN_ADMIN` | unset | `1` serves the admin API (create/publish) to callers with no credential — local dev only |
| `ARTIFACT_PREFIX_HOSTS` | unset | `1` serves the frame origin's `/_a/<artifactId>/…` tooling form on hosts with no artifact label — every artifact reached that way shares one origin |
| `ARTIFACT_DEFAULT_LEVEL` | `interact` | level for other viewers: `view`, `interact` or `admin`. Only `admin` (and the owner) may publish |
| `BIND_HOST` | `127.0.0.1` | address both apps listen on; set to `0.0.0.0` to expose them |
| `ARTIFACT_TOKEN_TTL` | `1800` | asset-token lifetime, seconds |
| `VERSION_POLL_MS` | `5000` | how often an open view polls for a new version (0 disables) |
| `ANTHROPIC_API_KEY` | unset | the key `sample` calls the Anthropic API with. Without it (and without `SAMPLE_BACKEND=fake`) every `sample` call is refused `sampling_disabled` |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | where `sample` sends its requests — point it at a proxy or a gateway |
| `SAMPLE_BACKEND` | unset | `fake` swaps the API for a deterministic in-process stand-in that echoes the prompt, streams in chunks and answers tool rounds. It is what the tests run against; use it for local development with no key |
| `MCP_SERVERS` | unset | the connectors `mcp` can call, as JSON: `[{"name","url","headers"?,"transport"?,"noStore"?}]`. Every viewer shares them; a page addresses them by `name` |
| `MCP_SERVERS_FILE` | unset | the same JSON, read from a file |
| `MCP_BACKEND` | unset | `fake` serves three deterministic in-process connectors (`Fake Tools`, `Needs Auth`, `No Store`) with no upstream at all. It is what the tests run against |

`sample`'s three variables and `mcp`'s three are read from `process.env` by
the slice, not from `ServerConfig`, so they are set the same way in
`npm run dev` and in a test's `beforeAll`.

## HTTP surface

Shell origin:

| Route | Purpose |
|---|---|
| `GET /a/:id` | the shell page (boot record + shell bundle) |
| `GET /_shell/shell.js` | the shell bundle |
| `GET /login?token=…` | owner login |
| `POST /api/artifacts` | create from HTML + capabilities (a declaration a slice cannot run is refused, 400 `invalid_content`) |
| `GET /api/artifacts/:id` | metadata and file list |
| `GET /api/artifacts/:id/version` | the live version (drives live reload) |
| `POST /api/artifacts/:id/publish` | owner publish (compare-and-set) |
| `POST /api/frame/self/:id` | the `artifact` broker's backend (compare-and-set; 409 = `conflict`) |

Slice backends, all on the shell origin behind the viewer cookie:

| Route | Slice |
|---|---|
| `POST /api/frame/db/:id/call`, `POST /api/frame/db/:id/subscribe`, `WS /api/frame/db/ws` | `db` |
| `POST /api/frame/sample/call` (SSE), `POST /api/frame/sample/tool_results` | `sample` |
| `GET /api/account`, `POST /api/frame/user/{profile,profiles/:id,search/:id,email/:id}` | `user` |
| `WS /api/frame/room/ws` | `room` |
| `POST /api/frame/blob/:id/{upload,list,:blobId/delete}` | `assets` |
| `POST /api/frame/mcp/servers`, `POST /api/frame/mcp/call` | `mcp` |

`permissions`, `downloads` and `network` have no backend at all: the first two
are decided in the shell, and `network` is only the CSP the frame origin
serves.

Frame origin: `/_f/<ver>/…`, `/_runtime/<name>.js`, `/_blob/<id>`, all under
the documented CSP with `frame-ancestors` pinned to the shell origin and
`connect-src` carrying the origins `network` declared.

## Layout

```
src/protocol/     wire types, validators, error factory, capability roster, path grammar
src/frame/        the injected preamble (use/handshake/theme/nav/size/RTC) and the RPC client
src/shell/        iframe host, capability broker + registry, consent dialog
src/server/       two Hono apps, filesystem store, auth, page envelope, admin API
src/capabilities/<name>/{frame,broker,server}.ts (+ pure helpers) + README.md
test/<name>/      vitest unit tests per slice
e2e/              Playwright specs
fixtures/         artifact pages exercising each capability
```

A slice owns `src/capabilities/<name>/`, `test/<name>/` and
`fixtures/<name>*.html` and nothing else. The spine names every slice in
`src/shell/registry.ts`, `src/server/routes.ts` and `scripts/build.ts`, so
replacing those files is all a slice does. `fixtures/kitchen-sink.html` and
`e2e/kitchen-sink.spec.ts` belong to no slice: they are the integration
fixture, which declares every capability at once.

Two notes where the implementation reads differently from `docs/design.md`:
the frame's module loader lives in `src/frame/preamble.ts` (the modules are
separate ESM bundles, dynamically imported from `/_runtime/<name>.js`, so
there is nothing for a separate loader to link), and `src/frame/index.ts` is
the compile-time surface a capability module imports.

## Documentation

- `docs/design.md`: the plan this implements.
- `docs/surface-area.md`: what an artifact page can see and call, the
  frame/shell protocol, the page envelope, and what a self-host must provide.
- `docs/analysis/`: detailed reverse-engineering notes per runtime module
  and for the host shell.
- `reference/contract/0.2.32/`: the platform-served `window.claude` type
  definitions the pages are written against.
- `scripts/fetch-runtime.sh`: downloads the proprietary runtime and shell
  bundles into gitignored `reference/runtime` and `reference/shell` for
  local analysis.
