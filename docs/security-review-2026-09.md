# Security review — September 2026

A whole-tree review of the harness at commit `26aae13`, split across six
parallel reviewers by trust boundary: the HTTP server surface, the
shell↔frame transport, the data slices (`db`, `user`, `permissions`), the
outbound slices (`sample`, `mcp`, `network`), the content slices (`assets`,
`downloads`, `room`, `artifact`), and supply chain / configuration. Every
finding marked *reproduced* has a throwaway test or a curl transcript behind
it; nothing below is a pattern match alone. No tracked files were changed
by the review.

The threat model throughout: the artifact page is attacker-controlled
JavaScript; a viewer may be less privileged than the owner; several viewers
share a room; the operator's `ANTHROPIC_API_KEY` and `MCP_SERVERS`
credentials are the assets that matter most.

## Summary

| # | Sev | Finding | Where |
|---|-----|---------|-------|
| 1 | High | db on-disk filename encoding collides, so any `interact` viewer can overwrite or delete another viewer's private document on disk | `protocol/paths.ts:55` |
| 2 | High | `sample` call route has no same-origin guard: any site or bare client drives completions on the operator's key, no consent | `sample/server.ts:602` |
| 3 | Medium | Shell-origin POST routes trust any `Host`, any `Content-Type`, and no `Origin`; DNS rebinding and same-site CSRF | `server/index.ts:93`, `db/server.ts:268`, `user/server.ts:181` |
| 4 | Medium | One malformed db rule silently discards the whole declaration and falls back to the permissive defaults | `db/rules.ts:116` |
| 5 | Medium | `permissions.request()` needs no user gesture and the dialog pre-focuses Allow (keyboard-timing grant) | `permissions/broker.ts:192`, `shell/consent.ts:81` |
| 6 | Medium | `__frame_nav` relayed to `window.open` with no activation, inert, or rate gate | `shell/host.ts:192` |
| 7 | Medium | No server-wide cap on concurrent `sample` streams; per-viewer cap keys on a cookie minted per request | `sample/server.ts:51` |
| 8 | Medium | Anonymous `interact` viewers reach MCP connectors with the operator's credentials by default | `mcp/server.ts:314`, `config.ts:75` |
| 9 | Medium | No TLS story: hardcoded `http://` origins, cookies without `Secure`, owner token in a GET URL | `config.ts:85`, `auth.ts:58`, `serve.ts:256` |
| 10 | Low | Open redirect in `/login?next=` | `serve.ts:259` |
| 11 | Low | Writer-chosen `contentType` (`TEXT/HTML`, `application/xhtml+xml`) skips the page envelope and RTC lockdown | `serve.ts:376`, `store.ts:244` |
| 12 | Low | `publish` compare-and-set is skipped when `baseVersion` is omitted | `artifact/server.ts:65`, `admin.ts:99` |
| 13 | Low | db store mutates the in-memory index before persisting; a failed write leaves a phantom doc | `db/store.ts:378` |
| 14 | Low | Download filename sanitiser leaves bidi and zero-width characters in the name the viewer confirms | `downloads/broker.ts:108` |
| 15 | Low | Room: no per-viewer or per-room socket cap | `room/server.ts:212` |
| 16 | Low | JSON routes buffer the whole body before any size check (db, user, sample, admin) | `sample/server.ts:581`, `db/server.ts:271` |
| 17 | Low | `sample` waiters keyed by client-chosen `callId` without viewer scoping | `sample/server.ts:416` |
| 18 | Low | `network` validator accepts the shell's own origin and sibling frame origins | `network/server.ts:66` |
| 19 | Low | Shell page inlines the 30-minute `__frame_t` token with no `no-store` | `serve.ts:289` |
| 20 | Low | Generic broker dispatch forwards raw `Error.message` (server paths) to the frame | `shell/broker.ts:52` |
| 21 | Low | Files publish accepts a `contentType` with CR/LF, making that file 500 forever | `artifact/server.ts:25` |
| 22 | Low | `fetch-runtime.sh` runs an unpinned `npx --yes js-beautify`; curl without `--fail` | `scripts/fetch-runtime.sh:62` |
| 23 | Low | `.gitignore` does not cover `.env` | `.gitignore` |
| 24 | Low | Frame-origin cookie tossing can fix a viewer's shell identity under a shared registrable domain | `auth.ts:58` |
| 25 | Low | Malformed `/_f` paths throw 500 instead of 404 | `serve.ts:372`, `store.ts:236` |

