# Design: self-hosted artifact shell

Goal: run artifacts authored for claude.ai unchanged on our own server, using
the **shell architecture** (option B in `docs/surface-area.md` §12). Each
artifact is served in a sandboxed iframe on its own origin; a clean-room
frame runtime provides `window.claude.use()`; the parent shell brokers every
capability call to our backend over the same `__frame_*` postMessage
protocol claude.ai uses. Matching the wire protocol lets us later run
Anthropic's own runtime modules against our shell as a conformance test.

Read `docs/surface-area.md` first. The wire shapes and error codes there
are the contract; the type definitions in `reference/contract/0.2.32/`
are the page-facing API that must hold exactly.

## Stack

- TypeScript, Node 22, ESM, single package (`package.json` at repo root, no
  workspaces). Dependencies are installed by the spine only: `hono`,
  `@hono/node-server`, `ws`, `@anthropic-ai/sdk`, `esbuild`, `vitest`,
  `@playwright/test`, `typescript`, `tsx`, and `@types/*`. Slices must not add
  dependencies; report a need instead.
- Playwright uses the preinstalled Chromium (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`; never run `playwright install`).
- Scripts: `npm run build` (esbuild: frame preamble IIFE, one ESM module per capability, shell bundle), `npm test` (vitest unit tests), `npm run e2e` (Playwright against a server started by the test), `npm run dev` (server with watch).

## Layout

```
src/
  protocol/          # shared types + constants (spine-owned)
    messages.ts      # __frame_* and __frame_cap envelope types
    errors.ts        # error code unions per capability, error factory
    capabilities.ts  # CAPABILITIES: the fixed list of slice names
    paths.ts         # path grammar helpers (db paths, ids)
  frame/             # runs INSIDE the artifact iframe (clean-room runtime)
    preamble.ts      # window.claude.use, handshake, theme, nav, size, RTC lockdown
    rpc.ts           # shared __frame_cap request/reply client with timeouts and ack
    index.ts         # module loader: imports capabilities/<name>/frame.ts
  shell/             # runs in the parent page (host)
    host.ts          # iframe mount, sandbox/allow, handshake, reveal, theme, nav
    broker.ts        # __frame_cap dispatcher: routes to capabilities/<name>/broker.ts
    consent.ts       # small consent dialog primitive (inert gating)
    index.ts
  server/            # Node backend
    index.ts         # boot: two Hono apps (shell origin, frame origin) + ws upgrade
    store.ts         # filesystem store under data/: artifacts, versions, blobs, db
    auth.ts          # viewer identity cookie (u_<22>), owner token, sharing level
    serve.ts         # /_f/<ver>/..., /_runtime/*.js, /_blob/<id>, shell page
    routes.ts        # mounts capabilities/<name>/server.ts routes
  capabilities/
    <name>/
      frame.ts       # export install(ctx): mounts the namespace (page-facing API)
      broker.ts      # export handle(call, ctx): Promise<result> and push channels
      server.ts      # export routes(app, ctx) and optional ws lanes
      README.md      # what is implemented, what is stubbed, how to test
test/
  <name>/            # vitest unit tests per slice
e2e/                 # Playwright specs
fixtures/            # sample artifact HTML pages exercising each capability
```

Slice names (`src/protocol/capabilities.ts`): `artifact`, `db`, `sample`,
`user`, `permissions`, `downloads`, `room`, `assets`, `network`, `mcp`. Also
`self` as an alias of `artifact`. Out of scope: `comments`,
`notifications`, `embed`, live-doc `edit`/`sync` (the artifact namespace
still exposes `edit` and `sync` and rejects them with `capability_disabled`).

Ownership rule for parallel work: a slice edits only `src/capabilities/<name>/`,
`test/<name>/`, and `fixtures/<name>*.html`. Everything else is spine-owned;
the spine ships a compiling stub for every slice, which the slice replaces.

## Origins and URLs

- Shell origin: `http://localhost:8787` (`SHELL_PORT`). Shell page at `/a/<artifactId>`; APIs under `/api/frame/...` mirroring claude.ai paths where sensible.
- Frame origin: `http://<artifactId>.localhost:8788` (`FRAME_PORT`). Chromium resolves `*.localhost` to loopback. Artifact content at `/_f/<ver>/index.html` (and other files), runtime at `/_runtime/<name>.js`, blobs at `/_blob/<id>`. When the Host header has no subdomain, an `/_a/<artifactId>/...` prefix form is accepted for tooling — opt-in (`ARTIFACT_PREFIX_HOSTS=1`), off by default, because every artifact reached that way shares one browser origin.
- The frame origin serves a CSP header reproducing the documented allowlist (`script-src 'self' 'unsafe-inline' cdnjs.cloudflare.com cdn.jsdelivr.net cdn.tailwindcss.com code.jquery.com; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src fonts.gstatic.com data:; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' <network.origins>; frame-ancestors <shell origin>`).
- Iframe attributes exactly as claude.ai: `sandbox="allow-scripts allow-same-origin allow-forms"`, `allow="fullscreen; clipboard-write; gamepad"`, `referrerpolicy="no-referrer"`, `inert` until ready.

## Page envelope

On publish the server stores the author's HTML as submitted. On serve it
injects, before the author's content: `<!doctype html><html><head>` +
`<script>window.__FRAME_PREAMBLE={...}</script>` + the preamble IIFE +
`<meta charset>` + `<meta viewport>` + the documented reset style, then
`</head><body>` … `</body></html>`. If the author's HTML already starts with
a doctype (a `publish(html)` from a page), inject the preamble as the first
child of `<head>` instead. `<title>` is read from the first 8 KB for metadata.

## Protocol conventions (all sides)

- Frame → shell RPC: `{__frame_cap: true, cap, id, method, args}`; shell → frame `{__frame_cap_r: true, id, result}` or `{…, error: {code, message, …}}`; `{__frame_cap_ack: true, id}` while a call waits on the viewer; `{__frame_cap_p: true, id, p}` for progress. Push channels: `__frame_db_ev`, `__frame_room_ev`.
- Handshake: frame posts `{__frame_connect: true}` to `*`; shell replies `{__frame_init: {contract: "0.2.32", changes: [], flags: [], theme, capabilities: {name: {config}}, capBudgets}}`; frame posts `{__frame_ready: true}`; shell reveals and posts `{__frame_size_poke: true}`. Theme changes: `{__frame_theme: {theme}}`.
- Origin discipline: frame accepts only `source === parent` at the origin that sent `__frame_init` (allowed origins listed in `__FRAME_PREAMBLE.origins`); shell accepts only `source === iframe.contentWindow` at the iframe's origin.
- Default reply timeout 130 s in the frame; ack extends to 900 s.
- Error objects are plain `{code, message}` (never `Error` instances); namespaces are frozen null-prototype objects; every namespace method rejects rather than throws (wrap sync throws).
- Tokens never reach the frame. The shell holds the viewer session; the server authorizes on the session cookie plus per-artifact sharing level.

## Auth and sharing (v0)

- Every visitor gets a `u_` + 22 base62 chars id in a signed cookie on the shell origin. The owner logs in by visiting `/login?token=<ARTIFACT_OWNER_TOKEN>` (env var); the owner is `owner` on every artifact. Other visitors are `admin` when `ARTIFACT_DEFAULT_LEVEL=admin`, else `interact`. The frame origin gets identity via the asset token in the `/_f/` URL (`__frame_t`), a signed short-lived token that names the viewer and artifact, exactly like claude.ai; the server validates it on every frame-origin request that needs identity.
- `user.config` sent to the frame: `{id, owner, canEdit, profile: true, email: false}`.

## Backend storage (v0)

Filesystem under `DATA_DIR` (default `./data`):
`artifacts/<id>/meta.json` (title, favicon, capabilities declaration, current version), `artifacts/<id>/versions/<ver>/index.html` and other files, `artifacts/<id>/db/` (one JSON file per document; an in-memory index rebuilt at boot; a single-process write lock), `artifacts/<id>/blobs/<id>` with a sidecar `.json` for content type. Publishing is compare-and-set on the current version id and returns `{version}` or a 409 that the broker maps to `conflict`.

Admin API on the shell origin for tooling: `POST /api/artifacts` (create from HTML + capabilities), `GET /api/artifacts/<id>`, `POST /api/artifacts/<id>/publish` (owner). A CLI `npm run publish -- <file.html> --capabilities '{"db":{}}'` wraps it.

## Sample proxy

`@anthropic-ai/sdk` with `ANTHROPIC_API_KEY`. Tiers: `quick` → `claude-haiku-4-5-20251001`, `default` → `claude-sonnet-5`, `complex` → `claude-opus-5`. Streaming over SSE to the shell; the shell forwards deltas as `__frame_cap_p {p: {type: "text", text: <delta>}}`; page tools become Anthropic `tools` and each `tool_use` block becomes `__frame_cap_p {p: {type: "tool_use", calls}}` awaiting `toolResults`. Consent: the shell asks once per artifact per viewer (persisted in the shell's localStorage) and sends `__frame_cap_ack` while the dialog is open. Answers are cached shell-side for 5 minutes by `(input, modelTier, images hash, verb)`. Legacy `window.claude.complete(prompt)` is provided by the preamble as a wrapper over `sample`.

## Decisions made while building the spine

- `src/frame/index.ts` is the compile-time surface a capability module imports (`createRpc`, `FrameContext`); the module loader lives in the preamble because runtime modules are separate ESM bundles fetched from `/_runtime/<name>.js`.
- Version identity: the boot record carries the running version; the shell polls `GET /api/artifacts/:id/version` every `VERSION_POLL_MS` (5 s) and reloads other views. A websocket lane may replace the poll later.
- Doctype rule: `publish(html)` from a page must be a full document; the admin API and CLI publish body content that the envelope wraps (`PublishInput.requireDoctype`).
- `artifact_files` flag is set when the viewer can edit.
- The creating viewer is recorded as `meta.owner`, so a dev box without `ARTIFACT_OWNER_TOKEN` still has a real owner per artifact.
- CSP on the frame origin adds `default-src 'none'`, `form-action 'none'`, `base-uri 'self'` beyond the documented allowlist, so nested iframes and blob workers are blocked until proven needed.
- `self` is accepted as a declaration name and normalized to `artifact` before `__frame_init`.
- Security posture: `canEdit` is owner or admin only; the admin API requires the owner cookie, `Authorization: Bearer <ARTIFACT_OWNER_TOKEN>`, or `ARTIFACT_OPEN_ADMIN=1`; both servers bind `127.0.0.1` unless `BIND_HOST` is set. A forged, expired, or wrong-artifact `__frame_t` is a 403; no token is an anonymous viewer. The resolved viewer is exposed to slice routes as the Hono variable `frameViewer`.
- RPC id prefixes are owned by `src/protocol/capabilities.ts` (`CAP_ID_PREFIXES`); `createRpc` derives them from the cap name, and `RpcOptions.onTimeout` lets a slice choose its timeout outcome.
- One `BrokerContext` per mounted view; brokers may export `dispose`.

## Conformance against the platform's own runtime

`npm run e2e:conformance` runs the whole Playwright suite with
`RUNTIME_DIR=reference/runtime`: the server then serves the platform's own
`/_runtime/*.js` modules and inlines the platform's preamble (with
`__FRAME_PREAMBLE.origins` pointed at our shell) instead of our clean-room
runtime, so every fixture page talks to our shell through Anthropic's code.
The files come from `scripts/fetch-runtime.sh <uuid> <served.html>` and are
gitignored.

What the run established (2026-09-02, contract 0.2.32, 38 of 38 specs):

- The wire protocol matches: handshake, `__frame_cap` envelope, ack and
  progress, the db and room push channels, downloads transfer, assets,
  permissions, network, user.
- Fidelity fixes it forced on our side: the shell now sends
  `changes: ["db-path-call-site"]` (the platform's db module validates paths
  at the call site only under that change id); `permissions` validation
  rejects `bad_request`, the platform's code; the `user` palette, hash and
  avatar data URI are now the platform's byte for byte, and `avatarUrl()`
  answers `null` for a profile with no picture (only `me()` and `profiles()`
  fill in the placeholder).
- Guarantees only our runtime makes, gated on `FOREIGN_RUNTIME` in the specs:
  `use("artifact") === use("self")` object identity (the platform freezes one
  copy per name), the legacy `window.claude.complete()` (absent from the
  platform's published-artifact preamble), and an ArrayBuffer handed to
  `downloads.save` being detached synchronously (the platform detaches a
  microtask later; the fixture now checks on the next task).

## Testing bar

- Unit tests per slice with vitest (path grammar, validation, broker mapping, store behaviour).
- One Playwright e2e per slice loading `fixtures/<name>.html` through the real shell and server and asserting the page-facing behaviour (e.g. a db write from one page is seen by a second page's `onSnapshot`).
- `npm run build && npm test && npm run e2e` must pass before a slice reports done.

## Status

As built (integration pass, contract 0.2.32). `npm run build && npm test &&
npm run e2e` is green: 597 unit tests, 38 Playwright specs.

**Implemented.** The spine as designed above — page envelope, handshake,
`claude.use()`, the `__frame_cap` RPC, two origins, filesystem store, auth —
plus every slice in the v0 roster:

| Slice | Backend it needed | Where it lives |
|---|---|---|
| `artifact` / `self` | `POST /api/frame/self/:id` | compare-and-set publish, live reload |
| `db` | `POST /api/frame/db/:id/{call,subscribe}` + `WS /api/frame/db/ws` | documents, queries, snapshots, rules, `{self}` privacy |
| `sample` | `POST /api/frame/sample/{call,tool_results}` | SSE streaming, page tools, images, consent, reply cache |
| `user` | `GET /api/account`, `POST /api/frame/user/*` | viewer identity and the peer directory |
| `permissions` | none | shell-side decisions over the shared consent key |
| `downloads` | none | bytes go frame → shell → object URL |
| `room` | `WS /api/frame/room/ws` | one in-memory room per artifact |
| `assets` | `POST /api/frame/blob/:id/*`, `GET /_blob/:id` | blobs on the artifact's own origin |
| `network` | none | the declaration → the frame origin's CSP `connect-src` |
| `mcp` | `POST /api/frame/mcp/{servers,call}` | server-wide connectors (`MCP_SERVERS`) through the MCP SDK; cache and watches live in the shell |

**Stubbed or out of scope.** `artifact.edit` and `artifact.sync` still reject
`capability_disabled` (live documents). `comments`, `notifications`,
`embed` are not in the roster: `use()` on them resolves `null`. `mcp` is
served, with server-wide connectors in place of the platform's per-viewer
ones (`src/capabilities/mcp/README.md`). `email()`
resolves `null` — there is no account service — though the scope gate is
implemented and tested. The `db` per-viewer rate limit and write-concurrency
budgets are not implemented, so a page cannot observe `resource_exhausted`
from those sources.

**Deviations from this plan, and from the platform.** Each slice's
`README.md` carries the full list with reasons; the ones that change the
shape of the design above:

- **Two spine seams were added during integration.** `ServerContext` gained
  `onShutdown(fn)` (a slice holding an upgraded websocket must drop it before
  `server.close()` can settle — `db` and `room` both did this by
  monkey-patching `close`), and `serve.ts` now builds the frame origin's CSP
  with the `network` slice's `connectSrcOrigins()` validator rather than a
  private string filter, so the policy the browser enforces is the validated
  subset. The `GET /_blob/:blobId` 501 placeholder was removed so the `assets`
  slice's own route can serve the path inside the frame middleware.
- **`permissions` must be declared.** On claude.ai the shell adds
  `permissions: {}` implicitly; here the preamble imports a module only for
  declared names, so an undeclared `permissions` resolves `null`. Synthesising
  it was considered and refused: "design for absence" is the rule everywhere
  else, and the slice's own e2e pins it.
- **Consent is per browser, not per account.** `consent:<artifactId>:<cap>`
  in the shell origin's `localStorage`, shared verbatim by `sample` and
  `permissions`, so one decision governs both.
- **The `db` lane carries rows, not ops**; the broker diffs them, so the
  realtime path and the refresh fallback cannot drift. A page's own write is
  applied to its subscription mirrors before the round trip (the contract's
  latency compensation, `hasPendingWrites: true` until confirmed); an
  `update` against rows this view does not hold is the one case that waits
  for the server instead. Path grammar is
  enforced in the frame unconditionally (`db.d.ts` requires the synchronous
  `TypeError`; no `db-path-call-site` change id exists to gate it on).
- **`sample` reads `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and
  `SAMPLE_BACKEND` from `process.env`**, not from `ServerConfig`, which has no
  sampling knobs. `SAMPLE_BACKEND=fake` is a deterministic in-process backend
  and is what the tests run against.
- **`downloads` acks its prompt** rather than expiring it: `src/shell/consent.ts`
  cannot withdraw an open dialog, and racing a timer would leave a modal over
  an inert frame. The documented `declined`-on-expiry path is therefore not
  reachable.
- **`user.config` is always `{profile: true, email: false}`**, as decided
  above, so a declaration's `scopes` do not reach `__frame_init`; the `email`
  scope gate is exercised from the backend tests instead.
