# claude.ai Artifact viewer — host ("shell") side protocol

Reverse-engineered from the shell page `https://claude.ai/code/artifact/<uuid>` (build `dc7f52e2`, `build-timestamp 1788218495`) and its bundles. All statements are grounded in the pretty-printed code unless marked **(inference)**.

Sources (pretty-printed):

| File | Role |
|---|---|
| `served.html` | shell HTML: two inline bootstrap scripts, `#frame-slot` with `data-frame-uuid / -uchost / -tophost` |
| `frame-shell-BTPNFq1_.js` | main shell: boot fetch, iframe mount, handshake, theme, telemetry, error pages |
| `frame-shell-deferred-C-ZR4Tel.js` | deferred: nav/size/engagement handlers, host-chrome protocol, sync WS, frame-live WS, live-doc replica/patch, versions, page-health, flags, context-card, access requests |
| `frame-shell-broker-Bvj5PsoN.js` | **capability brokers** (fetched from CDN during this analysis; not in the original set). All `claude.*` capability RPC handlers and their backend calls live here |
| `shared-frame-RTyxa5Z-.js` | shared helpers: RPC envelope schema/reply builders, per-capability config extractors, rate limiters, UI primitives |
| `frame-shell-chrome-DzzMV3mP.js` (raw, not pretty-printed) | header/chrome React UI; sends `__fc_*` comment-mode and `__ft_cmd` translate commands |
| `frame-shell-replica-DJM6AQlN.js` (fetched, not analysed) | live-doc DOM replica engine |
| frame runtime preamble (first `<script>` of the served artifact) and `/_runtime/*.js` capability modules | frame side, used for cross-reference |

---

## 1. Boot sequence

### 1.1 Inline script #1 — `<html>` dataset initialisation

Runs against `document.documentElement.dataset`, `window.claudeDesktopArtifactPane` (desktop app injection) and the query string:

* `embedded`: if `claudeDesktopArtifactPane.embedded` → `data-embedded="" data-host=""`. Otherwise if `parent !== window` and `location.ancestorOrigins[0] === origin && last === origin` (or `document.referrer` origin === own origin when `parent === top`) → `data-embedded=""`. I.e. the shell only treats itself as *embedded* when framed by **claude.ai itself** (chat / cowork / code surfaces).
* `chrome`: when embedded and `?chrome=none` (or desktop pane `chrome:"none"`) → `data-chrome="none"` and viewport gets `viewport-fit=cover`; header is hidden (`--bar:0px`).
* `hostcaps`: when embedded, `?hostcaps=` (space-separated) is filtered to the allowlist
  `comment-mode artifact-nav comment-summon cloud-session cowork-task viewer-context chrome presence host-tools context-card context-send host-nav`, de-duplicated, and stored as `data-hostcaps`.
* `mode` (`?m=light|dark|system`, else `localStorage["LSS-userThemeMode"]` when not embedded), `platform` (`?p=web|desktop`), `font` (`?f=anthropic|system`) → `data-mode`, `data-platform`, `data-font`.

### 1.2 Inline script #2 — boot prefetch

```js
f = "/api/frame/" + uuid + "?" + { org, via, sk?, vanity?, bk: "initial" }
window.__frameBootPrefetch = { url: f, res: fetch(f, {credentials:"same-origin", headers: h, signal: AbortSignal.timeout(20000)}) }
```

* `org` = `?org=` if a UUID, else cookie `lastActiveOrg`. If neither → no prefetch.
* `via` = `?via=` or `"user_open"` when top-level and not embedded, else `"embedded_view"`.
* `sk` = share key `^[A-Za-z0-9_-]{16,64}$`; `vanity` = the slug prefix if the last path segment is `<vanity>-<uuid>` with vanity `^[a-z0-9][a-z0-9-]{0,59}$`.
* Headers (`_e` in the main bundle, reused for every `/api/frame/*` call — "cpHeaders"):
  * `X-Frame-CP: go`
  * `X-Frame-Platform: web|desktop|ios|android|cli` (from `?platform=` or UA sniff: ` Electron/`→desktop, Android, iPad/iPhone/iPod or Mac+touch→ios)
  * `X-Frame-Surface: chat|cowork|code|slack|teams|standalone` (from `?surface=`; `standalone` when top-level)
  * `X-Frame-Client-Version: <meta build-timestamp>`
  * `X-Frame-Session-Id: <crypto.randomUUID()>` (stored as `window.__frameSessionId`)

### 1.3 Main bundle boot (`Aa()` / `Ea()`)

`GET /api/frame/<uuid>?org=&via=&sk=&ver=&vanity=&bk=initial|reboot` (reuses the prefetch when the URL matches; `via` becomes `grant_renew` on token-renewal reboots; `ver` is set when the chrome pins a preview version).

Status handling:

* `403` JSON `{reason:"org_mismatch", owner_org}` → switch `org` (replaceState `?org=`) and re-boot once. `403` with `{request_access: boolean}` → renders the "You don't have access to this artifact" page and `paintRequestAccess` (POST `/api/frame/access-request/<uuid>?org=` with `{sk, access:"write"|"comment"}` → `{status:"pending"|"already_pending"|"already_granted"|"unavailable"}`, 429 = cooldown).
* `401` → error page `401`; if no org, tries `/api/account` (`{memberships:[{uuid, chat}]}`) to pick a fallback org (`pickFallbackOrg`).
* Non-OK → error page with `Retry-After` backoff.

OK response (`o`) — normalised into the boot record `l`:

