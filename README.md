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

The **spine** is done and tested end to end: page envelope, handshake,
`claude.use()`, the capability RPC, and the `artifact` slice (self-publish
with compare-and-set and live reload). Every other capability is a compiling
stub whose `use()` resolves `null`.

| Slice | State |
|---|---|
| `artifact` / `self` | `publish(html)` and `publish(files)` implemented; `edit`/`sync` reject `capability_disabled` (live docs are out of scope for v0) |
| `db`, `sample`, `user`, `permissions`, `downloads`, `room`, `assets`, `network` | stubs — `frame.ts` mounts nothing, `broker.ts` rejects `capability_disabled`, `server.ts` has no routes |
| `mcp`, `comments`, `notifications`, `embed` | not in the v0 roster |

## Running it

```bash
npm install
npm run build        # tsc --noEmit + esbuild (preamble, runtime modules, shell bundle)
npm run dev          # build, then the server with watch on http://localhost:8787
npm run publish -- fixtures/artifact.html --capabilities '{"artifact":{}}'
```

`npm run publish` prints the artifact id and its shell URL; open that URL.
Add `--id <artifactId>` to publish a new version of an existing artifact,
`--server http://host:port` to target another server, and `--token` (or
`ARTIFACT_OWNER_TOKEN`) when the server has an owner token configured. A
server with neither an owner token nor `ARTIFACT_OPEN_ADMIN=1` refuses the
admin API.

Tests:

```bash
npm test             # vitest unit tests
npm run e2e          # Playwright: the fixture through the real shell and server
```

Playwright uses the preinstalled Chromium at `/opt/pw-browsers/chromium`
(`playwright.config.ts` falls back to it when the pinned revision is not
installed). Never run `playwright install` in this environment.

## Origins

| What | Where |
|---|---|
| Shell page | `http://localhost:8787/a/<artifactId>` |
| Frame content | `http://<artifactId>.localhost:8788/_f/<ver>/index.html` |
| Runtime modules | `http://<artifactId>.localhost:8788/_runtime/<name>.js` |
| Blobs | `http://<artifactId>.localhost:8788/_blob/<id>` (501 until the assets slice) |

Chromium resolves `*.localhost` to loopback, which is what gives each
artifact its own origin. Where wildcard DNS is unavailable, the frame origin
also accepts the `/_a/<artifactId>/…` prefix form for tooling.

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
| `ARTIFACT_DEFAULT_LEVEL` | `interact` | level for other viewers: `view`, `interact` or `admin`. Only `admin` (and the owner) may publish |
| `BIND_HOST` | `127.0.0.1` | address both apps listen on; set to `0.0.0.0` to expose them |
| `ARTIFACT_TOKEN_TTL` | `1800` | asset-token lifetime, seconds |
| `VERSION_POLL_MS` | `5000` | how often an open view polls for a new version (0 disables) |
| `ANTHROPIC_API_KEY` | unset | for the `sample` slice, once it lands |

## HTTP surface

Shell origin:

| Route | Purpose |
|---|---|
| `GET /a/:id` | the shell page (boot record + shell bundle) |
| `GET /_shell/shell.js` | the shell bundle |
| `GET /login?token=…` | owner login |
| `POST /api/artifacts` | create from HTML + capabilities |
| `GET /api/artifacts/:id` | metadata and file list |
| `GET /api/artifacts/:id/version` | the live version (drives live reload) |
| `POST /api/artifacts/:id/publish` | owner publish (compare-and-set) |
| `POST /api/frame/self/:id` | the `artifact` broker's backend (compare-and-set; 409 = `conflict`) |

Frame origin: `/_f/<ver>/…`, `/_runtime/<name>.js`, `/_blob/<id>`, all under
the documented CSP with `frame-ancestors` pinned to the shell origin.

## Layout

```
src/protocol/     wire types, validators, error factory, capability roster, path grammar
src/frame/        the injected preamble (use/handshake/theme/nav/size/RTC) and the RPC client
src/shell/        iframe host, capability broker + registry, consent dialog
src/server/       two Hono apps, filesystem store, auth, page envelope, admin API
src/capabilities/<name>/{frame,broker,server}.ts + README.md
test/<name>/      vitest unit tests per slice
e2e/              Playwright specs
fixtures/         artifact pages exercising each capability
```

A slice owns `src/capabilities/<name>/`, `test/<name>/` and
`fixtures/<name>*.html` and nothing else. The spine already names every slice
in `src/shell/registry.ts`, `src/server/routes.ts` and `scripts/build.ts`, so
replacing the three stub files is all a slice does.

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
