# Claude Artifact surface area

What a claude.ai Artifact page can see and call, and what the platform wraps
around it. This is the spec a self-hosting layer has to satisfy so that an
artifact authored for claude.ai runs unchanged elsewhere.

Sources, in order of authority:

1. The platform-served type definitions for runtime contract **0.2.32**
   (`reference/contract/0.2.32/*.d.ts`). These are what Claude Code reads when
   it writes artifact code, so pages target exactly this API.
2. The frame runtime the platform injects into every served artifact
   (`<!-- frame-runtime -->` preamble plus the `/_runtime/*.js` capability
   modules on `<uuid>.frame.claudeusercontent.com`). Fetched with
   `scripts/fetch-runtime.sh`; not committed.
3. The shell that embeds the frame (`claude.ai/code/artifact/<uuid>` and its
   `frame-shell-*.js` bundles on `assets-proxy.anthropic.com`).
4. The Artifact tool description in Claude Code (page envelope, CSP, limits).

Snapshot date: 2026-09-01.

---

## 1. Two generations of `window.claude`

| Generation | Where | Shape | Status |
|---|---|---|---|
| Chat artifacts (2025) | Artifacts inside a claude.ai chat | Flat object: `window.claude.complete(prompt: string): Promise<string>` | Still shipped; the contract doc says "neither `use()` nor these namespaces exist there" |
| Published artifacts (contract 0.2.x) | `claude.ai/code/artifact/<uuid>`, Claude Code `Artifact` tool | `window.claude.use(name): Promise<Namespace \| null>` only | Current; what Claude Code emits today |

A compatibility layer must serve both. `complete(prompt)` is trivially a
thin wrapper over `sample`. Everything below is about the `use()` generation.

### 1.1 `claude.use()` semantics (claude.d.ts)

- `window.claude` exists before any page script runs, and carries **only**
  `use`. Capability members (`window.claude.db` etc.) are never promised.
- `use(name)` resolves the frozen namespace, or `null` when the capability is
  not served, not granted, or failed to load. The three null cases are
  deliberately indistinguishable.
- Resolution happens later than the page's first synchronous run and is not
  ordered against `DOMContentLoaded`. If the host never answers, every
  `use()` resolves `null` after 10 s.
- Memoized per served name (same promise object). Unknown names resolve
  `null` without a stable promise identity.
- The namespace is `Object.freeze`d with a null prototype. For a callable
  namespace (`sample`) the function's prototype is replaced by a frozen
  null-prototype object holding only `call`, `apply`, `bind`. Any `then`
  member is stripped so the namespace is never thenable.
- Permission is on the calls, not on `use()`: consent prompts, rate limits,
  and policy refusals arrive as call rejections.

Lifecycle rejection codes shared by every capability (from the runtime, not
the backend): `not_granted`, `capability_disabled`, `capability_removed`,
`transform_error`, and `queue_overflow` on runtimes that queue calls made
before boot.

---

## 2. The capability roster

Two lists matter. The **documented** roster for this account (what the
capabilities skill will let Claude Code declare) and the **served** roster
(what the runtime preamble lists, i.e. what a page could reach on claude.ai).

| Capability | Documented (0.2.32 d.ts) | Served by runtime | Declared via `capabilities:` | Notes |
|---|---|---|---|---|
| `artifact` | yes | yes | `{artifact: {}}` | Self-publish, files publish, live-doc `edit` and `sync` |
| `self` | yes (alias) | yes (same module) | `{self: {}}` | Legacy name for `artifact` |
| `db` | yes | yes | `{db: {rules?}}` | Firestore-style JSON doc store, realtime |
| `downloads` | yes | yes | `{downloads: true}` | Viewer-confirmed file save |
| `mcp` | yes | yes | `{mcp: {servers: [{server, tools}]}}` | Viewer's connectors, `host:` local servers |
| `room` | yes | yes | `{room: {topics?}}` | Ephemeral pub/sub + presence + send-to-Claude |
| `sample` | yes | yes | `{sample: {}}` | Ask Claude, streaming, page tools, images |
| `user` | referenced only | yes | `{user: {scopes?: ["profile"]}}` | id, canEdit, isOwner, profiles, search, email |
| `permissions` | referenced only | yes | implicit | `state()` / `request()` per capability, `mcp:<server>` scoped |
| `comments` | referenced only | yes | ? | Comment threads, `sendToClaude` |
| `assets` | Artifact tool only | yes | `{assets: ...}` | Upload/list/delete blobs, served at `/_blob/<id>` |
| `notifications` | no | yes | ? | `send({type, to, body})` to user ids |
| `network` | no | yes | `{network: {origins}}` | Reports the allowed fetch origins |
| `embed` | no | yes | `{embed: {pins}}` | `<artifact-embed src>` custom element composing other artifacts |

Three more runtime files are not capabilities but shell-driven features:
`_transforms` (call pipeline, nav interception, engagement telemetry, size
reporter), `_comments` (comment-mode overlay UI, installed on `__fc_mode`),
`_translate` (in-page translation, installed on `__ft_cmd`).

---

## 3. Boot handshake between frame and shell

The injected preamble (`<!-- frame-runtime -->`) runs before the page's own
markup. Key behaviour, from the code:

1. `window.__FRAME_PREAMBLE = {v: 1, capabilities: {name: "file.js"}, transforms, comments, translate, origins?, topLevel?}` names the module for every capability the platform knows.
2. Mode detection: `framed` when `window !== top`; `topLevel` when the preamble carries a `topLevel` module name (the `<uuid>-top.frame.claudeusercontent.com` host); `inert` otherwise (a saved copy). Inert and top-level both resolve every `use()` to `null` today.
3. WebRTC lockdown: `RTCPeerConnection`, `RTCDataChannel`, etc. are redefined as `undefined` non-writable. Failure is reported with `__frame_rtc_lockdown_failed`.
4. `window.claude` is defined non-writable, non-configurable. `use` is added as a non-enumerable member. A deferred promise is created per capability listed in the preamble.
5. Frame posts `{__frame_connect: true}` to `*`, then waits up to **10 s** for `{__frame_init: {...}}` from an allowed origin (default `https://claude.ai`, `https://preview.claude.ai`; `host:*` port wildcards supported). No init: every deferred resolves `null`.
6. On init: theme is stamped (`data-theme` + `style.colorScheme` for `light`/`dark`; removed for `system`), capability modules are dynamically imported from `/_runtime/<file>`, `_transforms.buildBoot(init, TRANSFORMS, {shellOrigin, mount, hooks})` builds the boot context, each module's `install(ctx)` runs and calls `ctx.mount(name, namespace)`, which resolves the deferred. Unmounted names resolve `null`. Then after `DOMContentLoaded` the frame posts `{__frame_ready: true}` and installs the size reporter.
7. `__frame_init` as the shell actually sends it (full analysis in `docs/analysis/shell.md`):

   ```jsonc
   {
     "contract": "0.2.32",              // or "0.0.0" when the runtime is disabled
     "changes": ["db-path-call-site", "artifact-sync-reject", ...],
     "flags": ["artifact_files"],       // the only flag today
     "theme": "light" | "dark" | "system",
     "capabilities": { "<name>": { "config": { ... } } },   // never carries tokens
     "capBudgets": { "mcp": {"callTool": 130000, "listTools": 130000}, "sample": {"sample": 330000}, "handlers": {"fetch": 130000} }
   }
   ```
   Capabilities declared `optional: true` are dropped (except `artifact`/`self`); `remote_control` is never forwarded. `user.config` is `{id, owner, canEdit, profile, email}` and is synthesized as `{id: null, owner, canEdit, profile: false, email: false}` for pages that did not declare `user` but whose viewer can edit. `artifact.config` gains `{kind: "live_doc", docs: [{path}]}` for live docs. `permissions` gets `{}` when enabled. Everything else is the declared config verbatim.

8. Reveal state machine on the shell: the iframe is created `inert` and hidden, revealed when both `__frame_ready` and the iframe `load` event have fired (or 2 s after load without ready). A frame may post `__frame_reveal_hold` then `__frame_reveal_ready` (≤ 5 s) and receives `__frame_revealed`. `__frame_load_error {code}` and `__frame_denied` drive reload and credential fallback paths.

Messages the preamble itself handles after init (shell → frame, origin-checked):

| Key | Payload | Effect |
|---|---|---|
| `__frame_theme` | `{theme: "light"\|"dark"\|"system"}` | Restamp theme |
| `__frame_patch` | `{seq, elements: [{target, text?, attrsSet?, attrsRemoved?}]}` | Apply another writer's live-doc edit in place, dispatch `claude:edit`; reply `__frame_patch_miss {seq}` if any target is missing or the change is not in-place-safe |
| `__frame_size_poke` | `{}` | Re-run scroll restore and size report |
| `__fc_mode` | `{on: boolean}` | Lazy-load `_comments` overlay |
| `__ft_cmd` | `{...}` | Lazy-load `_translate` |

Messages the preamble/transforms post (frame → shell):

| Key | Payload |
|---|---|
| `__frame_connect` | `true` |
| `__frame_ready` | `true` |
| `__frame_nav` | `{url, rawHref, newTab}` for cross-origin links and same-document `#` links |
| `__frame_blocked` | `{kind: "download"}` when a same-origin `<a download>` is clicked |
| `__frame_engaged` | `{kind: "scroll"\|"pointer"\|"click"}`, throttled 500 ms |
| `__frame_size` | `{h}` document scroll height, ResizeObserver-driven, 200 ms debounce |
| `__frame_cap_telemetry` | `{kind: "cap-load-error", cap}` and transform failures |
| `__frame_patch_miss` | `{seq}` |
| `__frame_rtc_lockdown_failed` | count |

In-place patchable attributes (used by both `__frame_patch` and live-doc
sync): `data-*`, `aria-*`, and `class hidden value checked style title alt
placeholder lang dir role tabindex disabled readonly contenteditable open
colspan rowspan`. Text patches are refused on `script style iframe noscript
noframes noembed xmp plaintext template title textarea object embed` and on
`html head body frameset`. `value`/`checked` are never patched on
password/hidden/file inputs or autocomplete `cc-*`, `one-time-code`,
`current-password`, `new-password`.

---

## 4. The generic capability RPC envelope

Every capability module speaks the same request/reply protocol to the
shell over `postMessage`, restricted to `e.source === parent && e.origin ===
shellOrigin`:

```jsonc
// frame → shell
{ "__frame_cap": true, "cap": "<name>", "id": "<prefix><n>", "method": "<verb>", "args": [ ... ] }
// shell → frame (terminal)
{ "__frame_cap_r": true, "id": "<same>", "result": <any> }      // success
{ "__frame_cap_r": true, "id": "<same>", "error": { "code", "message", ... } }
// shell → frame (progress; permissions only so far)
{ "__frame_cap_ack": true, "id": "<same>" }                      // a prompt is up, extend the timeout
```

Per-capability id prefixes and defaults:

| cap | id prefix | reply timeout | on timeout | push channel |
|---|---|---|---|---|
| `db` | `b` | 130 s | `unavailable` "no reply from shell" | `__frame_db_ev {ev: {type: "snapshot"\|"error"\|"revoked", subId, ...}}` |
| `mcp` | `c` (+ `w<rand>-<n>` for watches) | `capBudgets.mcp[method]` clamped to 600 s, +2 s, else 130 s | `upstream_error` | `__frame_mcp_watch {watchId, ev}` |
| `permissions` | `p` | 130 s, extended to 900 s after `__frame_cap_ack` | `upstream_error` | — |
| `downloads` | `d` | 150 s | `unavailable` | — |
| `assets` | `e` | 130 s | `upstream_error` | — |
| `notifications` | `n` | 130 s | `upstream_error` | — |
| `user` | `u` | 20 s | resolves `null` (never rejects) | — |
| `artifact`, `sample`, `room`, `comments` | see sections 6 to 9 | | | |