| Field | Validation / meaning |
|---|---|
| `kind` | `"public"` (anonymous, tokenless) or `"authed"`. Authed **without** `assetToken` = "tokenless reader". |
| `ver` | `^[A-Za-z0-9_-]{1,64}$` — version id, becomes the iframe path |
| `assetToken` | `^[A-Za-z0-9_-]{24}\.<uuid>\.<uuid>\.[0-9]{1,12}(\.(<uuid>|oracle))?$`. Segment `[2]` = viewer **account** uuid (`viewerAccount`), `[3]` = expiry epoch-seconds **(inference from the sync-token parser)**. Passed to the frame origin as `__frame_t`. |
| `title`, `favicon` (emoji), `mode` (`"external"` → externalView), `vanity`, `share_key`, `perm:{role:"owner"|"writer"|...}`, `author`, `owner_agent`, `created_at`, `updated_at`, `last_edit`, `view_count`, `unique_view_count`, `live`, `shared`, `history`, `versions` (owner only), `watchers[]{who,label,surface}`, `starred`, `softDeleted`, `access_requested`, `typeDefault{typeSlug,isOrgDefault,isPinned,canSet,ineligible}`, `read_route`, `route_channel`, `served`, `pending_request_count` | chrome metadata |
| `wsToken` | `^[A-Za-z0-9_.|-]{1,512}$` — frame-live WS credential; `atob(first segment)` = viewer uuid (`viewerUuid`) |
| `syncToken` | `^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){5}$` (≤1024) — frame-sync WS credential; `syncIdleHiddenMs` (60 s … 24 h) |
| `headWsToken`, `headSeq`, `headSync`, `syncClient`, `sessionsOnSync` | live-doc head tracking |
| `artifactKind:"live-doc"`, `docs[]{path, profile:"html/v1", doc?, docSeq?, headSeq?}` (≤64, path ≤1024) | multi-file live documents; if `docs` absent but live-doc, synthesises `[{path:"index.html", profile:"html/v1"}]` |
| `consentToken` (`^[A-Za-z0-9_.|-]{1,512}$`), `consent:{comments:{granted,revoked,decisionSeq}, sample:{…}}` | consent state for comments/sample |
| `capabilities` | map `name → {token?, config?, optional?, grant?, local?}` (see §2/§5) |
| `viewer` | `{account, id, token ("u_…"), profile, email, peers, owner, can_edit}` |
| `runtime:{contract, changes}` or top-level `contract`/`changes` | runtime contract version `^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,5})$` and change flags |
| `appFlags` | object; keys `^appifact_[a-z0-9_]{1,55}$` (≤8) forwarded to the frame via `__frame_flags` |
| feature booleans | `translateEnabled, revealHoldOff, crossfadeSwap, duplicable, duplicateAvailable, duplicateDisabledReason, tokenExchangeEnabled, sandboxAllowPopups, permissionsEnabled, artifactFilesEnabled, editRequestEnabled, commentRequestEnabled, commentsEnabled, editWithClaudeEnabled, topLevelEnabled, presenceEnabled, pageHealthEnabled, avatarUploadEnabled, commentsSidebarEnabled, commentsArtifactLevelEnabled, commentSectionsEnabled, commentRegionsEnabled, commentCursorEnabled, commentsAppendWriterGated, commentsEmpty, cloudSessionComments, cloudCoworkSummonOff, commentWakeOff, summonOpenInClaude, commentsSendAll, commentsPageSummon, autoModeOffered, summonStatusEnabled, summonOwnSessionsOnly, commentPresence, commentsCoachmark, presenceViewEnabled, liveDocAuthoring{retag,split,join}, ownWakeSessions[]` |

For `kind:"public"` / tokenless-authed the shell keeps only a reduced record (`ver,title,favicon,mode,translateEnabled,revealHoldOff,crossfadeSwap,duplicable,vanity,perm` + a tokenless `db` capability if declared).

Room "local" mode: when the shell is embedded with hostcap `context-send`, the record has an `assetToken`, and `room` is absent/optional, the shell injects `capabilities.room = {local:true, config}`.

After a successful boot: `document.title = title`, chrome chunk is loaded (`xa()`), theme observer starts (`wt()`), `afterBoot` in deferred (WS connections, URL canonicalisation to `/<vanity>-<uuid>` or `/<uuid>`, `?sk=` kept in URL for share links, `session_start` track event), and the iframe is (re)mounted if the "identity" (`ver`, tokened, caps signature, translate, exchange, sandboxPopups, permissions, substrate, viewerAccount…) changed.

### 1.4 Iframe construction (`Ri(e)` in the main bundle)

```js
c = document.createElement("iframe")
c.title = "User-generated artifact content"
c.dataset.ver / liveMount / tokened / translate / exchange / sandboxPopups / permissions / readerSelf / substrate / hadBroker
sandbox = "allow-scripts allow-same-origin allow-forms"            // + " allow-popups" when Yi(e)
allow   = "fullscreen; clipboard-write; gamepad"                    // "translator; language-detector; " prefixed when translateEnabled
allowfullscreen = ""
referrerPolicy = "no-referrer"
c.src = kt(ver, assetToken, exchange) + locationHash              // hash only if /^#[A-Za-z0-9._:~-]{1,128}$/
c.inert = true                                                      // until "ready"
```

No `csp` attribute is set on the iframe; the frame's CSP is delivered by `*.frame.claudeusercontent.com` response headers (not visible in these bundles). The shell only listens for `securitypolicyviolation` on its own document and reports `csp-violation:<directive>`.

`allow-popups` (`Yi`) only when `sandboxAllowPopups === true`, an `assetToken` exists, and platform is `web` (or `desktop` with `window.top.claudeDesktopArtifactWindowOpenGate.isActive()`).

**src URL patterns** (`kt`, `Cn` = `data-frame-uchost`, `MANIFEST = "manifest.aecc8e7118d82208.json"`):

| Case | URL |
|---|---|
| tokenless (public / tokenless reader) | `https://<uuid>.frame.claudeusercontent.com/_f/<ver>/?__frame_v=<MANIFEST>` |
| tokened | `https://<uuid>.frame.claudeusercontent.com/_f/<ver>/?__frame_t=<assetToken>&__frame_v=<MANIFEST>` |
| tokened + `tokenExchangeEnabled` | `https://<uuid>.frame.claudeusercontent.com/_t?__frame_t=<assetToken>&v=<ver>&__frame_v=<MANIFEST>` (the frame origin exchanges the token for a cookie and redirects **(inference)**; on `__frame_denied` before load the shell falls back to the `/_f/` form: `exchange-credential-fallback`) |
| grant renewal | same as tokened + `&__frame_renew=1`, loaded in a hidden `sandbox="allow-same-origin"` iframe every 24–29 min (`Pt=1h, Ft=24min, +0..5min jitter`) to refresh the frame-origin credential; `via=grant_renew` reboot fetches a fresh `assetToken` first |

`__frame_v` is a cache-busting manifest id **(inference)**. The frame runtime itself loads capability modules from `/_runtime/<file>` on the frame origin.

