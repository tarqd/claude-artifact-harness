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
7. `__frame_init` fields consumed by the runtime: `theme`, `capabilities` (map of name → `{config?, optional?}`), `contract`, `changes` (feature-change ids, e.g. `db-path-call-site`), `flags`, `capBudgets` (per-capability, per-method reply budgets in ms).

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

See `reference/contract/0.2.32/artifact.d.ts` for the page-facing API. The
wire-level analysis of the 89 KB module is in progress and will be folded in
here: publish (html and files forms), `edit(ops)` on live docs, `sync(fn)`,
and the DOM capture machinery (`artifact-sync`, `artifact-local`,
`data-local-*`, lanes and budgets, `claude:edit` / `claude:sync-off` /
`claude:sync-lost` / `claude:sync-dropped` events).

## 7. `sample` (ask Claude)

See `reference/contract/0.2.32/sample.d.ts`. Wire-level analysis pending:
streaming events, tool rounds executed in-page, image preprocessing, cache
keys.

## 8. `room` (presence and events)

See `reference/contract/0.2.32/room.d.ts`. Wire-level analysis pending.

## 9. `comments` and the comment-mode overlay

Undocumented in the type definitions; analysis of `comments.js`,
`_comments.js` and `_translate.js` pending.

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
- Navigation: cross-origin links are intercepted and forwarded to the shell (`__frame_nav`), which opens them; `<a download>` is blocked (`__frame_blocked`).
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
silently. The `sandbox` and `allow` attributes on the shell's iframe are
covered in the shell analysis (pending).

### 10.2 Shell-side hosts and modes

- Shell page: `https://claude.ai/code/artifact/<uuid>`; iframe slot carries `data-frame-uchost="<uuid>.frame.claudeusercontent.com"` and `data-frame-tophost="<uuid>-top.frame.claudeusercontent.com"`.
- Host flags read from `window.claudeDesktopArtifactPane` or query string: `embedded`, `chrome=none`, `mode=light|dark|system`, `platform=web|desktop`, `font=anthropic|system`, and `hostcaps` from the set `comment-mode artifact-nav comment-summon cloud-session cowork-task viewer-context chrome presence host-tools context-card context-send host-nav`.
- The org id is read from the `org` query parameter or a cookie, and the shell bundles are `frame-shell`, `frame-shell-chrome`, `frame-shell-deferred`, `shared-frame`, `vendor-frame`.

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

Either way, the backend surface to provide is:

| Capability | Backend needed |
|---|---|
| `artifact` | Version store with compare-and-set publish (html or files), live-reload fan-out; optional live-doc edit journal with `data-id` stamping |
| `db` | JSON document store with realtime subscriptions, queries, leases, per-user paths, rules |
| `sample` | LLM proxy (Anthropic Messages API) with streaming, tool rounds, image handling, consent, caching, rate limits |
| `mcp` | MCP client broker with per-viewer connector credentials, caching, watches |
| `room` | WebSocket or similar pub/sub with presence, per-topic ACL |
| `user` / `permissions` | Auth, sharing levels (`view` / `interact` / `admin` / `owner`), consent state |
| `downloads` | Host-side save confirmation UI |
| `assets` | Blob store served at `/_blob/<id>` |
| `notifications` | Message delivery to users |
| `comments` | Thread store anchored to DOM ids, optional Claude hand-off |
| `network` | CSP `connect-src` generation from declared origins |
| `embed` | Static serving of pinned dependency artifacts under `/_dep/<n>/` |