`postMessage` is called with `{targetOrigin, includeUserActivation: true}`
where the browser supports it (mcp, notifications) so the shell can verify a
user gesture for consent prompts and Claude hand-offs.

### 4.1 Transforms pipeline (`_transforms.js`)

`ctx.pipe(cap).wrap(method, fn)` wraps every namespace method. If
`__frame_init.changes` names a transform id that targets `cap.method`, the
transform's `parameters` / `returns` / `throws` functions are applied around
the call. A failing `parameters` transform rejects with
`{code: "transform_error", id, scope, message}`. Today `TRANSFORMS` is empty:
the mechanism exists so the shell can shim older pages against a newer
contract without republishing them. Synchronous throws inside `fn` are
converted to rejections, which is why every documented method "rejects,
never throws".

---

## 5. Small capabilities, fully specified from the modules

### 5.1 `user`

Config arrives in `__frame_init.capabilities.user.config`:
`{id?: string, owner?: boolean, canEdit?: boolean, profile?: boolean, email?: boolean}`.

| Member | Returns | Backend call |
|---|---|---|
| `id()` | `Promise<string \| null>` | none (config) |
| `isOwner()` / `canEdit()` | `Promise<boolean>` | none (config) |
| `name()` | `Promise<string>` (`""` if unknown) | `profile` (only when `profile: true`) |
| `avatarUrl()` | `Promise<string \| null>` | `profile` |
| `email()` | `Promise<string \| null>` | `email` (only when `email: true`) |
| `me()` | `Promise<{id, name, avatarUrl, color, email, isOwner, canEdit}>` | `profile` + `email` |
| `profiles(ids)` | `Promise<Record<id, {id, name, avatarUrl, color, email, isMe}>>` | `profiles([ids])`, cached until tab becomes visible again |
| `search(q)` | `Promise<Profile[]>`, at most 100 chars of query, latest call wins | `search([q])` |

Every method swallows errors into a benign default (`null`, `false`, `""`,
`[]`, unresolved profiles). Unresolved profiles get a deterministic colour
from a hash of the id over six swatches and a data-URI circle avatar. User
ids match `^u_[A-Za-z0-9_]{22}$` (from the notifications validator).

### 5.2 `permissions`

Only mounted with a live broker when at least one capability other than
`permissions`/`user` is declared; otherwise `state()` resolves `{}` or
`"unavailable"` and `request()` resolves every name to `"unavailable"`.

- `state(name?)`: no argument returns the whole map; one name (≤ 512 chars) returns its state.
- `request(names?)`: array of ≤ 32 names. The shell shows a prompt; it sends `__frame_cap_ack` first, then the verdict, with a 15 min budget after the ack.
- States seen in the docs: `"granted"`, `"prompt"`, `"unavailable"`, and denied. Scoped names `mcp:<server>` and `mcp:host:<name>` are valid.

### 5.3 `downloads`

`save({filename, data})` → `{status: "saved"}`. `data` accepts string
(UTF-8 encoded), Blob, ArrayBuffer (transferred), ArrayBufferView (copied).
Wire args: `[{filename, bytes: ArrayBuffer}]` with the buffer in the transfer
list. Allowed extensions (docs): `gif png jpg jpeg webp mp4 webm txt json md`
plus a second, switchable list `docx pptx epub csv ttf html svg pdf`.
Limit 16 MiB. Codes: `rejected_extension`, `extension_not_enabled`,
`too_large`, `declined`, `rate_limited`, `bad_request`, `unavailable`.

### 5.4 `assets`

- `upload(blob, {type?})` → `{id, url: "/_blob/<id>", ...}`. Wire args `[Blob, contentType]`.
- `list()` → `{assets: [...], usage}`; pages through `next` cursors, at most 16 pages.
- `delete(idOrUrl)`; accepts a 32-hex id or `/_blob/<id>`.
- Accepted types: `image/png image/jpeg image/gif image/webp image/svg+xml video/mp4 video/webm application/pdf font/woff2 font/woff font/ttf font/otf text/csv text/markdown application/json text/plain`.
- Limits: 20 MiB per blob, 2 MiB for SVG. Codes: `invalid_request`, `too_large`, `unsupported_type`, `upstream_error`.
- Serving: assets resolve relative to the artifact origin at `/_blob/<id>`; a self-host must serve that path.

### 5.5 `notifications`

`send({type, to, body, key?, fragment?})` → `{accepted: number}`.

- `type` ∈ `comment.mention`, `generic`.
- `to`: 1 to 32 unique user ids (array may hold up to 128 before dedupe).
- `body`: cleaned to visible text (control and format characters stripped, emoji joiners kept), 1 to 300 characters.
- `key`: `^[A-Za-z0-9_.:-]{1,128}$` (dedupe key); `fragment`: `^[A-Za-z0-9._:~-]{1,128}$` (deep link, no `#`).
- Requires user activation (posted with `includeUserActivation`).

### 5.6 `network`

`origins()` → `Promise<string[]>` echoing `capabilities.network.config.origins`
unless the declaration was `optional: true`. This is the page-visible half of
a fetch allowlist; the enforcement is the CSP the frame host serves.

### 5.7 `embed`

Config `{pins: [{uuid, path: "_dep/<n>/", module?: true}]}`. Defines the
`<artifact-embed src="<uuid or artifact URL>">` custom element:

- Resolves `src` to a pinned uuid, fetches `<base>/_dep/<n>/index.html` (same-origin, credentials), takes its `<template shadowrootmode>` declarative shadow root, rewrites relative `src/href/poster/srcset` and CSS `url()` against the dependency base, and mounts it as `<embed-part-<n>>` inside the host element's shadow root, forwarding attributes (except `src id class style slot data-state embed-base` and `on*`) and named/default slots.
- With `module: true`, imports `<base>/_dep/<n>/embed.js` and expects a default-exported `HTMLElement` subclass.
- Sets `data-state` to `loading` / `ready` / `error` / `unresolved` and dispatches a bubbling `claude:embed` event with `{state, uuid?}`.
- `list()` returns the pins.
- The artifact base path is detected from `/_f/<token>/` in the URL, which reveals the frame's own path scheme: `https://<uuid>.frame.claudeusercontent.com/_f/<token>/...`.