`data-frame-tophost` = `<uuid>-top.frame.claudeusercontent.com`. It is used only for `topLevelHref = https://<uuid>-top.frame.claudeusercontent.com/<#hash>` (shown by the chrome as "open full-screen/top-level" when `topLevelEnabled && assetToken && kind!=="public" && !softDeleted && !?sa=0`). The frame preamble has a matching `bootTopLevel` path (`window === top` → `we()` returns a module name or `"inert"`), so the top-host serves the artifact without a shell.

### 1.5 Handshake and reveal state machine

All shell-side handlers require `event.origin === new URL(iframe.src).origin && event.source === iframe.contentWindow`.

1. Frame posts `{__frame_connect:true}` to `"*"` (from `<script>` in `<head>`, before DOM ready).
2. Shell replies `postMessage({__frame_init: oe(boot, theme)}, frameOrigin)` (payload in §2). On a *re*-connect (frame navigated itself) the shell dispatches `frame-content-navigated` and re-inits without reveal.
3. Frame loads capability modules, then posts `{__frame_ready:true}` to the shell origin.
4. Shell reveals when: `__frame_ready` **and** iframe `load` fired (or 2 s "early-reveal" after load if ready never arrives; or, if the frame never connected within 50 ms after `load` and no hold, `kernel-connect-missing` reveal). Reveal (`w()`): removes old iframe (optional 120 ms crossfade when `crossfadeSwap`), sets `id="frame-content"`, `class="ready"`, `inert=false` (unless a decision surface/consent dialog is open), focuses it, posts `{__frame_size_poke:true}`, dispatches `frame-content-swapped {loaded}` and `frame-content-settled`.
5. Optional hold: frame may post `{__frame_reveal_hold:true}` (delay reveal up to 5 s) and `{__frame_reveal_ready:true}`; shell answers `{__frame_revealed:true}` after reveal. Disabled when boot `revealHoldOff`. (Frame-side sender not present in the runtime modules; presumably app/replica code.)
6. Errors: `{__frame_load_error:{code:string}}` → `deadPage`, keeps old iframe if one is ready, otherwise attempts one `location.reload()` (session-storage budgeted `frame_asset_reload`) then shows the error page. `{__frame_denied:true}` → credential fallback (see `_t`) or "denied-kept-old". Timeouts: 8 s → "Still loading…", 60 s → "Large Artifacts can take a few minutes…", +240 s → `iframe-timeout` error page. Mount failures are budgeted per `ver` (5 in 1 h → "mount-budget" page with "Try again").
7. Frame-side: `__frame_init` is only accepted from an origin in `__FRAME_PREAMBLE.origins ?? ["https://claude.ai","https://preview.claude.ai"]` (`"scheme://host:*"` wildcard supported); if none arrives within 10 s the frame boots with no capabilities (`use()` resolves `null`).

DOM events the shell dispatches on `document` for its own modules: `frame-content-mounted {frame}`, `frame-content-swapped {loaded}`, `frame-content-navigated`, `frame-content-settled`.

---

## 2. `__frame_init` payload

Built by `oe(boot, theme)`:

```js
{
  contract:  "<runtime contract>" | "0.0.0",      // from boot.runtime.contract ?? boot.contract
  changes:   [...]                                 // boot.runtime.changes filtered by FRAME_RUNTIME_DISABLE; [] when contract 0.0.0
  flags:     ["artifact_files"?]                   // only flag emitted: when boot.artifactFilesEnabled
  capabilities?: { <name>: { config?: … } },       // see below — NEVER contains tokens
  theme:     "light" | "dark" | "system",          // current shell data-mode
  capBudgets: { mcp:{callTool:130000, listTools:130000}, sample:{sample:330000}, handlers:{fetch:130000} }  // ms, constant
}
```

`capabilities` (`S(boot, contract)`): for each declared capability keep it unless `optional:true` (except `self`/`artifact`, which are kept even when optional so the frame can call `publish` and get a handoff) or it is `remote_control` (never forwarded). Per capability the frame receives **only** `{config}`:

| Cap | `config` forwarded |
|---|---|
| `user` | only if `viewer.account`, `viewer.id` and `capabilities.user.token` exist: `{id, owner, canEdit, profile, email}` (profile/email also require the scope in `capabilities.user.config.scopes`). If `user` is not declared but the viewer has `owner`/`can_edit` booleans and contract ≥ 0.1.14, a synthetic `user:{config:{id:null, owner, canEdit, profile:false, email:false}}` is added ("substrate"). |
| `room` | `{limits:{maxBytes,presenceHz,keepaliveMs,silenceMs,maxPeers}?, topics:{<name /^[a-z][a-z0-9_.-]{0,47}$/>:"interact"|"admin"}?}` |
| `artifact` / `self` | `config` + when `docs` present: `{kind:"live_doc" (if index.html in docs), docs:[{path}]}` |
| `permissions` | added as `{}` when `permissionsEnabled` and contract ≥ `0.1.11` |
| everything else (`db`, `mcp`, `sample`, `assets`, `comments`, `downloads`, `network`, `notifications`, `handlers`, `embed`) | `config` as declared (e.g. `network.config.origins[]`, `mcp.config.servers[{server, tools[]}]`, `sample.config.images{…}`, `comments.config.customAnchors`) |

Not in `__frame_init`: viewer identity beyond the `user.config`, sharing level, version id, origins — those stay in the shell. The frame learns the shell origin from the `MessageEvent.origin` of `__frame_init` and uses it as `targetOrigin` for everything afterwards.

Version pinning: `?ver` is never given to the frame; the version is only in the iframe `src` path.

---

## 3. Message catalogue

### 3.1 Frame → shell (top-level keys)