Informational items (no action required, listed so coverage is visible) are
at the end.

## High

### 1. db filename encoding is not injective; cross-viewer overwrite and delete on disk

`encodePathForFs` joins `encodeURIComponent(segment)` with `__`
(`src/protocol/paths.ts:55-57`), but `_` is inside the segment grammar. So
`data/users/<vid>/profile` and `data__users__<vid>/profile` both persist as
`data__users__<vid>__profile.json` (`src/capabilities/db/store.ts:325-336`).
The in-memory index is keyed by the real path, so the access rules hold in
memory, but the second path is a root-level collection any `interact`
viewer may write. Writing it overwrites the victim's private file on disk;
deleting it removes the file. The victim's document survives only until
the process restarts or the index is rebuilt. Viewer ids are visible in
shared rows and via `user.profiles`, so the target name is predictable.

*Reproduced:* victim sets `data/users/me/profile`; attacker `set` then
`delete` on `data__users__<vid>/profile` → both 200; `readdir` shows the
attacker's path, then nothing; after `DbStore.forget()` the victim's `get`
returns `null`.

**Fix.** Use a collision-free file name, e.g. `sha256(path)`, or encode
each segment with an escape that also covers `_` and join with a character
outside the segment alphabet. Add a store test asserting the encoder is
injective over the grammar. Doing this also fixes the ENAMETOOLONG case in
finding 13.

### 2. `sample` call route accepts cross-site and cookie-less requests

The `mcp` slice added `sameOriginOnly()` (`src/capabilities/mcp/server.ts:104-117`:
`application/json` required, `Sec-Fetch-Site` must be `same-origin` or
`none`, `Origin` must match the shell) precisely because consent lives only
in the shell page. The `sample` route (`src/capabilities/sample/server.ts:602-667`)
has no equivalent. Its gates are: artifact declares `sample`, viewer level
is not `view` (the default is `interact`, and `auth.viewer()` mints a fresh
id for a cookie-less request), and prompt size. The
`consent:<artifactId>:sample` flag is shell-side `localStorage` and is never
checked server-side. `readBody` reads text under any content type, so a
browser "simple" POST (`text/plain`, `mode: "no-cors"`) from any site the
victim visits is accepted. The attacker cannot read the response, but the
completion runs, up to tier `complex` with 4096 tokens and eight tool
rounds. A bare HTTP client with a known artifact id needs nothing at all.
Under `BIND_HOST=0.0.0.0` this is an open LLM proxy.

*Reproduced:* POST `/api/frame/sample/call` with `content-type: text/plain`,
`origin: https://evil.example`, `sec-fetch-site: cross-site`, no cookie,
`modelTier: "complex"` → 200 `text/event-stream`, `start`, echo, `done`.

**Fix.** Lift `sameOriginOnly` into the spine and apply it to every
`/api/frame/*` and `/api/account` POST (see finding 3). Reuse mcp's
streaming `readBody`. Do not mint viewer ids on API routes; require an
existing signed cookie. Consider a server-side consent record.

## Medium

### 3. Host, content-type and origin are unchecked on shell-origin writes

Neither Hono app validates `Host` against `SHELL_HOST` or
`FRAME_HOST_SUFFIX` (`src/server/index.ts:93-102`), no spine route checks
`Origin` or `Sec-Fetch-Site`, and `c.req.json()` parses under any content
type (`admin.ts:40,92`, `db/server.ts:268-305`, `user/server.ts:181-254`).
Two consequences:

- **DNS rebinding around the loopback bind.** A page that rebinds
  `evil.com` to 127.0.0.1 becomes a same-origin client of the shell with a
  fresh anonymous `interact` viewer. In the documented dev setup
  (`ARTIFACT_OPEN_ADMIN=1` plus an API key) it can create an artifact
  declaring `sample` and spend the key. Chrome's Local Network Access
  blocks this; Firefox and Safari do not. *Server half reproduced:*
  `Host: evil.com` + `content-type: text/plain` POST to `/api/artifacts`
  → 200.
- **Same-site CSRF from an artifact frame.** If a deployment puts shell
  and frames under one registrable domain, an attacker's artifact can
  declare `network: {origins: ["https://shell.example.com"]}` (the
  validator accepts it, finding 18) and `fetch` with `credentials:
  "include"`; the `SameSite=Lax` cookie is sent. Blind `set`/`update`/
  `delete` into any artifact as the victim, renaming them via
  `/api/frame/user/profile`, and owner `publish` via `/api/frame/self/:id`.
  *Reproduced* at the server; the topology precondition is by reading.
  Not reachable under the shipped `localhost` defaults.

**Fix.** Reject requests whose `Host` is not the shell host or
`<artifactId>.<frameHostSuffix>`. On every POST require
`Content-Type: application/json` and `Sec-Fetch-Site` in
`{same-origin, none}` with `Origin` equal to the shell origin. Drop the
shell origin and the frame host suffix from `network` declarations.

### 4. A single bad db rule opens the whole database

`compileRules` returns `defaults()` when any rule fails validation
(`src/capabilities/db/rules.ts:116`) and callers discard `errors`
(`db/server.ts:143,343`). The README calls this fail-closed, but the
defaults are root `read: view / write: interact`, so an author who wrote
`{path:"", write:"owner"}` plus one rule with a typo ends up with every
anonymous viewer able to write everything, with no error at publish, no
log, and nothing visible to the page.

*Reproduced:* declaration with a good root rule and one `bad path!` rule →
anonymous `set t/1` → 200; without the bad rule → 400.

**Fix.** On errors fail closed for real (root `owner`/`owner`, or refuse
every db call with `capability_disabled`), log on first touch, and validate
the declaration at `POST /api/artifacts` so authors see the rejection.

### 5. Consent dialog can be committed by a keypress the page timed

`request()` acks and opens the dialog with no activation requirement
(`src/capabilities/permissions/broker.ts:192-197`), and the dialog focuses
**Allow** (`src/shell/consent.ts:81`) with Enter/Space accepted
immediately (`:92-94`). A page that calls `request(["sample"])` while the
viewer is holding Space in a game gets a sticky grant that also covers the
`sample` broker through the shared key. Inerting the iframe stops
clickjacking but not this. Mechanism confirmed by reading; not run in a
browser.

**Fix.** Focus the cancel button or nothing; ignore keyboard activation
for roughly 500 ms after opening; consider requiring
`navigator.userActivation.isActive` before forwarding `request()`.

### 6. `__frame_nav` is relayed to `window.open` ungated

`handleNav` (`src/shell/host.ts:192-202`) checks only the URL scheme. The
platform gates this on user activation, an un-inert iframe, and a 300 ms
interval (`docs/analysis/shell.md:229`); none exist here. A page can
`parent.postMessage({__frame_nav:true, url, newTab:true})` in a loop,
including while a consent dialog is open. *Reproduced* with Playwright: a
gesture-free page fired the shell's `window.open`. Chromium's popup blocker
catches the no-gesture case in a headed browser, but every legitimate click
still lets the shell open arbitrary popups, and there is no rate limit.

**Fix.** Require `navigator.userActivation?.isActive`, bail while consent
is open or the iframe is inert, and enforce a minimum interval.

### 7. No global cap on `sample` streams; per-viewer cap is per free cookie