### 5.8 `mcp` (wire level; API per mcp.d.ts)

- `callTool(server, tool, input?, options?)` → method `callTool`, args `[server, tool, input, options-without-signal]`. Abort posts `cancelCall [id]` and rejects `cancelled`. Result post-processing: `isError: true` results are converted to a `tool_error` rejection carrying `result`; `payload` is derived from `structuredContent`, else the first text block parsed as JSON, else the raw text.
- `listTools()` → normalizes `authStatus` from upstream values (`authenticated`, `not_required` → `connected`; `auth_required`, `token_invalid`, `refresh_failed`, `managed_auth_failed` → `needs_reauth`; anything else → `unknown`).
- `watchTool(server, tool, input, handler, options)` → method `watchTool`, args `[server, tool, input, {...options, watchId}]`; events arrive as `__frame_mcp_watch {watchId, ev: {type: "data", result, server} | {type: "error", error}}`; unsubscribe posts `unwatchTool [watchId]`; all watches are released on `pagehide`.
- `invalidate(server?, tool?, input?)` → method `invalidate`.

### 5.9 `db` (wire level; API per db.d.ts)

Wire methods and args:

| Method | Args |
|---|---|
| `get` | `[{path}]` → `{id?, exists, data?}` |
| `set` / `update` | `[{path}, body]` |
| `delete` | `[{path}]` |
| `acquire` | `[{path}, {holder, ttlMs?, data?}]` → `{acquired, version?, expiresAt?, holder?}` |
| `query` | `[{collection, where?: [{f, op, v}], orderBy?: {f, dir}, limit?}]` → `{docs: [{id, data}]}` |
| `subscribe` | `[subId, {path} \| queryDesc]`; snapshots pushed as `__frame_db_ev {ev: {type: "snapshot", subId, fromCache, hasPendingWrites, ops: [{type: "added"\|"modified"\|"removed", id, data?, oldIndex, newIndex}]}}` |
| `unsubscribe` | `[subId]` |

The frame keeps a mirror array per subscription and applies `ops` as
index-based splices, producing Firestore-shaped `QuerySnapshot` /
`DocumentSnapshot` objects (frozen, structurally shared when unchanged).
Argument validation before send: plain JSON only, ≤ 40 levels, ≤ 131072
keys/items per container, ≤ 286720 bytes serialized. Path grammar is
enforced client-side only when `changes` contains `db-path-call-site`
(segments `^[A-Za-z0-9_\-.~:@+]+$`, ≤ 200 bytes each, ≤ 1000 bytes and ≤ 16
segments per path, even count for docs, odd for collections). Client-minted
ids are 20 base-36 characters. A `revoked` event kills every subscription.

---

## 6. `artifact` (self-publish and live docs)

Page API per `reference/contract/0.2.32/artifact.d.ts`. Full wire analysis
in `docs/analysis/artifact.md`. The same namespace object is mounted as
`artifact` and `self`, with exactly three members: `publish`, `edit`,
`sync`. Roughly 85 of the module's 89 KB is the live-doc DOM sync engine;
the publish path itself is tiny.

Config and gates:

- `capabilities.artifact.config` (or `self.config`) equal to `{kind: "live_doc"}` switches the page into live-doc mode: `<body>` is adopted as the sync region (`<body artifact-sync="">`), the replica handshake is posted, and `edit`/`sync` work.
- `flags` containing `artifact_files` enables the files form of `publish`; otherwise it rejects `capability_disabled` "publishing files is not available in this view".
- `changes` containing `artifact-sync-reject` makes `edit`/`sync` reject `invalid_content` on a classic page with no `artifact-sync` region.

Wire (cap `artifact`, ids `s<n>`, 130 s timeout):

| Direction | Message |
|---|---|
| → | `method: "publish"`, `args: [html]` (no client-side doctype or size check) or `args: [{path: null \| {content: string \| Blob, contentType}}]` after local validation (≤ 256 paths, bare media type, extension table for inference) |
| → | `method: "edit"`, `args: [ops]`; ops are forwarded untouched. The engine also uses undocumented op forms: `set-text` may carry `base`, and `set-html {target, tag, html}` is used when the pairing `caps` include `"html"` |
| ← | `__frame_cap_r {id, result: {version}}` or `{seq, created}`; errors verbatim (`{code, message, live?}`) |
| → | `__frame_morph_ready {arms: ["move"]}` at load; `__frame_replica_ready` on live docs |
| ← | `__frame_morph {seq, elements[1..64]}` and `__frame_patch {seq, elements}`: co-writer edits applied in place (attrs, text, `create`, `remove`, `move`), then `claude:edit` dispatched; a failed apply posts `__frame_patch_miss {seq, reason?}` |
| ← | `__frame_replica_pair {seq, nodes, caps?}`: the server's node tree (ids `^[^\0]{1,200}:[0-9]{1,18}$`) is paired against the live DOM; reply `__frame_replica_paired {seq, ok, reason?}`. `__frame_replica_pair_subtree {target, node}` re-pairs one subtree and stamps `data-id`s |
| ← | `__frame_replica_patches {seq, patches}`: exact patches (`text` with code-point offsets, `set-attr`, `del-attr`, `remove`, `insert` with optional subtree; `reset`/`value`/`retag` refused) |
| → | `__frame_local_edit {ops: [set-text \| set-html]}`: 60 ms debounced live preview of in-progress typing when `caps` include `"stage"` |
| ← | `__ft_cmd {action: "translate"}` disables sync with reason `translated` |
| ← / → | `__frame_diag_reveal {id}` (scroll and outline an element for 1 s) and `__frame_diag_probe {id}` → `__frame_diag {…stats}` |

Engine behaviour a compatible host must honour (details in the analysis):