| Message | Payload | Shell handling |
|---|---|---|
| `__frame_connect: true` | — | reply `__frame_init` |
| `__frame_ready: true` | — | reveal gating |
| `__frame_load_error: {code}` | `code: string` | dead page / reload / error page |
| `__frame_denied: true` | — | token-exchange fallback |
| `__frame_reveal_hold: true` / `__frame_reveal_ready: true` | — | hold reveal ≤5 s |
| `__frame_size: true, h: number` | document scrollHeight (ResizeObserver, 200 ms debounce; also on `beforeprint`) | sets `--frame-print-h: <min(max(h, rect.height), 500000)>px` on `<html>` for print layout only. **The shell never resizes the iframe from it** (iframe is always `100%`). |
| `__frame_nav: true, url, rawHref?, newTab: bool` | cross-origin http(s) link clicks (and same-origin `#hash` links when hosted) | see §4.3 |
| `__frame_engaged: true, kind: "scroll"|"pointer"|"click"` | first trusted interaction per kind (500 ms throttle) | `POST /api/frame/track {event_name:"frame_engaged", slug, mode:kind}` once per kind (tokened views only) |
| `__frame_blocked: true, kind:"download"` | `<a download>` click that the sandbox will block (1 s throttle) | shows notice "File downloads aren't available…" / "…only available to members of its organization" unless the `downloads` cap is granted |
| `__frame_cap: true, cap, id, method, args[], done?, seq?` | capability RPC (§5) | routed to broker |
| `__frame_cap_telemetry: {kind:"cap-load-error", cap}` or `{id, scope, leg:"returns"|"throws"}` | frame could not load a cap module / transform failure | telemetry `cap-load-error:<cap>` / `transform-error:<leg>` |
| `__frame_patch_miss: {seq}` | a `__frame_patch`/`__frame_morph`/`__frame_replica_patches` targeted a missing `data-id` | live-doc engine re-syncs from seq |
| `__frame_rtc_lockdown_failed: n` | frame could not delete `RTCPeerConnection` & co. | (no shell handler found; telemetry only **(inference)**) |
| `__frame_health: true, report:{appKey, alertChannel?, action, outcome, errorType?, replayed?}` | app health beacons | aggregated → `POST /api/frame/page-health/<uuid>?org= {app_key, alert_channel?, events:[{action,outcome,error_type?,n}]}` (only when boot `pageHealthEnabled`) |
| `__frame_flags_ask: true` | ask for app flags | reply `__frame_flags` |
| `__frame_chrome_hello: true` / `__frame_chrome_report: true, snapshot:{v:1, saved?, unresolved?, actions?[{id,disabled?}]}` | app-chrome status for embedding hosts | forwarded to host as `__frame_chrome_state {state:"chrome"}` (requires hostcap `chrome`) and answered with `__frame_chrome_poke` |
| `__frame_morph_ready: true, arms?[]` / `__frame_replica_ready: true` / `__frame_replica_paired: {seq, ok, reason?}` / `__frame_local_edit: {ops:[{op:"set-text", target, text, base?} | {op:"set-html", target, tag, html}]}` (≤64 ops, ≤1 MiB each) | live-doc editing | replica engine (deferred/replica chunk) |
| `__frame_diag: {...}` | reply to `__frame_diag_probe {id}` | diagnostics panel |
| `type:"frame-sync:hello", store:string` | frame asks for a realtime store lane (`^[a-z]{1,16}$`) | store-port relay; answer `type:"frame-sync:unavailable", store, reason` on refusal |
| `type:"frame-context:card", id?, card` | app publishes a "context card" to the host | rate-limited (2/10 s), JSON-walk-limited (256 KiB), relayed to host as `__frame_chrome_state{state:"viewer_context"|"context_card"}`; reply `type:"frame-context:card_result", id, ok, reason?` (`no_gesture`, `not_declared`, `invalid`, `rate_limited`) |
| `__fc_*` (comment mode) and `__ft_*` (translate) | see §4.5 / §4.6 | chrome chunk |

### 3.2 Shell → frame

| Message | Payload |
|---|---|
| `__frame_init` | §2 |
| `__frame_theme: {theme}` | `"light"|"dark"|"system"`; sent whenever `<html data-mode>` changes (MutationObserver) to every mounted iframe |
| `__frame_size_poke: true` | after swap/reveal; frame re-measures and restores scroll (`promoted()`) |
| `__frame_revealed: true` | after reveal when a hold was used |
| `__frame_flags: true, values:{appifact_*}` | `{}` for tokenless views; ≤8 flags |
| `__frame_health_poke: true` | ask the frame to flush health reports |
| `__frame_patch: {seq, elements:[{target, text?, attrsSet?, attrsRemoved?}]}` (≤64) | live-doc incremental patch by `data-id`; attribute names must be `data-*`, `aria-*` or an allowlist (`class hidden value checked style title alt placeholder lang dir role tabindex disabled readonly contenteditable open colspan rowspan`); `value`/`checked` are never patched on password/hidden/file/credential inputs or nodes flagged `__artifactSecret` |
| `__frame_morph: {seq, elements}` / `__frame_replica_pair: {seq, nodes, caps}` / `__frame_replica_pair_subtree: {target, node}` / `__frame_replica_patches: {seq, patches}` | live-doc replica protocol |
| `__frame_chrome_poke: true` / `__frame_chrome_cmd: {cmd:"action", id}` | app-chrome |
| `__frame_diag_probe: {id}` / `__frame_diag_reveal: {id}` | diagnostics |
| `__frame_cap_r`, `__frame_cap_ack`, `__frame_cap_p`, `__frame_db_ev`, `__frame_room_ev`, `__frame_mcp_watch` | RPC replies/streams (§5) |
| `__fc_mode`, `__fc_threads`, `__fc_reveal`, `__fc_goto`, `__fc_locate`, `__fc_region`, `__ft_cmd`, `__ft_xlr` | comment / translate (§4.5, §4.6) |

### 3.3 Shell ↔ embedding host (when the shell is an iframe inside claude.ai)

Sent to `window.parent` (or `parent.opener`) with `targetOrigin = location.origin`:

* `__frame_chrome_state: true, state, uuid, …` with `state`:
  `"chrome"` (`chrome: snapshot`), `"presence"` (`presence:{count, viewers:[{who,purpose,act?,ord?}], sessionsUnknown?}`; hostcap `presence`), `"artifact_nav"` (`uuid` of another artifact; hostcap `artifact-nav`), `"viewer_context"` (`mode:"explicit", card`) + legacy `"context_card"` (`card, legacy:true`; hostcap `context-card`).
* `__frame_host_nav: true, url?, rawHref?, id` → host replies `__frame_host_nav_r: true, id, claimed: bool` within 100 ms (hostcap `host-nav`; used when `chrome=none`).
* Host → shell: `__frame_chrome: true, cmd:"action", id` (trigger an app action) and `__frame_chrome: true, cmd:"host_visible", visible: bool` (pauses sync when hidden).