`MAX_STREAMS_PER_VIEWER = 8` keys on `viewer.id`
(`src/capabilities/sample/server.ts:51,420-431`), which a cookie-less
request re-mints. Unlike mcp's `MAX_CALLS_TOTAL = 64` there is no global
bound on upstream Messages API streams; only parked tool calls are capped
at 64, and that cap is itself reachable by one client with 64 fresh
cookies, which then makes every other viewer's tool round fail
`rate_limited` for 160 s.

*Reproduced:* nine concurrent calls with no cookie → nine 200s and nine
distinct `set-cookie` ids; the same nine under one cookie → 429.

**Fix.** Server-wide in-flight cap; key per-viewer limits on an existing
signed cookie; optionally limit by remote address.

### 8. Anonymous viewers reach MCP connectors with operator credentials

`MCP_SERVERS` headers are shared by every viewer and `gate()` admits any
`interact` viewer, which a cookie-less request becomes
(`src/capabilities/mcp/server.ts:314-384`, `config.ts:75`).
`sameOriginOnly` blocks browser cross-site requests, but a bare HTTP client
with a known artifact id can invoke every `(server, tool)` in that
artifact's manifest, including declared write tools. The README says
viewers share connectors, but the combination with anonymous `interact`
means every published artifact's manifest is a public API onto the
connector.

*Reproduced:* `POST /api/frame/mcp/call` with `application/json`, no
cookie, no Origin → 200 and the declared write tool ran.

**Fix.** Require an existing viewer cookie; recommend
`ARTIFACT_DEFAULT_LEVEL=view` for deployments with MCP credentials; warn
at boot when `BIND_HOST` is not loopback, the default level is `interact`,
and a live key or connector is configured.

### 9. Plain-HTTP by construction

`shellOrigin()` and `frameOrigin()` build `http://` unconditionally
(`src/server/config.ts:85-91`) with no scheme or public-URL setting and no
`X-Forwarded-Proto` handling; those strings feed `frame-ancestors` and the
preamble origins list, so a TLS terminator breaks the handshake unless the
operator patches config. Cookies are set without `Secure`
(`auth.ts:58-63,74-79`), and `/login?token=<ARTIFACT_OWNER_TOKEN>` puts
the master credential in a GET query string (`serve.ts:256-262`), where
proxies and browser history keep it. The owner cookie is also not bound to
the token, so rotating `ARTIFACT_OWNER_TOKEN` does not revoke sessions, and
login is unthrottled.

**Fix.** Add a public-URL or scheme setting; set `Secure` and use the
`__Host-` prefix when https; move login to POST or a one-time link;
include a hash of the current owner token in the sealed owner cookie;
document that a non-loopback bind must sit behind TLS.

## Low

### 10. Open redirect in `/login?next=`
`next.startsWith("/")` admits `//evil.com/x` and `/\evil.com`
(`src/server/serve.ts:259-260`). *Reproduced.* Needs the valid token in the
same URL, so the vector is a tampered login link. Fix: resolve `next`
against the shell origin and require the origin to match.

### 11. Writer-chosen content type skips the page envelope
`publish(files)` stores `contentType` verbatim and the serve path injects
the preamble only when the string `startsWith("text/html")` case-sensitively
(`serve.ts:376`, `store.ts:244,308-317`). A file typed `TEXT/HTML` or
`application/xhtml+xml` is served as an executable document on the
artifact origin with no preamble, so the RTC lockdown is absent and page
code can navigate into it inside the sandbox and exfiltrate around
`connect-src`. Requires owner or admin write level. *Reproduced.* Fix:
lowercase and allowlist content types at write time, envelope both HTML
and XHTML, and serve every other stored file with `content-security-policy:
sandbox`.

### 12. Compare-and-set is optional
`POST /api/frame/self/:id` and the admin publish fall back to
`meta.currentVersion` when `baseVersion` is absent
(`artifact/server.ts:65-66`, `admin.ts:99-100`). The broker always sends
it and the route is `canEdit`-gated, so this is defence in depth only.
*Reproduced.* Fix: require a string `baseVersion` on the frame endpoint.