- `MutationObserver` on the whole document with attribute and character data old values. Only mutations inside a gesture window (trusted discrete event, pointer held, or inside `sync(fn)`) are captured. Lanes: `discrete` writes go out at once; `default` attribute writes coalesce 1.5 s and are budgeted to 60 per element per minute; no `continuous` or `idle` lane exists yet.
- Batches of at most 32 ops through `edit`, ordered `set-html`, `remove`, `create-element`, `set-attr`/`del-attr`, `set-text`. `EditResult.created` supplies ids for created elements in op order.
- Retry policy: `rate_limited` sleeps 1.5 to 3 s; `conflict` retries up to 3 times; lifecycle codes (`not_writer`, `not_granted`, `not_declared`, `capability_disabled`, `capability_removed`, `consent_required`) disable the engine for the page; `invalid_content` drops the batch and fires `claude:sync-dropped`; anything else keeps the changes with exponential backoff (2 s doubling to 30 s) and fires `claude:sync-lost`.
- Server ids must match `^[A-Za-z0-9_-]{1,64}$` and be unique document-wide.
- Secrets: `value`/`checked` are never journaled for password/hidden/file inputs, `cc-*` / `one-time-code` / password autocompletes, or `:autofill`; secret ids persist in `sessionStorage` under `__artifact_sync_secret_ids`.
- Script-built elements (unstamped descendants in a sync region with no gesture behind them) switch their nearest stamped ancestor off: `artifact-sync-state="off"`, custom state `:state(off)`, bubbling `claude:sync-off {why}`.
- Injected style on arm: `artifact-sync,artifact-local{display:contents}`. Custom elements `artifact-sync` and `artifact-local` are defined with a `saving` getter.

Page-facing events:

| Event | Target | detail |
|---|---|---|
| `claude:edit` | `document` | `{seq, targets: string[]}` |
| `claude:sync-off` | the element (bubbles) | `{why: "script-built" \| "pasted" \| "classic" \| "translated" \| lifecycle code}` |
| `claude:sync-lost` | `document` | `{code, count}` |
| `claude:sync-dropped` | `document` | `{reason: "invalid_content", count, targets}` or `{reason: "script_built" \| "mixed", count, ...}` |

## 7. `sample` (ask Claude)

Page API per `reference/contract/0.2.32/sample.d.ts`. Full wire analysis in
`docs/analysis/sample-room.md`. The namespace is a function with members
`sample`, `json`, `limits`.

Config from `__frame_init.capabilities.sample.config`:
`{images?: {maxCount 4, maxBytes 2e6, maxTotalBytes 5e6, maxEdgePx 1568, patchPx 28, maxPatches 1568, mediaTypes ["image/jpeg","image/png"]}, tools?: {maxCount 16}}`.
Omitting `images` or `tools` makes `limits()` omit them and the matching
calls reject locally with `images_unavailable` / `tools_unavailable`.

Everything the frame does before the wire: input validation (64 KiB, 1000
turns, user-first-and-last), option validation with the documented hints,
image decode and downscale to roughly 1.23 MP via canvas (jpeg/webp/png at
0.85 then 0.7 quality), and tool definition validation (name
`^[A-Za-z0-9_-]{1,128}$`, description ≤ 1 KB, schema ≤ 4 KB and depth ≤ 8,
all definitions ≤ 32 KB). The frame computes no cache keys; caching,
consent, concurrency, and tier substitution are entirely shell-side.

Wire (cap `sample`, ids `a<n>`):

| Direction | Message |
|---|---|
| → | `method: "sample"`, `args: [input, modelTier?, {images?: Blob[], cache?, format?: "json", tools?: [{name, description, inputSchema}]}]` |
| ← | `__frame_cap_ack {id}` while the call is held (consent or queue); extends the timeout from 332 s to 900 s |
| ← | `__frame_cap_p {id, p: {type: "text", text}}` where `text` is a **delta**; frame accumulates and calls `onText({text: whole, delta})` |
| ← | `__frame_cap_p {id, p: {type: "tool_use", calls: [{id, name, input}]}}`; frame runs `execute` for each call concurrently with a 150 s timeout |
| → | `method: "toolResults"`, `args: [callId, [{id, content, isError?}]]` (fresh id; reply ignored; ≤ 32 KB per result) |
| → | `method: "cancelCall"`, `args: [callId]` on abort, timeout, or `pagehide` |
| ← | `__frame_cap_r {id, result: {text, truncated, modelTierApplied, value?}}`; `text` must start with the accumulated deltas or the frame rejects `upstream_error` |
| ← | `__frame_cap_r {id, error: {code, message, text?}}`; the frame appends the partial text unless the code is `refused` |

`json()` uses `result.value` when the shell supplies one, else parses the
text tolerantly (whole reply, one code fence, or first `{`/`[` to last).
The reply budget is `min(capBudgets.sample.sample, 600000) + 2000`; the
shell sends 330 000, so 332 s.

## 8. `room` (presence and events)

Page API per `reference/contract/0.2.32/room.d.ts`. Full analysis in
`docs/analysis/sample-room.md`.

Config `capabilities.room.config.limits`: `maxBytes` 4096, `presenceHz` 30,
`keepaliveMs` 20 000, `silenceMs` 150 000, `maxPeers` 256. The `topics`
ACL is enforced by the shell only.

Wire (cap `room`, ids `r<n>`, 130 s timeout, request/reply):

| Method | Args | Reply |
|---|---|---|
| `hello` | `[]` at install | `{peer, up?}` or `{terminal: {code}}` |
| `presence` | `[wholeObject]`, coalesced to one send per 34 ms, re-sent every 20 s as keepalive and within 500 ms when an unknown peer appears | ignored |
| `emit` | `[topic, data]`; client token bucket 80 burst / 40 per s, over-budget moments are silently dropped | `undefined` or `not_permitted` |
| `sendToClaudeSession` | `[data, {deliver: "stage" \| "send"}]` posted with `includeUserActivation` (undocumented second argument) | `{to}` |
| `canSendToClaudeSession` | `[]` | string, else `"off"` (`"writers_only"` also seen shell-side) |

Push channel `__frame_room_ev {ev}` with `ev.arm`:

| arm | fields | frame effect |
|---|---|---|
| `presence` | `peer, p, by?, isMe?, kind?, sameTab?` | merge; identical content keeps object identity so `updatedAt` holds |
| `event` | `topic, peer, by?, isMe?, sameTab?, kind?, d` | deliver frozen `Message` to `on(topic)` listeners; the sender's own tab must receive its echo with `isMe: true, sameTab: true` |
| `gone` | `peer` | remove peer |
| `conn` | `up` | toggle `connected()`; `up: true` re-posts presence and, if `hello` failed, retries it |
| `revoked` | `code?` | terminal: all listeners get one `onError`, peers collapse to self, `emit`/`presence` reject; the send-to-Claude pair keeps working |

The frame sweeps peers unseen for 150 s every 15 s and batches `onPeers`
deliveries per animation frame. The `ToClaude` validator is strict (4 KiB,
depth 8, 64 keys/entries, identifier keys, format-character rules with emoji
joiner exceptions) and runs entirely in the frame.

## 9. `comments` and the comment-mode overlay

Undocumented in the type definitions. Full analysis in
`docs/analysis/comments-translate.md`.

### 9.1 `comments` capability (page-facing)

Config `capabilities.comments.config`: `{customAnchors?: true, composer_only?: true, headless?: true}`.
RPC ids `k<n>`, 130 s timeout, `__frame_cap_ack` extends to 900 s (a
prompt is up). Members:

| Member | Wire | Notes |
|---|---|---|
| `create(a)`, `reply(a, b)`, `resolve(a, b)`, `delete(a)`, `sendToClaude(a)`, `canSendToClaude()` | same-named method, args passed through | No client-side validation; result shapes come from the shell broker (see analysis §1.9 for the REST layer behind it) |
| `openComposer({element} \| {range})` | `openComposer [{path, x, y, pin, sig?, doc?, rect, span?}]` | `[data-uncommentable]` ancestors resolve `{opened: false}` locally |
| `anchorFor(el)` | local | `{path: cssPath(el), x, y}` normalized 0..1 |
| `customAnchors({mode, threads, reveal, composing?})` | `__fc_ca {on, reg}` plus callbacks driven by `__fc_mode`, `__fc_threads`, `__fc_reveal` | Only with `config.customAnchors`; returns a handle with `compose`, `open`, `placed`, `domAnchor`, `exitMode`, `release`, `areas` |

Anchor model: `path` is a CSS path of at most 10 segments (`#id` ≤ 32
chars or unique `[data-id]` terminate it early; else `tag:nth-of-type(n)`),
`sig` is `{v: 1, tag, h?}` where `h` is a 64-bit simhash of the first
4096 chars of text (4-gram FNV-1a, Hamming ≤ 20 to match), `doc` is a
document-pixel fallback, `span` is `{start, quote}` with a UTF-16 offset and
a quote ≤ 512 bytes, and `pin` is a fraction inside the element's rect.
Thread ids handed to pages are aliases `ca-<n>`, never real ids.

### 9.2 Comment mode overlay (`_comments.js`, lazy on first `__fc_mode`)

It injects **no visible UI**. It changes the cursor, suppresses clicks while
mode is on, hit-tests, and reports viewport rects; the parent draws every
pin, highlight, marquee, composer, and card. Messages:

| Direction | Key | Payload |
|---|---|---|
| ← | `__fc_mode` | `{on, composing?, labels?, regions?, cursor?}` |
| ← | `__fc_locate` | `{paths ≤128, sigs, docs, spans ≤128, labels?, regions?, cursor?}`, polled every 500 ms and on resize |
| → | `__fc_rects` | `{rects: {[path]: rect \| null, ["doc:"+path]?}, spans: {[id]: {mode: "exact" \| "requote" \| "element", rects}}, labels?}` |
| → | `__fc_hover` | `null` or `{rect, kind?, radii? \| caret?}` |
| → | `__fc_click` | `{path, file?, x, y, pin?, sig?, label?, doc, rect, span?, region?, corner?, bg?, blocked?}` |
| → / ← | `__fc_marquee` / `__fc_region` | drag rectangle in progress / a drag finished over the parent chrome |
| ← | `__fc_reveal` | `{path, span?}` scrolls the anchor into view |
| → / ← | `__fc_doc` / `__fc_goto` | `{file}` for multi-file artifacts under `/_f/<token>/` |
| → | `__fc_escape` | `true` |

Persistence behind the broker (from the shell bundle): `GET/POST
/api/frame/comments/{frameUuid}?org=…` with `{text, anchor?, to_claude?,
presence?}`, plus `/{threadId}` (reply), `/resolve {resolved}`, `/delete`,
`/activate {activated}`, `/{threadId}/{commentId}/edit {text}`. Public
readers also get thread data from `/_f/<ver>/index.html.json?__frame_t=<token>`.

`sendToClaude` on the host side is a lazily loaded chunk that imports
`createArtifactSession`, `createCoworkSession`, `fetchArtifactSessions`,
`getArtifactSession`, and `postSessionMessage`: it starts or reuses a Claude
Code cloud session (or a Cowork session) for the artifact and posts a fixed
prompt telling that session to read the threads with the Artifact tool's
`comments` action, act, `reply`, and `resolve`. A self-host that wants this
feature needs an agent runner behind it. The exact result shapes of the
page-facing `create`, `reply`, `resolve`, `delete`, and `sendToClaude` calls
were not recovered from the bundles and remain an inference from the REST
layer.

### 9.3 Translation (`_translate.js`, lazy on first `__ft_cmd`)

- ← `__ft_cmd {action: "probe" \| "translate" \| "revert", target?: BCP-47, engineHost?: boolean}`
- → `__ft_status {state: "idle" \| "translated" \| "translating" \| "downloading" \| "reverted" \| "error", lang?, usable?, progress?, error?}`
- → `__ft_xl {id, texts}` / ← `__ft_xlr {id, texts? \| error?}` when the parent runs the translation engine.

Collects text nodes outside `script style noscript textarea iframe`,
`translate="no"`, and `.notranslate code pre kbd samp var`. Uses the
browser's built-in `LanguageDetector` and `Translator` APIs (Chrome) in the
frame or the parent, replaces `node.data` in place, and rewrites `lang` and
`dir`. Also tells the artifact sync engine to stand down (`translated`).