---

## 4. Theme, size, navigation, scroll, comments, translate, engagement

### 4.1 Theme
Shell theme = `<html data-mode>` (`light|dark`, absent = system). `__frame_init.theme` + `__frame_theme` updates. Frame side (`Q(theme)`): sets `document.documentElement.dataset.theme` and `style.colorScheme` for light/dark, removes both for `system` — matching the artifact authoring guidance (`[data-theme]` + `prefers-color-scheme`).

### 4.2 Size
Frame `installSizeReporter(shellOrigin, {cb})`: ResizeObserver on `<html>`/`<body>`, `load` (capture), `fonts.ready`, `beforeprint`; posts `{__frame_size:true, h}` only when the value changes. Shell only uses it for `--frame-print-h` (print stylesheet: `#frame-content{height:var(--frame-print-h,100vh)}`). No auto-height in the viewer.

### 4.3 Navigation interception
Frame (`wireNav` in `_transforms`, with a pre-boot fallback in the preamble): capture-phase `click`/`auxclick` on `a[href],area[href]`; http(s) links whose origin ≠ frame origin → `preventDefault()` + `__frame_nav {url, rawHref, newTab}` (`newTab` = aux/meta/ctrl/shift/alt or `target` not in `"" _self _top _parent`). Same-origin `#hash` links are reported too (`rawHref` starts with `#`) but not prevented; a fallback rewrites `href` resolved against `location.href` when `<base>` differs.

Shell (`ol()` in deferred): requires `navigator.userActivation.isActive`, not in comment mode, iframe not inert, 300 ms rate limit (`NAV_MIN_INTERVAL_MS`). Then:
* If `url` is another claude.ai artifact URL (`Un()`): same-origin + top-level → navigate in place (`<a rel=noreferrer referrerpolicy=no-referrer>.click()`), embedded with hostcap `artifact-nav` → `__frame_chrome_state{state:"artifact_nav", uuid}`, otherwise open new tab.
* Otherwise: strips credentials from the URL, opens `target=_blank rel="noopener noreferrer"` (new tab) — or, when `chrome=none` + hostcap `host-nav`, first offers it to the host via `__frame_host_nav` and only opens itself if the host does not claim it. Hash-only navs with `newTab:true` are ignored.
* Blocked-download notices (`__frame_blocked`) are throttled to one per 5 s.

### 4.4 Scroll restore
Entirely frame-side (`ke()` in the preamble): `sessionStorage["__frame_scroll"] = {y}` (150 ms debounce), restored at `DOMContentLoaded` (`restore()`) and again on `__frame_size_poke` (`promoted()`), with a resize-based retry for tiny viewports and skipped when `location.hash` is set. The shell contributes only the poke.

### 4.5 Comment mode (`__fc_*`)
Chrome (shell) → frame: `__fc_mode:{on, composing?, labels?, regions?, cursor?}` (also sets `<html data-comment-mode>` on the shell), `__fc_threads:{threads:[…]}`, `__fc_reveal:{id?, path, span?}`, `__fc_goto:{file}`, `__fc_locate:{paths, spans, …}`/`{path,span,sig,doc}`, `__fc_region:{rect…}`.
Frame → shell (from `_comments` runtime module loaded lazily on the first `__fc_mode`): `__fc_click:{path, file?, x, y, …}`, `__fc_hover:{rect, kind:"word"|"element", caret?|radii?}|null`, `__fc_marquee:{rect,corner}|null`, `__fc_rects:{rects, spans, labels?}`, `__fc_doc:{file}`, `__fc_escape:true`, `__fc_ca:{on, reg}` (custom-anchor registry), `__fc_open:{id,x,y}`, `__fc_placed:{placed}`, `__fc_exit:true`. Anchors are CSS paths (`#id` / `[data-id="…"]` / `tag:nth-of-type(n)` chains ≤10) plus text-signature hashes.
Comment data for the sidebar is read from the frame origin: `https://<uchost>/_f/<ver>/index.html.json?__frame_t=<assetToken>` (`commentsDataUrl`).

### 4.6 Translate (`__ft_*`)
Chrome → frame `__ft_cmd:{action:"probe"|…, target:"<BCP47>"}` (translate runtime module loaded on first command). Frame → shell `__ft_status:{state, lang, usable, …}`, and when the in-page `Translator` API is unavailable it delegates text batches: `__ft_xl:{id, texts:[…]}` → shell replies `__ft_xlr:{id, …}`. Requires iframe `allow="translator; language-detector"`.

### 4.7 Engagement / telemetry
* `POST /api/frame/telemetry` (keepalive, cpHeaders) `{events:[{code,detail,t,n}], vitals?:[{name,value,rating,source:"shell"}], exceptions?:[…], buildSha, slug}` — batched 1 s after first event, on `pagehide`/hidden.
* `POST /api/frame/track?org= {event_name, slug, via?, mode?}` for `session_start`, `frame_engaged` (from `__frame_engaged` or shell pointer/click with `via:"chrome"`), `frame_capability_called {via:<method>, mode:<cap>}`, `frame_access_requested`, `translate_completed`, and app-analytics whitelist (`frame_whiteboard_send`, `frame_home_inbox_*`, `frame_home_charter_edited` via cap `analytics.track`).

---

## 5. Capability RPC

### 5.1 Envelope (`shared-frame` schema `mv`)

Frame → shell:
```json
{ "__frame_cap": true, "cap": "<name>", "id": "<string>", "method": "<string>", "args": [ ... ], "done"?: bool, "seq"?: number }
```
Ids are per-module counters (`"b12"`, `"c3"`, `"p1"`, `"d2"`, `"w<rand>-<n>"`) — unique only per cap. `postMessage` options `{targetOrigin, includeUserActivation:true}` are used by `mcp`/`sample` so the shell can read `event.userActivation` (consent prompts need a gesture). `downloads` transfers the `ArrayBuffer`.