### 13. Phantom documents on failed persist
`db.docs.set` runs before `await this.persist`
(`db/store.ts:378-379,402-403,466-467`). A grammar-valid path that exceeds
NAME_MAX after encoding throws ENAMETOOLONG; the caller gets 503 but the
doc is served by `get`/`query`, counts toward the quota, is never pushed to
subscribers, and vanishes on restart. *Reproduced.* Fix: persist first, or
roll back; hashed filenames (finding 1) remove the length case.

### 14. Bidi and zero-width characters survive filename sanitisation
`sanitizeFilename` (`downloads/broker.ts:108-116`) strips separators and
C0 controls but not `\p{Cf}`. `report‮gnp.html` resolves to extension
`html` while the consent body renders `reportlmth.png`. `textContent` is
used, so no HTML injection; the deception is confined to the prompt.
*Reproduced.* Fix: strip or reject format characters and NFC-normalise
before the extension check.

### 15. Room sockets are unbounded per viewer and per room
Each upgrade gets its own token buckets and becomes a fan-out recipient;
`maxPeers` is enforced only in the frame (`room/server.ts:212-292`).
*Reproduced:* 50 sockets under one cookie all open. The page cannot reach
the lane, so the attacker is a logged-in viewer. Fix: cap per
`(artifactId, viewerId)` and per room; share one emit bucket per viewer.

### 16. Whole-body buffering before size checks
`c.req.json()` / `c.req.text()` buffer everything before the 256 KiB,
8 MB or 16 MB checks (`sample/server.ts:581-589`, `db/server.ts:271,283`,
`user/server.ts:189,223,248`, `admin.ts:40,92`). `sample` compares UTF-16
length, not bytes. *Reproduced* with an 8 MiB `set`. Fix: `hono/body-limit`
on `/api/frame/*` and the admin write routes; reuse mcp's streaming reader.

### 17. `sample` waiters keyed by client-chosen `callId`
Two calls with the same id that park later overwrite each other
(`sample/server.ts:416,638-640,710`); the timeout's delete then removes
the second. Cross-viewer needs guessing ~41 bits. Fix: key by
`viewerId:callId` or mint the id server-side.

### 18. `network` validator accepts the harness's own origins
Any https origin passes (`network/server.ts:66-95`), including the shell
and sibling frame origins in a TLS-fronted deployment. Latent today
because config only produces `http://`, but it is the enabler for the
same-site half of finding 3. Fix: drop the shell host and anything under
the frame host suffix.

### 19. Shell page caches the frame token
`/a/:id` inlines `__SHELL_BOOT.frameUrl` with the 30-minute signed
`__frame_t` and the viewer id, with no `cache-control` header
(`serve.ts:289-292`, `boot.ts:82`); the frame HTML does send `no-store`.
The token is also readable by the page via `location.search`, contrary to
the `user` README. Fix: `cache-control: no-store` on the shell page;
strip the token with `replaceState` in the preamble.

### 20. Raw `Error.message` crosses to the frame
`dispatch` wraps any non-`CapError` throw as `upstream_error` with the
original message (`shell/broker.ts:52-54`, `protocol/errors.ts:57-61`).
Node filesystem errors embed absolute server paths. Fix: log shell-side
and send a fixed message for non-`CapError` throws.

### 21. CR/LF in a stored `contentType` makes the file unserveable
`decodeFiles` only checks `typeof === "string"` (`artifact/server.ts:25-32`);
undici's `Headers.set` then throws on every request. Self-inflicted, writers
only. *Reproduced.* Fix: validate against a bare media-type grammar
server-side, as the frame already does.

### 22. `fetch-runtime.sh` supply-chain hygiene
`npx --yes js-beautify` is unpinned (`scripts/fetch-runtime.sh:62-66`), and
every `curl -sSL … -o` lacks `--fail`, so a 404 body lands in
`reference/runtime/*.js` and is served as JavaScript in conformance mode.
Fix: pin the version, add `--fail --proto '=https'`, validate the UUID
argument.