---

## 10. The page envelope the platform adds

From the Artifact tool description and the served HTML:

- The author writes body content only. The platform prepends
  `<!doctype html><html><head>` + the frame-runtime preamble + `<meta charset>` + `<meta viewport>` + a small reset, then `</head><body>`, and appends `</body></html>`. The reset is:

  ```css
  :root{color-scheme:light}
  body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}
  img{max-width:100%}
  ```
  (`[hidden]{display:none!important}` is also documented.)
- `<title>` is read from the first 8 KB of the author's content.
- Theme: the shell stamps `data-theme="light|dark"` on `<html>` for an explicit choice, nothing for "system". Pages are expected to use `prefers-color-scheme` plus `:root[data-theme=...]` overrides.
- Mermaid: ` ```mermaid ` fences (markdown) and `<pre class="mermaid">` (HTML) render natively per the tool docs. No mermaid code exists in the runtime modules, the shell bundles, or the served envelope of the sample artifact, so rendering is almost certainly done at publish time (server-side transform of the submitted HTML) or injected only when the content contains such a block. A self-host should treat it as a publish-time transform.
- The documented `[hidden]{display:none!important}` reset rule is not present in the envelope served for the artifact inspected (published 2026-08-21); the envelope evidently evolves, so the layer should treat the reset as the documented four rules and not depend on either exact form.
- Size cap: 16 MB rendered page including data URIs.
- Storage: `localStorage`, `sessionStorage`, IndexedDB work, per artifact origin (each artifact has its own `<uuid>.frame.claudeusercontent.com` origin).
- Navigation: cross-origin links are intercepted and forwarded to the shell (`__frame_nav`), which opens them in a new tab — but only for a click the browser attributes to the viewer (`navigator.userActivation.isActive`), only into a frame that is not `inert`, and no more than one every 300 ms; the message alone proves nothing. `<a download>` is blocked (`__frame_blocked`).
- Links back: `/_blob/<id>` (assets), `/_dep/<n>/` (embed pins), `/_runtime/<file>` (runtime), `/_f/<token>/` (frame path).

### 10.1 Content Security Policy

Documented allowlist (CSP-enforced on the frame host):

| Resource | Allowed hosts |
|---|---|
| `script-src` | `https://cdnjs.cloudflare.com`, `https://cdn.jsdelivr.net/npm/`, `https://cdn.tailwindcss.com`, `https://code.jquery.com` (+ self, inline) |
| `style-src` | `https://fonts.googleapis.com` (+ self, inline) |
| `font-src` | `https://fonts.gstatic.com` (+ data:) |
| `img-src`, `media-src` | self and `data:` only |
| `connect-src` | none except what `network.origins` declares; WebSocket blocked; WebRTC removed by the runtime |
| `frame-src` | not documented; `iframe` text patches are refused by the runtime |

Everything else, including a library's own runtime fetches, is blocked
silently. The CSP itself is served as a header by the frame origin and is
not visible in the client bundles; the allowlist above is the documented
one.

The shell's iframe (from the bundle):

```
sandbox="allow-scripts allow-same-origin allow-forms"   (+ allow-popups only when the artifact enables it, on web/desktop)
allow="fullscreen; clipboard-write; gamepad"           (+ "translator; language-detector" when translation is enabled)
referrerpolicy="no-referrer"   allowfullscreen   inert (until ready)
```

No `allow-downloads`, `allow-modals`, or `allow-top-navigation`, which is
why downloads and navigation are relayed through `__frame_blocked` and
`__frame_nav`. The iframe is made `inert` whenever a consent dialog or
other decision surface is open, to prevent clickjacking of consent.

### 10.2 Shell-side hosts and modes

- Shell page: `https://claude.ai/code/artifact/<uuid>`; iframe slot carries `data-frame-uchost="<uuid>.frame.claudeusercontent.com"` and `data-frame-tophost="<uuid>-top.frame.claudeusercontent.com"`.
- Host flags read from `window.claudeDesktopArtifactPane` or query string: `embedded`, `chrome=none`, `mode=light|dark|system`, `platform=web|desktop`, `font=anthropic|system`, and `hostcaps` from the set `comment-mode artifact-nav comment-summon cloud-session cowork-task viewer-context chrome presence host-tools context-card context-send host-nav`.
- The org id is read from the `org` query parameter or the `lastActiveOrg` cookie. Shell bundles: `frame-shell` (boot, mount, handshake), `frame-shell-deferred` (nav, size, websockets, live-doc replica), `frame-shell-broker` (lazily loaded capability brokers), `frame-shell-chrome` (React header, comment mode, translate), `frame-shell-replica`, `shared-frame`, `vendor-frame`.
- Boot: `GET /api/frame/<uuid>?org=&via=&sk=&ver=&vanity=&bk=initial` with headers `X-Frame-CP: go`, `X-Frame-Platform`, `X-Frame-Surface`, `X-Frame-Client-Version`, `X-Frame-Session-Id`. The response carries the version id, an `assetToken` (24-char secret, viewer account uuid, artifact uuid, expiry), `wsToken` and `syncToken` for the two websockets, `consentToken`, the `capabilities` map with per-capability tokens (kept shell-side), the `viewer` record (`account, id "u_…", profile, email, owner, can_edit`), the runtime contract and change list, and a few dozen feature booleans.
- Frame URL: `https://<uuid>.frame.claudeusercontent.com/_f/<ver>/?__frame_t=<assetToken>&__frame_v=<manifest>` (tokenless public views omit `__frame_t`; a token-exchange variant uses `/_t?…&v=<ver>`). The token is renewed every 24 to 29 minutes through a hidden iframe with `__frame_renew=1`.
- Realtime: `wss://claude.ai/api/frame/sync?slug=<uuid>` (subprotocols `frame-sync.v1` and the sync token) carries db rows, room broadcasts and presence, and control notices; `wss://claude.ai/edge-api/frame-live/<uuid>/ws` (subprotocol `frame-live.v1` and the ws token) carries version changes, presence counts, comment and watcher notices.