Shell → frame:
* reply `{ "__frame_cap_r": true, "id", "result"?: any, "error"?: {code, message, …} }` (`error` non-null ⇒ reject)
* ack `{ "__frame_cap_ack": true, "id" }` — "the call is held" (consent prompt / queue). Frame extends its timeout (permissions: 15 min; sample/comments: 15 min).
* progress `{ "__frame_cap_p": true, "id", "p": {...} }` (sample streaming)
* push events (unsolicited): `{__frame_db_ev:true, ev}`, `{__frame_room_ev:true, ev}`, `{__frame_mcp_watch:true, watchId, ev}`.

Frame default timeout for a reply: 130 s (`capBudgets` may raise mcp/sample). Args are validated as plain JSON ≤ 280 KiB (`B()`), strings ≤ 256 KiB total, arrays ≤ 131072, depth ≤ 40.

Rule: every broker handler checks `t.isConnected && brokerLive() && origin === frameOrigin && source === iframe.contentWindow`, replies with `x(id, body)` and records `noteCapOutcome(cap, method, errorCode, ms)`.

Brokered vs unbrokered: if boot has any capability other than `remote_control` (`_t(l)`), the deferred chunk loads `frame-shell-broker-*.js` and calls `mountBrokered(host, boot, …)`, which installs the listeners and then calls `host.mount(boot)` (= the main bundle `Ri`, which posts `__frame_init`). If the broker chunk fails, the shell mounts anyway and installs a degraded responder (`Ki`/`wc`): `permissions.state` → `"unavailable"`, `self|artifact.*` → `error not_granted` (and `publish(html)` is handed to the chrome as a "reader publish" flow).

### 5.2 Per-capability brokers (all in `frame-shell-broker-Bvj5PsoN.js`)

Common: every backend call is `fetch("/api/frame/…" + (org ? "?org=<org>" : ""), {method:"POST", credentials:"same-origin", headers:{"Content-Type":"application/json", ...cpHeaders}})`. The capability **token** from boot (`capabilities.<cap>.token`) is sent **in the JSON body** (`token`/`mcpToken`), never to the frame. On 401/403 without a structured error the broker triggers a reboot (`requestReboot` → `GET /api/frame/<uuid>`) to obtain a fresh token and retries once. Error codes are normalised to `{code, message}`; common codes: `not_granted`, `capability_disabled`, `capability_removed`, `invalid_argument|invalid_request|bad_request`, `too_large`, `rate_limited|resource_exhausted`, `conflict`, `revoked`, `unavailable`, `upstream_error`, `store_unavailable`, `consent_required|consent_denied`, `session_expired`, `prompt_too_large`, `empty_completion`, `refused`.