### 23. `.gitignore` omits `.env`
The README configures everything through env vars, so a local `.env` is
the natural next step and `git add -A` would commit it. No `.env` exists
today. Fix: add `.env`, `.env.*`, `*.local`.

### 24. Cookie tossing from a same-site frame
The `av` cookie has no `__Host-` prefix and no `Domain`
(`auth.ts:58-63`). Under a shared registrable domain an artifact page can
set `av=<attacker's sealed id>; Domain=example.com`, and Hono's
`getCookie` keeps the last, so the victim's shell acts as the attacker's
viewer id and their `data/users/me` writes land where the attacker can
read them. Cannot escalate to owner. Plausible by reading; moot under
`localhost`. Fix: `__Host-` prefix once https exists; document that the
frame suffix must not sit under the shell's domain.

### 25. Malformed frame paths return 500
`decodeURIComponent` throws on `/_f/v1/%E0%A4` (`serve.ts:372`) and
`versionDir` throws outside the try for `/_f/v1!/index.html`
(`store.ts:236`). No stack reaches the client. *Reproduced.* Fix: validate
the version id in the handler and wrap the decode.

## Informational

- `ARTIFACT_SECRET` defaults to a per-boot random value, so every restart
  invalidates all cookies and asset tokens; worth a README sentence.
- Deleted blobs stay cacheable for a year (`public, max-age=31536000,
  immutable`); ids are unguessable so only prior fetchers are affected.
- The frame-port listener also accepts the shell's websocket lanes when no
  `Origin` is sent (`server/index.ts:121-122`); browsers always send one,
  so it only widens the surface. Register the upgrade handler on the shell
  server only.
- `/_f/:ver` redirect drops the query string, so `__frame_t` is lost and
  the viewer becomes anonymous.
- `publish --token` puts the owner token in argv; `SHELL_URL`,
  `RUNTIME_DIR` and `NODE_ENV` are read but undocumented.
- `@anthropic-ai/sdk` is declared but never imported; the sample backend
  uses raw `fetch`. Dead surface.
- `docs/analysis/artifact.md:3-4` embeds authoring-session scratchpad
  paths.
- One HMAC key seals viewer cookies, owner cookies, asset tokens and lane
  grants with no type tag; value shapes are mutually unparseable today,
  but a `kind:` prefix is cheap insurance.
- `invalidate()` in a loop re-runs every mcp watch immediately; bounded by
  the per-viewer and global slots, per-artifact scope only.
- `test/mcp/server.test.ts` "chunked body" assertion is flaky in this
  environment (socket-level measurement, not a security issue).
- No Dockerfile, CI workflow, or `.npmrc`; README says `npm install`, not
  `npm ci`.

## What was reviewed and found sound

- **Dependencies.** `npm audit` reports zero advisories across 262
  packages; registry signatures verified for all 161 installed. Only
  install script is esbuild's standard binary placement. No secrets, keys,
  or `.env` in the tree or history.
- **Auth primitives.** HMAC-SHA256 seals with `timingSafeEqual`; the
  owner-token compare hashes both sides first. Admin API closed unless a
  token or explicit `ARTIFACT_OPEN_ADMIN=1`; `BIND_HOST` defaults to
  loopback; `ARTIFACT_PREFIX_HOSTS` off with the client `x-artifact-id`
  stripped.
- **Origin isolation.** Artifact id comes from the host label only;
  tokens minted for one artifact are refused on another's host; `/_blob`
  reads the artifact from the host, never the URL. Path traversal in every
  encoding tried returns 404. Frame CSP is `default-src 'none'`,
  `frame-ancestors <shell>`, `form-action 'none'`, `base-uri 'self'`,
  validated `connect-src`, `nosniff`, `no-referrer`; shell page is
  `frame-ancestors 'none'`.