---

## 11. Author-side tooling that shapes artifact code

- `web-artifacts-builder` skill: React 18 + TypeScript + Vite + Tailwind 3.4 + shadcn/ui, bundled by Parcel and `html-inline` into one `bundle.html`. Such pages carry no `window.claude` dependency unless the author adds it, but they do rely on the CSP (no external CSS, all inlined).
- `artifact-design` skill: dictates theme tokens (`:root`, `prefers-color-scheme` guarded by `:root:not([data-theme="light"])`, `:root[data-theme="dark"]`), Google Fonts links, cdnjs UMD scripts.
- Artifact tool actions that touch the runtime's backends from the author's side: `read_db` / `write_db` (same document store as `db`), `upload_asset` / `list_assets` / `read_asset` / `delete_asset` (same store as `assets`), `comments` / `reply` / `resolve` (same threads as `comments`), `watch` (republish and comment wakes). A self-host layer that wants Claude Code parity needs server APIs for these too.

---

## 12. What a self-hosting layer therefore needs

Two viable architectures, both compatible with pages as written:

**A. Reimplement `window.claude` in-page.** Inject our own preamble that
defines `window.claude.use` and mounts our namespaces directly (no iframe
protocol needed). Simplest for single-origin hosting; loses the isolation
model and the ability to run the untouched claude.ai runtime.

**B. Reimplement the shell.** Serve the artifact in an iframe on its own
origin with a preamble that mirrors the platform's, and implement the
`__frame_*` protocol plus the `__frame_cap` RPC broker in the parent. This
keeps the security model (sandboxed origin, CSP, gesture-verified consent)
and lets us swap backends per capability. Anthropic's runtime modules could
be used only for testing since they are proprietary; ours must be a
clean-room implementation of the same messages.

Either way, the backend surface to provide, with the endpoints claude.ai's
broker calls today for reference (all `POST … ?org=<org>` with JSON bodies
carrying the capability token, except where noted):

| Capability | Backend needed | claude.ai reference endpoints |
|---|---|---|
| `artifact` | Version store with compare-and-set publish (html or files), live-reload fan-out; optional live-doc edit journal with `data-id` stamping | `/api/frame/self/<uuid>` `{token, baseVersion, html \| files}` → `{version}`, 409 = `conflict`; live docs `/api/frame/doc/<uuid>/ops` and `/replica`; `/api/frame/versions/<uuid>` |
| `db` | JSON document store with realtime subscriptions, queries, leases, per-user paths, rules | `/api/frame/db/<uuid>/call` `{token, verb, …}` (`/public-call` for anonymous readers); `/api/frame/db/<uuid>/subscribe` `{token, spec}` → `{grant, spec, expires_in}`; rows over the sync websocket lane `store:db` |
| `sample` | LLM proxy with streaming, tool rounds, image handling, consent, caching, rate limits | `/api/frame/sample/call` `{slug, token, prompt \| messages, modelTier?, images?, format?}` as SSE (`start{modelTierApplied}`, `text{text}`, `tool_use`, `done{truncated}`, `error`); consent `/api/frame/consent/<uuid>` `{consentToken, ops: [{kind, grant \| revoke, seenSeq}]}` |
| `mcp` | MCP client broker with per-viewer connector credentials, caching, watches | `/api/frame/mcp/servers` `{slug, mcpToken}`; `/api/frame/mcp/call` `{slug, server, tool, input, mcpToken, serverId?}`; reauth popup via `/api/organizations/<org>/mcp/start-auth/<server>` |
| `room` | Pub/sub with presence, per-topic ACL | No HTTP; sync websocket broadcasts on `app:<topic>` and presence grants |
| `user` / `permissions` | Auth, sharing levels (`view` / `interact` / `admin` / `owner`), consent state | `/api/account`; `/api/frame/user/email/<uuid>` `{token}`; profiles and search through the chrome's user directory |
| `downloads` | Host-side save confirmation UI | none (shell-side dialog, then a browser download; 5 per minute) |
| `assets` | Blob store served at `/_blob/<id>` | `/api/frame/blob/<uuid>/upload` raw body with `Content-Type` and `X-Frame-Blobs-Token`; `/blob/<uuid>/list` `{after?}`; `/blob/<uuid>/<id>/delete` |
| `notifications` | Message delivery to users | `/api/frame/notifications/send/<uuid>` `{type, to, body, key?, fragment?, token}` → `{accepted}` |
| `comments` | Thread store anchored to DOM paths, optional Claude hand-off | `/api/frame/comments/<uuid>` and `/<threadId>`, `/resolve`, `/delete`, `/activate`, `/<threadId>/<commentId>/edit`; public thread data at `/_f/<ver>/index.html.json?__frame_t=…` |
| `handlers` (undocumented, seen in the broker) | Server-side fetch proxy | `/api/frame/handlers/<uuid>/call` `{token, request}` |
| `network` | CSP `connect-src` generation from declared origins | none |
| `embed` | Static serving of pinned dependency artifacts under `/_dep/<n>/` | none |
| telemetry | optional | `/api/frame/track`, `/api/frame/telemetry`, `/api/frame/page-health/<uuid>`, `/api/frame/access-request/<uuid>` |

The minimum a self-hosted shell must do, in order: give each artifact its
own origin and serve `/_runtime/*.js` beside it; put the shell origin in
`__FRAME_PREAMBLE.origins`; answer `__frame_connect` with `__frame_init`;
reveal on `__frame_ready` plus `load` and post `__frame_size_poke`; forward
`__frame_theme`; relay `__frame_nav` behind the platform's gates (user
activation, un-inert frame, 300 ms interval); answer every `__frame_cap` with a
`__frame_cap_r` (sending `__frame_cap_ack` when a call will wait on the
user); and implement the per-capability push channels (`__frame_db_ev`,
`__frame_room_ev`, `__frame_mcp_watch`, `__frame_cap_p`). Unimplemented
capabilities should simply be left out of `__frame_init.capabilities`, so
`use()` resolves `null` and well-written pages degrade on their own.