| Cap | Methods (`args`) | Backend |
|---|---|---|
| **db** | `get([{path}])`, `set([{path}, data])`, `update([{path}, data])`, `delete([{path}])`, `acquire([{path}, opts])`, `query([{collection, where[{f,op,v}], orderBy{f,dir}, limit}])`, `subscribe([subId, spec])`, `unsubscribe([subId])` | `POST /api/frame/db/<uuid>/call {token?, verb, path?/spec…}` (tokenless public views use `/api/frame/db/<uuid>/public-call`); `POST /api/frame/db/<uuid>/subscribe {token?, spec}` → `{grant, spec, expires_in}` mints a lane grant; realtime rows then flow over the **frame-sync WebSocket** lane `store:db` (`stream`, `seq`, `payload` frames `topology|row|fence`) with an outbox/idempotency layer. Push: `__frame_db_ev {ev:{type:"snapshot", subId, ops[]} | {type:"error", subId, code, message} | {type:"revoked"}}`. Path grammar: segments `^[A-Za-z0-9_\-.~:@+]+$` ≤200 B, ≤15 segments, doc ids `data/users/me` resolves server-side. |
| **room** | `hello()` → `{peer, limits, up, terminal?}`; `presence([obj])`; `emit([topic, data?])` | No HTTP: rides the frame-sync WS: `sendBroadcast("app:<topic>", {d, n})`, presence via `room.grant` (≤4 KiB, from boot `capabilities.room.grant`). Topics `^[a-z][a-z0-9_.-]{0,47}$`, `"admin"` topics need `viewer.can_edit`. Push: `__frame_room_ev {ev:{arm:"conn", up} | {arm:"presence", peer, by?, isMe, sameTab, kind:"viewer"|"agent", p} | {arm:"event", topic, peer, by?, isMe, sameTab, kind, d} | {arm:"gone", peer} | {arm:"revoked", code}}`. `local:true` rooms (embedded + `context-send`) answer `hello` with a synthetic peer and drop emits. Special methods `sendToClaudeSession` / `canSendToClaudeSession` are handled by a "claude" sub-handler (cloud-session / cowork summon). |
| **sample** | `sample([{input:prompt|messages, modelTier?, images?, format?, tools?…}])` streaming; `toolResults([id, results])`; `cancelCall([id])`; `limits()`/`json()` are local | `POST /api/frame/sample/call?org= {slug, token, prompt|messages, modelTier?, images?, format?, …}` with `Accept: text/event-stream`; SSE `data:` JSON events `start{modelTierApplied}`, `text{text}`, `done{truncated}`, `tool_use{…}`, `error{error}`. Progress to frame: `__frame_cap_p {p:{type:"text", text}|{type:"tool_use", calls}}`; final `__frame_cap_r {result:{text, truncated, modelTierApplied}}`. Consent: first call per (org,account,uuid) shows a consent dialog (`__frame_cap_ack` while held), persisted via `POST /api/frame/consent/<uuid> {consentToken, ops:[{kind:"sample"|"comments", grant|revoke:true, seenSeq, disclosure?, provenance?}]}`. Concurrency ≤ N, image uploads limited. |
| **mcp** | `listTools()`, `callTool([server, tool, input, {watchId?, signal…}])`, `invalidate([...])`, `watchTool([server, tool, input, {watchId}])`, `unwatchTool([watchId])`, `cancelCall([id])` | `POST /api/frame/mcp/servers?org= {slug, mcpToken}` (65 s); `POST /api/frame/mcp/call?org= {slug, server, tool, input, mcpToken, serverId?}` (120 s; `X-Frame-Mcp-No-Store: 1` response header disables caching); `authorize` (30 s). OAuth re-auth opens a popup to `/api/organizations/<org>/mcp/start-auth/<server>?redirect_url=<origin>/connector/<server>/auth_done&open_in_browser=1&product_surface=claude-web&popup=1`; adding a directory server: `POST /api/organizations/<org>/mcp/remote_servers {name,url,attestations:[],mcp_directory_server_uuid}`. Per-server consent scope from `capabilities.mcp.config.servers[{server,tools}]` (`__self__` sentinel = self). Push: `__frame_mcp_watch {watchId, ev:{type:"data", result, server}|{type:"error", error}}`. |
| **artifact** / **self** | `publish([html | {path: content|null …}])` (≤256 files, `artifact_files` flag), `edit([ops[], path?])` (≤N ops: `set-text`, `set-html`, attribute ops on `data-id` targets), `sync(...)` | `POST /api/frame/self/<uuid>?org= {token, baseVersion, html|files, …}` → `{version}` (409 → `conflict` + reboot); edits: `POST /api/frame/self/<uuid> {token, idempotencyKey, ops, path?}` and, for live docs, `commitViaReplica` through the replica engine (`/api/frame/doc/<uuid>/ops?…`, `/api/frame/doc/<uuid>/replica?…` in deferred). Readers get `not_granted` and the chrome's "reader publish" handoff. |
| **assets** | `upload([blob, type])`, `list([cursor?])`, `delete([id])` | `POST /api/frame/blob/<uuid>/upload?org=` raw body, headers `Content-Type:<mime>`, `X-Frame-Blobs-Token: <assets.token>`; `POST /api/frame/blob/<uuid>/list {after?}`; `POST /api/frame/blob/<uuid>/<id>/delete {}`. Limits 20 MiB (2 MiB SVG), 16 MIME types, ids `^[0-9a-f]{32}$`. |
| **comments** | `create([{anchor:{path,x,y}, text}])`, `reply([threadId, text])`, `sendToClaude([{anchor|threadId, text}])`, `resolve([threadId, resolved])`, `delete([threadId])`, `openComposer(...)`, `canSendToClaude()`, `anchorFor`, `customAnchors` | `POST /api/frame/comments/<uuid>?org=` (create), `/<threadId>` (reply), `/<threadId>/resolve`, `/<threadId>/delete`; bodies `{text, anchor, token, to_claude?:true, presence?}` / `{text, token}` / `{resolved, token}` / `{token}`. Comment consent via `/api/frame/consent`. |
| **downloads** | `save([{filename, bytes:ArrayBuffer}])` (≤16 MiB, 5 prompts/min) | No HTTP — shows a consent dialog then triggers the browser download from the shell. Refusals reported as `downloads-refused`. |
| **handlers** | `fetch([request])`, `cancelCall([id])` | `POST /api/frame/handlers/<uuid>/call?org=` body `{"token":…, "request":<json>}` (130 s budget). |
| **notifications** | `send([{type:"comment.mention"|"generic", to:["u_…"], body, key?, fragment?}])` | `POST /api/frame/notifications/send/<uuid>?org= {type, to, body, key?, fragment?, token}` → `{accepted:n}`. |
| **user** | local: `id, isOwner, canEdit, me, name, avatarUrl` (from `config`); remote: `profile()`, `email()`, `profiles([ids])`, `search([q])` | `profile` → `/api/account` (must match `viewer.account`); `email` → `POST /api/frame/user/email/<uuid>?org= {token}`; `profiles`/`search` via the chrome's user directory (peers + canEdit + profile scope required). |
| **permissions** | `state([cap?])` → `"granted"|"denied"|"prompt"|"unavailable"` map; `request([caps?])` | local decisions + consent dialogs (`__frame_cap_ack` while prompting). Only `mcp.callTool/watchTool` and `sample` are "decide" caps. |
| **network** | `origins()` local | none (declares allowed fetch origins for the frame CSP **(inference)**). |
| **embed** | `list()` local | none (embedded sub-artifacts `_dep/<n>/`, `/_f/<ver>/…`). |
| **analytics** (undeclared) | `track([event_name])` | `POST /api/frame/track {event_name, slug}` for a fixed whitelist. |
| `remote_control` | never forwarded to the frame | chrome-only |

### 5.3 Realtime transports the brokers depend on

* **frame-sync WS**: `wss://claude.ai/api/frame/sync?slug=<uuid>`, subprotocols `["frame-sync.v1", <syncToken>]`. Client sends `{kind:"join"|"leave"|"ping"|"receipt_ack"(seq)|"ctrl:open"|"ctrl:close"|"store:<name>", slug, stream?, seq?, payload?}`; server sends `ctrl:joined{lane, stores[], sendStores[], door}`, `ctrl:opened`, `ctrl:stream_reset|stream_denied|receipt_ack|send_refused|send_result`, `ctrl:token_refresh{cap}`, `ctrl:token_refresh_declined`, notices `ctrl:invalidate|comment|summon_status|access_request|watchers`, `roster{accountUuids[], total, agents[{accountUuid,busy}]}`, `pong`, and durable frames with `seq` (acked) / ephemeral frames / stream frames (`stream`, `actor`, `payload`). Close 4403 = denied, 4503 = retry later. Store lanes: `POST /api/frame/lane/<store>/<uuid>/subscribe` mints per-store grants (`db`, `journal`, `bongo`).
* **frame-live WS**: `wss://claude.ai/edge-api/frame-live/<uuid>/ws`, subprotocols `["frame-live.v1", <wsToken>]`; text `ping`/`hb`; server JSON `{ver}` (new version → reboot & remount), `{kind:"presence", count, viewers[]}`, `{kind:"comment"}`, `{kind:"watchers"}`, `{kind:"access-request"}`, `{kind:"summon", summon:{thread,status,reason?,sid,seq,covers?}}`.
* `GET /api/frame/versions/<uuid>?org=` → `{versions:{…}}` (owner version picker); `/api/frame/doc/<uuid>/{ops,replica}` (live-doc), `/api/frame/page-health/<uuid>`, `/api/frame/access-request/<uuid>`, `/api/frame/consent/<uuid>`, `/api/frame/track`, `/api/frame/telemetry`, `/api/account`.

---

## 6. Security controls