- **Transport.** Both directions check `source` and `origin`; no
  `targetOrigin: "*"` on shell-to-frame sends. Capabilities in
  `__frame_init` are server-sourced; the gate is in the broker, not the
  preamble. Messages are validated and arrive by structured clone (no
  prototype pollution). Sandbox is `allow-scripts allow-same-origin
  allow-forms` on a cross-origin frame with no `allow-downloads`,
  `allow-modals`, `allow-popups` or `allow-top-navigation`. Consent
  inerts the iframe and keys on a server-set artifact id in the shell
  origin's storage. Envelope injection escapes `<`, `>` and U+2028/9 and
  steps over raw-text elements.
- **db.** Rules evaluated only on the server; `data/users/{self}` privacy
  holds for every verb, the lane, and the owner; no existence oracle; path
  grammar rejects `.`/`..`/empty/encoded segments on all three sides;
  operators whitelisted; no cursor to forge; per-artifact write lock;
  size/depth/count caps; `__proto__` keys are harmless own properties.
- **user.** Identity is the httpOnly signed cookie on the shell origin;
  `isOwner`/`canEdit` are recomputed server-side; `profiles` limited to
  peers plus self; `search` owner-only and capped; names control-stripped
  and never rendered as HTML.
- **permissions.** Consent key cannot be steered to another artifact;
  denied is sticky; no server route reads another artifact's consent.
- **sample.** System prompt, `max_tokens`, model table, `stream` and
  version are fixed server-side; images are base64 only (no SSRF); tools
  and images require the stored declaration; nothing executes
  server-side; tool results are viewer-checked; upstream abort on client
  disconnect; API key only in the outbound header; reply cache scoped to
  artifact and viewer; `limits()` matches the enforced clamps; legacy
  `complete()` goes through the broker and consent.
- **mcp.** Directory is boot-time config; pages name servers, never URLs;
  `host:` refused at every layer; manifest re-checked; body metered while
  streaming; 4 MB result cap; 120 s budget; upstream error text and
  headers never reach the page; cache and watches scoped by artifact and
  viewer; cancellation is per broker context.
- **network.** Validator refuses whitespace, `;`, quotes, credentials,
  paths, queries, `http:`, `data:`, `blob:`, wildcards; re-emits from
  `URL.origin`; CSP stamped server-side and joined from validated values.
- **assets.** Upload and delete are owner or admin server-side; content
  type allowlisted (no `text/html`) and served with `nosniff`, `sandbox`
  CSP and `no-referrer`; per-blob and per-artifact ceilings under the
  write lock with streamed metering; 122-bit random ids; delete always
  scoped to the current artifact.
- **downloads.** No backend; prompt is shell DOM with the iframe inert;
  one open prompt and five per minute; 16 MiB cap before prompting; MIME
  from extension only; sandbox lacks `allow-downloads`.
- **room.** Upgrade requires the shell listener, exact `Origin`, and a
  valid cookie; level recomputed server-side; peer ids minted by the shell
  and bound to the viewer; sender identity stamped by the server; topic
  ACL enforced server-side, fail-closed; payloads capped; cleanup on close
  and shutdown.
- **artifact.** `canEdit` enforced server-side; a viewer's page cannot
  publish; publish runs under the per-artifact lock; file paths are
  validated and resolve-checked; publish never touches `meta.capabilities`;
  title is HTML-escaped.

## Suggested order of work

1. Fix the db filename encoding (finding 1) and add the injectivity test.
2. Lift `sameOriginOnly` into the spine and apply it to every POST route,
   validate `Host`, and stop minting viewer ids on API routes (findings 2,
   3, 7, 8). Add a global `sample` stream cap and a boot-time warning for
   non-loopback binds with a live key.
3. Make db rule compilation fail closed and validate declarations at
   publish (finding 4).
4. Gate `__frame_nav` and harden the consent dialog focus and timing
   (findings 5, 6).
5. Add the TLS and cookie hardening as a unit (findings 9, 19, 24) once a
   public-URL setting exists.
6. The remaining lows are each a few lines and can go in one hygiene pass.