* **Origin isolation**: artifact content is on `https://<uuid>.frame.claudeusercontent.com` (per-artifact origin); the shell only ever posts to `new URL(iframe.src).origin` and accepts messages whose `origin` and `source` match the current iframe. The frame accepts `__frame_init` only from `__FRAME_PREAMBLE.origins` (default `https://claude.ai`, `https://preview.claude.ai`) and thereafter only from that exact origin and `event.source === parent`.
* **Sandbox**: `allow-scripts allow-same-origin allow-forms` (+ `allow-popups` gated by feature flag, token and platform). No `allow-downloads`, `allow-modals`, `allow-top-navigation`; hence the `__frame_blocked` download notice and `__frame_nav` relay.
* **Permissions policy**: `allow="fullscreen; clipboard-write; gamepad"` (+ `translator; language-detector`); `allowfullscreen`. The shell exits fullscreen whenever a consent/comment/menu surface opens or focus lands on shell UI, and hides its header while the iframe is fullscreen.
* **Referrer**: `referrerpolicy="no-referrer"` on the iframe and `<meta name="referrer" content="no-referrer">` on the shell; outbound links use `noopener noreferrer`.
* **Inert gating**: the iframe is `inert` until revealed and whenever a decision surface (`.consent`, `[data-frame-decision-surface]`, `[data-cds="ConfirmationDialog"]`, rename input, comment composer, share popover) is open — prevents click-jacking of consent prompts by the artifact.
* **Token hygiene**: capability tokens, `assetToken`, `wsToken`, `syncToken`, `consentToken` never enter the frame; `__frame_init` carries `config` only. The frame credential is delivered only through the iframe URL (`__frame_t`) and renewed via the hidden `__frame_renew=1` frame.
* **RTC lockdown**: the frame runtime deletes/defines-undefined `RTCPeerConnection, webkitRTCPeerConnection, RTCDataChannel, RTCIceCandidate, RTCSessionDescription, RTCRtpSender, RTCRtpReceiver` and reports `__frame_rtc_lockdown_failed` if any survive (blocks WebRTC exfiltration).
* **Secret fields**: live-doc patches skip `value/checked` on password/hidden/file inputs, credential autocomplete fields and nodes marked `__artifactSecret`; local edits are budgeted (4 MiB removed-content budget).
* **Rate limits**: nav 300 ms, download notice 5 s, context cards 2/10 s, comment-create/`hello` budgets, downloads 5/min, health beacons 6/min, chrome snapshots 250 ms.
* **Drag/drop**: the shell cancels file drops outside editable fields.
* **Third-party content warning**: `#hdr-degraded` byline "Content is user-generated and unverified." shown when the chrome fails to load.
* **CSP for the frame**: not defined in the shell (served by the frame origin). The shell's own page uses nonces (`nonce="…"` on inline scripts/styles) and a Cloudflare challenge iframe.
* **hostcaps** (what an embedding claude.ai host may enable, all gated on `data-embedded` and mostly on `data-chrome=none`):

| hostcap | Effect in the shell |
|---|---|
| `chrome` | forward app-chrome snapshots/actions (`__frame_chrome_state{state:"chrome"}` ↔ `__frame_chrome cmd:"action"`) |
| `presence` | forward presence roster to the host (`state:"presence"`) |
| `artifact-nav` | in-artifact links to other artifacts become `state:"artifact_nav"` instead of new tabs |
| `host-nav` | external links are first offered to the host (`__frame_host_nav`/`_r`) |
| `context-card` | accept `frame-context:card` from the app and relay (`viewer_context`/`context_card`) |
| `context-send` | enables the synthetic **local room** (`room.local`) so an app can send to the host session |
| `comment-mode`, `comment-summon`, `cloud-session`, `cowork-task`, `viewer-context`, `host-tools` | consumed by the chrome chunk (comment UI, "send to Claude"/summon into a cloud session or Cowork task, viewer-context sharing, host tool list) — not analysed in detail (chrome chunk not pretty-printed) |

---

## 7. What a self-hosted shell must replicate (minimum viable)

1. Serve the artifact from a **separate origin** per artifact (or at least a distinct origin) and create the iframe with the exact `sandbox`/`allow`/`referrerpolicy` above; keep it `inert` until ready.
2. Serve the frame with a runtime preamble whose `__FRAME_PREAMBLE.origins` lists your shell origin (or ship a modified preamble); otherwise `__frame_init` is ignored and the artifact boots capability-less after 10 s.
3. Handshake: on `{__frame_connect:true}` post `{__frame_init:{contract, changes:[], flags:[], theme, capabilities:{<cap>:{config}}, capBudgets:{…}}}` to the frame origin; reveal on `{__frame_ready:true}` (and `load`); post `{__frame_size_poke:true}` after reveal; forward theme changes with `{__frame_theme:{theme}}`.
4. Handle `__frame_nav` (open externally with `noopener noreferrer`), `__frame_blocked` (optional notice), `__frame_size` (optional), `__frame_engaged`/`__frame_cap_telemetry`/`__frame_health`/`__frame_flags_ask` (may be ignored; reply `__frame_flags {values:{}}` if you want the frame to stop asking).
5. Implement the RPC envelope: for every `__frame_cap` reply `__frame_cap_r {id, result|error}`; unknown caps/methods → `error {code:"capability_disabled"|"upstream_error"}`. The frame's `claude.use(name)` resolves per capability listed in `__frame_init.capabilities` **and** present in the preamble's module map; each module is loaded from `/_runtime/<file>` on the frame origin, so those runtime modules must be hosted alongside the artifact.
6. Per capability, honour the exact method/arg shapes and push formats in §5.2 (`db` needs `__frame_db_ev` snapshots for `onSnapshot`; `room` needs `hello` → `{peer, limits, up}` and `__frame_room_ev` arms; `sample` needs SSE-style `__frame_cap_p` progress; `mcp` needs `listTools` result shape `[{server, tools:[…]}]` **(shape inferred from runtime `O()` mapper)**; `permissions.state` should return `"unavailable"` for anything you do not implement; `self.publish` should answer `{version}` or `not_granted`).
7. Keep tokens server-side: the frame never needs them; your shell's backend calls carry them in bodies/headers exactly as the broker does (or in your own scheme).
8. Optional but expected by artifacts written for claude.ai: theme tokens in `data-theme`, `sessionStorage` scroll restore works out of the box (frame-side), fullscreen exit hygiene, and the 130 s reply timeout (send `__frame_cap_ack` if a call will take longer or is waiting on the user).
