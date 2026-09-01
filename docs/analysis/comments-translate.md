# Artifact frame runtime: `comments`, `_comments`, `_translate` — reverse-engineering report

Sources (all read in full):

- `pretty/comments.vw5vQdGA.js` (626 lines) — page-facing `claude.use("comments")` capability.
- `pretty/_comments.C6E0cR5g.js` (1651 lines) — shell-driven comment-mode hit-tester / locator installed on first `__fc_mode`.
- `pretty/_translate.5HCW4BJh.js` (322 lines) — in-page translation installed on first `__ft_cmd`.
- Context: frame-runtime preamble (2nd `<script>` of the served page, extracted to `scratchpad/preamble.js`), `_transforms.DSB5x63f.js`, and — for the host side — `shell/frame-shell-chrome-DzzMV3mP.js` (pretty-printed to `pretty/frame-shell-chrome-DzzMV3mP.js`; this is the React comment-mode host that sends `__fc_*`/`__ft_*`), `shared-frame-RTyxa5Z-.js`, `frame-shell-BTPNFq1_.js`.

Anything marked **(inference)** is not literally in the code. Everything else is quoted or paraphrased from it.

---

## 0. How the three modules get installed (preamble context)

`window.__FRAME_PREAMBLE = {"v":1,"capabilities":{...,"comments":"comments.vw5vQdGA.js",...},"transforms":"_transforms.DSB5x63f.js","comments":"_comments.C6E0cR5g.js","translate":"_translate.5HCW4BJh.js"}`.

- Modules load via `import("/_runtime/" + file)`; file names must match `A = /^[\w.-]+\.js$/`.
- Handshake: frame posts `{__frame_connect:true}` to `"*"`; shell answers `{__frame_init:{contract, changes, flags, capabilities, capBudgets, theme, ...}}`; the sender origin becomes `shellOrigin` (`E`). All later shell messages are filtered on `source===parent && origin===shellOrigin`. After capabilities install, the frame posts `{__frame_ready:true}`.
- **Capability modules** (`comments.js`): loaded only for names present in both `__frame_init.capabilities` and the preamble map. Called as `mod.install(runtime)` where `runtime = {contract, changes:Set, flags:Set, capabilities, capBudgets, transforms, shellOrigin, mount, hooks, pipe}`.
  - `mount(name, obj)` resolves the pending `claude.use(name)` promise with a frozen, null-prototype copy of `obj` (`then` stripped). Unresolved caps are nulled after install (`F()`), so `claude.use("comments")` resolves `null` when the cap was not declared/granted.
  - `pipe(scope).wrap(method, fn)`: default just turns sync throws into rejections. With `_transforms` present it applies registered `parameters`/`returns`/`throws` transforms whose `targets` include `"comments.<method>"` (error `{code:"transform_error", id, scope, message:"parameters transform failed"}`).
- **`_comments`** is lazy: on the first shell message carrying `__fc_mode` the preamble does `S(D).then(K=>K.install?.(shellOrigin, H.on===true))` — once (`f` flag). Only `on` from that triggering message is applied; `composing/labels/regions/cursor` in that first message are dropped (the host immediately follows with `__fc_locate`, which carries `labels/regions/cursor`, and re-posts `__fc_mode` whenever those flags change, so this is benign) **(inference on benignity)**.
- **`_translate`** is lazy: on the first `__ft_cmd` message, `S(I).then(K=>K.install?.(shellOrigin, cmd))`; `install` processes that command immediately (`n && typeof n=="object" && u(n)`).

Host-side boot flags relevant here (from `frame-shell-BTPNFq1_.js`): `commentsCustomAnchorsDeclared = capabilities.comments.optional !== true && capabilities.comments.config.customAnchors === true`; `commentsHeadless` (`config.customAnchors===true && config.headless===true`, `shared-frame` `Tg`); `translateEnabled`, `commentRegionsEnabled`, `commentCursorEnabled`, `commentSectionsEnabled` (= labels), `commentsDataUrl = <origin>/_f/<ver>/index.html.json?__frame_t=<assetToken>`.

---

## 1. `comments.vw5vQdGA.js` — the page-facing capability

### 1.1 Exports

```js
export { N as cssPath, ve as install, W as sigFor, ue as simhash64 };
```

`install(runtime)` mounts `"comments"` with the members below. Config read: `runtime.capabilities?.comments?.config`; `E = config.customAnchors === true`, `j = config.composer_only !== true` (i.e. `composer_only` form when `config.composer_only === true`).

### 1.2 RPC transport to the shell (`c(method, args)`)

Sent (to `parent`, target origin `shellOrigin`; when `MessageEvent.prototype` has `userActivation` it posts with `{targetOrigin, includeUserActivation:true}`):

```js
{ __frame_cap: true, cap: "comments", id: "k"+n, method: <string>, args: <array> }
```

Received (must be from `parent` at `shellOrigin`, matched on `id`):

- `{ __frame_cap_ack: true, id }` — shell is prompting the user; timer extended to **900 000 ms** (15 min); on expiry reject `{code:"upstream_error", message:"no verdict from shell after prompt"}`.
- `{ __frame_cap_r: true, id, result?, error? }` — settles; `error !== null && !== undefined` → reject with `error` as-is, else resolve `result`.
- (`shared-frame` also defines `{__frame_cap_p:true,id,p}` progress frames; comments.js ignores them.)

Timeouts / errors:

- No reply within **130 000 ms** → reject `{code:"upstream_error", message:"no reply from shell"}`.
- `postMessage` throws (non-cloneable args) → reject `{code:"invalid", message:"arguments are not structured-cloneable"}`.

The shell-side broker that answers `cap:"comments"` lives in a lazily imported chunk (`./c26621f4a-CeTsb9NB.js`, referenced from the chrome bundle) that is **not** in the captured set, so result shapes for the pass-through methods below are not verifiable from code. The chrome bundle exposes module-level bridge hooks the broker calls: `dl(e) = ul?.(e)` (→ host `Uo(payload)` returns boolean "composer opened"), `pl() = fl?.eligible()`, `ml(e) = fl?.roomSendTarget(e)`, `hl(e) = fl?.deliver(e)`. **(inference)** `openComposer` resolves `{opened: boolean}` (the page module itself resolves `{opened:false}` for uncommentable targets, so the shape is fixed), `canSendToClaude` maps to `eligible()`, `sendToClaude` to `deliver()`.

### 1.3 Public API (every member)

| Member | Args → wire | Validation in frame | Resolves |
|---|---|---|---|
| `create(a)` | `c("create",[a])` | none (pass-through) | shell result **(inference: `{text, anchor?}` → created thread; see REST §1.9)** |
| `reply(a, b)` | `c("reply",[a,b])` | none | shell result **(inference: `(threadId, text)`)** |
| `sendToClaude(a)` | `c("sendToClaude",[a])` | none | shell result |
| `canSendToClaude()` | `c("canSendToClaude",[])` | none | shell result |
| `resolve(a, b)` | `c("resolve",[a,b])` | none | shell result **(inference: `(threadId, resolved:boolean)` per REST `{resolved}`)** |
| `delete(a)` | `c("delete",[a])` | none | shell result |
| `openComposer({element} \| {range})` | `c("openComposer",[payload])` | see §1.4 | `{opened:false}` locally for `[data-uncommentable]`, else shell result |
| `anchorFor(el)` | local only | `el instanceof Element && el.isConnected` else `{code:"invalid", message:"anchorFor takes an Element in the document"}` | `{path: cssPath(el), x, y}` with x,y = normalized (0..1) viewport-clamped centre |
| `customAnchors({mode, threads, reveal, composing?})` | local + `__fc_ca` | see §1.5 | handle object (§1.5) |

### 1.4 `openComposer` payload construction

Errors: `{code:"invalid", message:"openComposer takes {element} or {range}"}` (neither or both keys), `"openComposer takes an Element in the document"`, `"openComposer takes a Range in the document"` (`commonAncestorContainer.isConnected && ownerDocument===document`), `"openComposer could not read the target's geometry"` (any throw).

If `target.closest("[data-uncommentable]") !== null` → `Promise.resolve({opened:false})` without contacting the shell.

Payload `v` (element `i`, or the Range's common-ancestor element `t`):

```js
{
  path: cssPath(el),                    // §1.7
  x, y,                                 // F(rect): centre of the rect clamped to the viewport, divided by innerWidth/innerHeight (0..1)
  pin: { x, y },                        // B(): (px - rect.left)/rect.width clamped 0..1, same for y
  sig?: { v:1, tag, h? },               // sigFor(el), omitted when tag fails /^[a-z][a-z0-9-]{0,23}$/
  doc?: { x, y },                       // Z(): clamped point + scrollX/scrollY, only when getClientRects().length > 0
  rect: { top, left, width, height },   // getBoundingClientRect of el
  span?: { start, quote }               // range form only
}
```

`span` only when `quote = range.toString()` is non-empty, `≤ 512` UTF-16 units (`me`), `≤ 512` UTF-8 bytes (`de`), well-formed (no lone surrogates, `fe`), and `start ≤ 16 777 216` (`pe`). `start = he(t, startContainer, startOffset)` = length of `Range(selectNodeContents(t), setEnd(startContainer,startOffset)).toString()` — i.e. UTF-16 offset of the selection start inside the ancestor element's text (`Range.toString`, not `textContent`).

### 1.5 `customAnchors` (page-drawn pins)

Gate: `config.customAnchors !== true` → `{code:"not_granted", message:"customAnchors is not declared by this artifact's served version"}`.
Validation: `mode`, `threads`, `reveal` must be functions, `composing` optional function → else `{code:"invalid", message:"customAnchors takes {mode, threads, reveal} callbacks and an optional composing callback"}`. Only one registration at a time: `"a customAnchors override is already registered - release() it first"`.

On registration: `I += 1` (registration counter), sets `window.__FC_CA = {on:true}` and dispatches `new Event("__fc_ca_change")` on window (this is how `_comments.js` learns to stand down), posts `{__fc_ca:{on:true, reg:I}}`. In a microtask, replays current state: `mode(true)` if mode on, `composing(true)` if composing, `threads([...])` if any.

Callbacks invoked (each wrapped in try/catch):
- `mode(on:boolean)` — on each `__fc_mode.on` transition. When turning on, the frame re-posts `{__fc_ca:{on:true,reg}}` and re-sends placements.
- `composing(on:boolean)` — on `__fc_mode.composing` transitions (only while `on`).
- `threads(list)` — on every `__fc_threads`; items are copies of `{id, anchor, resolved, active}`.
- `reveal(id)` — on `__fc_reveal {id}` if `id` is in the current thread list.

Handle returned:

- `compose(anchor, target, opts?)` → `openComposer` RPC.
  - `anchor` string must be non-empty and pass `ae()`: either a domAnchor path (`Q()`: ≤1024 chars, 1–10 segments split on `" > "`, every segment `/^[a-z][a-z0-9-]{0,23}:nth-of-type\([1-9][0-9]{0,3}\)$/` except the first which may be `/^#[A-Za-z_-][A-Za-z0-9_-]{0,31}$/` or `/^\[data-id="[A-Za-z0-9_-]{1,64}"\]$/`) **or** a page-invented name ≤128 UTF-16 units, ≤128 UTF-8 bytes, no `/[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}  ]/u`. Message: `"compose takes a non-empty anchor: a name of at most 128 bytes with no control or invisible characters, or a domAnchor() path (a path through a tag longer than 24 characters or outside a-z, 0-9 and hyphen is judged as a name)"`.
  - Under `composer_only` (`config.composer_only === true`) names are refused: `"under the composer_only form compose keeps only a domAnchor() path through ordinary tags (a-z, 0-9, hyphen, at most 24 characters); a page-invented name, or a path through any other tag, is not kept there"`.
  - `opts` `{label?, detail?, area?}`: label/detail strings ≤1024 UTF-16 units (empty = none); `"compose label and detail are strings of at most 1024 UTF-16 units (the shell keeps at most 128 bytes of the label and 512 of the detail as plain text, or nothing); empty means none"`. `area:true` sets `payload.area = true`.
  - `target` Element (connected; `[data-uncommentable]` → `{opened:false}`) → `{path:anchor, x, y, pin, rect}` (no `sig`, no `doc`, no `span`); or `{x,y}` in **document CSS px** → `{path:anchor, x: clamp((x-scrollX)/innerWidth), y: ..., pin:{x:.5,y:.5}, rect:{top: y-scrollY, left: x-scrollX, width:0, height:0}}`. Else `"compose takes an Element or a {x, y} point in document CSS px"`.
- `open(threadId, target)` → posts `{__fc_open:{id, x, y}}` with viewport coords (Element → clamped centre; `{x,y}` doc px → minus scroll). `id` must be a string ≤256 (`"open takes a thread id from the threads callback"`). Resolves `undefined`.
- `placed({[threadId]: {x,y}})` — records page pin positions in **document px** (keys ≤256 chars, finite numbers) and posts (rAF-coalesced) `{__fc_placed:{placed:{[id]:{x: x-scrollX, y: y-scrollY}}}}`. Re-posted automatically on capture-phase `scroll` and `resize` while mode is on.
- `domAnchor(el, pointerEvent?)` → `[cssPath(el), {x,y}]` doc px (event clientX/Y + scroll, else rect centre). Throws `TypeError("domAnchor takes an Element in the document")`.
- `exitMode()` — while mode on: posts `{__fc_exit:true}` and again after 300 ms if still in mode and the mode generation (`D`) hasn't changed.
- `release()` — clears registration and placements, `__FC_CA={on:false}`, posts `{__fc_ca:{on:false}}`.
- `get areas` — `true` iff registered and `__fc_mode.regions === true`.

Any handle method after `release()` → `{code:"invalid", message:"this customAnchors registration was released"}`.

Host-side facts about this channel (chrome bundle): thread ids given to the page are **aliases** `"ca-<n>"` (`toAlias/toReal` maps), so a page never sees real thread UUIDs; `__fc_threads` lists at most 256 threads that have a non-empty `anchor.path`, `{id: alias, anchor: path, resolved: !!resolved_at, active: id === activeId}`, and is only re-sent when the JSON changes. `__fc_open` is rate-limited to 4 per 10 s and ignored if the thread is unknown/already open/the composer is busy. `__fc_placed` entries are read as `{top:y,left:x,width:0,height:0}` rects keyed by the thread's anchor path (max 256). `__fc_ca` is accepted only if `on` flipped or `reg` changed or the source window changed; the host resets all located rects/labels/spans on each acceptance.

### 1.6 Messages the capability module itself listens for (from shell)

- `{__fc_mode:{on, regions?, composing?}}` — tracked as `M` (on), `L` (regions), `X` (composing); increments `D` on turn-on.
- `{__fc_threads:{threads:[{id ≤256, anchor ≤1024, resolved?, active?}]}}` — invalid items dropped.
- `{__fc_reveal:{id}}`.

### 1.7 `cssPath` (`N`) — DOM anchor path

- `body`/`html` → `"body:nth-of-type(1)"` / `"html:nth-of-type(1)"`.
- Walk up to 10 ancestors. At each element: if `id` and `"#"+CSS.escape(id)` matches `K=/^#[A-Za-z_-][A-Za-z0-9_-]{0,31}$/` → prepend and **stop**; else if `data-id` matches `/^[A-Za-z0-9_-]{1,64}$/` and `querySelectorAll('[data-id="…"]')` yields exactly this element → prepend and stop; else prepend `tag:nth-of-type(k)` (k = 1 + count of previous siblings with the same tagName).
- Join with `" > "`, `.slice(0, 1000)`.

### 1.8 `sigFor` (`W`) and `simhash64` (`ue`)

`sigFor(el)` → `null` if `tagName.toLowerCase()` fails `/^[a-z][a-z0-9-]{0,23}$/`; else `{v:1, tag}` or `{v:1, tag, h}` where `h = simhash64(textContent.slice(0, 4096))`.

`simhash64(s)`: collapse whitespace, trim; `""` if < 8 chars. For every 4-char shingle compute FNV-1a-style hashes `$(shingle, 2166136261)` and `$(shingle, 16777619)` (`r ^= charCode; r = Math.imul(r,16777619)>>>0`), vote bits into a 64-vector; output `hex8(hash2bits) + hex8(hash1bits)` (16 lowercase hex chars; note the second hash comes first). Host regex for `h`: `/^[0-9a-f]{16}$/`; `v` accepted 1..8. Match threshold: Hamming distance ≤ 20 (`SIG_HAMMING_MAX`).

### 1.9 Host REST behind the RPC (chrome bundle, for a self-host)

- `GET /api/frame/comments/{frameUuid}?org={org}` → `{threads:[...]}` (8 s timeout). Thread parse (`Qn`): `{id (uuid), comments:[{id, text, created_at?, edited_at?, source?, to_claude_at?, sent_by_viewer?, author?:{account?, role?}}], created_at?, resolved_at?, claude_activated_at?, claude_activated_by? (uuid or /^u_[A-Za-z0-9_-]{8,64}$/), anchor?:{path?, x?, y?, span?:{start,quote≤512B}, pin?:{x,y}, sig?, doc?:{x,y ≤1048576}, file?, file_sha?, label?, detail?(≤512B), region?:{x0,y0,x1,y1 (rounded to 3 dp), kids?:[≤8 ascending ints <4096]}}}`.
- `POST /api/frame/comments/{frameUuid}?org=` body `{text, anchor?, to_claude?:true, presence?}` — new thread.
- `POST .../{threadId}` `{text, to_claude?, presence?}` — reply.
- `POST .../{threadId}/resolve` `{resolved:boolean}`; `.../delete` `{}` (keepalive); `.../activate` `{activated:boolean}`; `.../{threadId}/{commentId}/edit` `{text}`.
- On HTTP 400 the host retries progressively stripping anchor fields: `detail` → `region` (+ strips " · N elements" from label) → `label` → `presence` → `sig`/`doc` → `span`.

---

## 2. `_comments.C6E0cR5g.js` — comment-mode hit-testing overlay

### 2.1 Export / install

```js
export { Fn as install, ... }   // install(shellOrigin, initialOn)
```
Also exports test helpers: `SIG_HAMMING_MAX=20`, `anchorTarget`, `areaLabel`, `cssPath`, `findBySig`, `hamming64`, `labelFor`, `labelIndex`, `nearestIndexOf`, `normalizeLabel`, `parseDocQueries`, `parseSigQueries`, `parseSpanQueries`, `pinFor`, `pressOnSelectableText`, `rangeAt`, `refineTarget`, `regionOf`, `regionTarget`, `resolveAmong`, `resolveSpanRange`, `sigFor`, `sigMatches`, `simhash64`, `spanClientRects`, `utf16OffsetIn`, `wellFormed`, `_test.servedDoc`.

**What it injects: no visible UI at all.** The pins, hover highlight, marquee rectangle, composer and cards are all rendered by the *parent* (shell) over the iframe, using client rects this module reports. The only DOM mutations are:

- a `<style>` appended to `<head>` (or `<html>`) with `* { cursor: <c> !important; }` plus `html.style.cursor = <c> !important` while mode is on and not composing and no custom-anchors override; `<c>` is a data-URI SVG "speech-bubble" cursor (`Tn`, hotspot 2 2, fallback `crosshair`), or in cursor mode `"text"` over words / `"crosshair"` otherwise. Restored exactly on exit.
- during a marquee drag: `user-select`/`-webkit-user-select: none !important` on `<html>` (restored after), `selectstart`/`dragstart` suppressed, pointer capture on `documentElement`.
- `document.getSelection().removeAllRanges()` and blur of editable elements when the module claims a press.

### 2.2 State flags (from `__fc_mode` / `__fc_locate`)

`o` on, `h` composing, `tt` labels, `Y` regions (marquee), `m` cursor (word-level targeting). Custom-anchors override: `E() = window.__FC_CA?.on === true`; when true the module disables hover/click/marquee reporting and listens for `__fc_ca_change` to re-evaluate.

### 2.3 Messages RECEIVED (from parent at `shellOrigin`)

| Key | Payload | Effect |
|---|---|---|
| `__fc_mode` | `{on, composing?, labels?, regions?, cursor?}` | sets flags; re-posts `__fc_doc`; updates cursor style; clears hover when off/composing; cancels marquee when regions off |
| `__fc_locate` | `{paths:[≤128 strings ≤1024], sigs:{path:{v,tag,h?}} (≤128), docs:{path:{x,y}} (≤128, 0..1048576), spans:[{id ≤128, path ≤1024, start int ≤16777216, quote 1..512 chars}] (≤128), labels?, regions?, cursor?}` | resets caches, resolves every span range, replies `__fc_rects` immediately (with labels if `labels`) |
| `__fc_reveal` | `{path ≤1024, span?:{start,quote}}` | ignored when custom anchors on; scrolls the span's parent / the element / the `#id` head segment into view (`block:"center", inline:"nearest"`, smooth unless reduced-motion); falls back to `scrollTo` the doc point when the element is missing and the page scrolls |
| `__fc_region` | `{rect:{left,top,width,height}, corner:"nw"\|"ne"\|"sw"\|"se"}` | a marquee drawn in the **shell** (started outside the iframe) is finalised here → `__fc_click` with `region` |
| `__fc_goto` | `{file}` | multi-file artifacts: `location.assign(new URL(file, root))` if valid, same origin, under root, not current |

Host sends `__fc_mode` on mode entry, on any flag change, on iframe swap, and `{__fc_mode:{on:false}}` on exit (also sets `data-comment-mode` on the host `<html>`). Host sends `__fc_locate` every **500 ms** (`ic`) while comment mode is on and the tab is visible, plus on host resize / iframe ResizeObserver, plus right after a click/openComposer. Locate payload builder (`vi`): `paths` = draft path + every thread anchor path + `Dl(path)` head segment (`#id` / `[data-id]`) + region kid paths `"<path> > :nth-child(k+1)"` (max 128); `spans` = draft (`id:"draft"`) + thread spans with ids aliased `"sp-<salt>-<n>"`; `sigs`/`docs` keyed by path (conflicting sigs on one path degrade to `{v,tag}`); `identityPaths` (live-doc) skips `[data-id]` paths.

### 2.4 Messages SENT (to parent, `shellOrigin`)

| Key | Payload |
|---|---|
| `__fc_doc` | `{file}` — served sub-document name for multi-file artifacts (path relative to `/_f/<id>/` root, decoded, never `"index.html"`; validated ≤512 chars, no `?`/`#`, no empty segment, round-trips through `decodeURIComponent(new URL(t,"https://x/").pathname.slice(1)) === t`). Posted on install and on each `__fc_mode`. |
| `__fc_hover` | `null` or `{rect}` (element mode) or `{rect, kind:"element", radii:[tl,tr,br,bl]}` / `{rect, kind:"word", caret:{x,top,height}}` (cursor mode). rAF-coalesced, deduped. |
| `__fc_marquee` | `{rect:{left,top,width,height} (viewport), corner}` while dragging; `null` when the drag ends (only if something was sent). |
| `__fc_click` | see §2.6 |
| `__fc_rects` | `{rects:{[path]: rect\|null, ["doc:"+path]?: {top,left,width:0,height:0}}, spans:{[spanId]: {mode:"exact"\|"requote"\|"element", rects:[≤64]} \| null}, labels?:{[path]:{label,key,ord}}}` |
| `__fc_escape` | `true` — Escape pressed while focus is not in an editable (deferred via `setTimeout 0`, suppressed if the page `preventDefault`ed) |

### 2.5 Pointer / keyboard behaviour

- **Hover** (mode on, not composing, no custom anchors, pointerType mouse/pen): capture-phase `pointermove` stores `{x,y,inner:composedPath()[0]}` and rAF-schedules `Jt()`. Element mode: `ct()` refine (below); if the target is background/uncommentable → `__fc_hover:null`. Cursor mode: `Xt()` word/element hit-test.
- **Click** (capture-phase `click`, mode on, no custom anchors): always `preventDefault()`+`stopPropagation()` (the page never sees clicks in comment mode). Skipped once if `G` (a drag/selection/marquee just happened). `detail===0` (keyboard activation) snaps to the element centre. Posts `__fc_click`.
- **Text selection**: `pointerdown` snapshots the current selection; on `pointerup` (not custom anchors) if a non-collapsed selection exists that differs from the snapshot and `toString() !== ""`, posts `__fc_click` with `span` (see §2.6) anchored on the common-ancestor element, and sets `G` so the following `click` is swallowed. Movement threshold: 5 px mouse (`Tt`), 16 px touch (`Ye`).
- **Marquee** (`regions` on, mouse button 0, no ctrl/meta/alt, not on editable/uncommentable, not on a scrollbar): starts on `pointerdown` when `shiftKey` or the press is not on selectable text (`nn`/`Xt` word check). Live after 5 px; capture-phase `pointermove` posts `__fc_marquee`; page scroll of an ancestor cancels; `pointerup` finalises via `se(rect, corner)` (min 12×12 px, `ce`). Escape / blur / `lostpointercapture` / custom-anchors-on cancel.
- **Cursor mode presses** (`m`): on a press not on a word the module claims the pointer (`Ge`): suppresses selectstart/dragstart, clears selection, blurs editables; drag > 5 px hides hover until `pointerup`, which re-hovers at the release point.
- **Escape**: `keydown` Escape with no modifiers and focus not in input/textarea/select/contentEditable/designMode → `__fc_escape`. Host treats it as "close card / leave mode".
- Scroll (capture) / resize: re-sends `__fc_rects` for the last `__fc_locate` paths and re-hovers.

### 2.6 `__fc_click` payload

```js
{
  path: string,            // cssPath(target) or "" when the click landed on background
  file?: string,           // served sub-document name (multi-file artifacts)
  x, y: number,            // click point / innerWidth, innerHeight (viewport fractions, unclamped here; host clamps 0..1)
  pin?: {x,y},             // fraction inside target rect (omitted for background clicks)
  sig?: {v:1, tag, h?},
  label?: string,          // only when labels on (§2.9)
  doc: {x,y},              // click point + scroll, floored at 0 (document px)
  rect: {top,left,width,height},
  span?: {start, quote},   // selection form; {start:0, quote:""} when the quote failed limits
  region?: {x0,y0,x1,y1, kids?}, corner?: "nw"|"ne"|"sw"|"se",   // marquee form
  bg?: true, blocked?: true   // click on an uncommentable element
}
```

Host-side acceptance (`oo`): path must be ≤1024 UTF-8 bytes else treated as `""`; `span` via `vl` (start ≤16777216, quote ≤512 bytes, well-formed, no control/format chars); `sig` via `sr`; `doc` via `cr`; `label` via `Sr` (128-byte plain-text normaliser); `region` via `ir` only when `commentRegionsEnabled`, no span, path non-empty, not bg/blocked; `x`,`y` default `.5`. `bg`/`blocked` or a body/html-only path (`Yl`) while a card is open just closes the card.

Marquee `se()` specifics: anchor corner = the corner opposite to `corner` (drag origin); target element `tn(rect)` = deepest element that covers ≥85% (`kt`) of the marquee area (one 70% (`Ke`) relaxation allowed), starting from `elementFromPoint(centre)` chain, walking down unique children up to 64 levels; `region = regionOf(target, rect)` = normalised bounds within the target (3 dp) + `kids` = indexes (≤8, of the first 4096 children) of children ≥50% covered, `covered` = count; `sig` is degraded to `{v,tag}` when `kids` present; `label = areaLabel()` ("<label> · N elements", ≤128 bytes with `...` truncation by grapheme). If no region can be computed and composing → dropped.

### 2.7 Target refinement (`ct` / `refineTarget`)

From the hit element: while it is `html`/`body` or its height ≥ 80% of the viewport, descend (max 8 steps) into the visible child that contains the point (distance 0) or is nearest. Result is "background" (`bg:true`) if it is still html/body or the point is > 24 px (`qe`) outside it; background resolves to `body` (if it contains the point) or `html`. In cursor mode `Ae()` first climbs to the nearest non-inline ancestor (or replaced element: IMG, VIDEO, AUDIO, CANVAS, IFRAME, EMBED, OBJECT, PICTURE, INPUT, TEXTAREA, SELECT, BUTTON, METER, PROGRESS, or an `<svg>`); inner SVG shapes are targeted directly with `radii` from `rx`.

`[data-uncommentable]` is honoured through shadow-root hosts (`W`).

### 2.8 Element / span resolution for `__fc_locate` → `__fc_rects`

- `ft(path)`: cached `querySelector`; if `querySelectorAll` yields >1, `resolveAmong` (`xn`): take first 16, keep those nested in the first, prefer the one whose sig is Hamming-closest to the query sig, then the smallest one containing the `doc` point, else the outermost.
- Sig verification (`we`): tag must match; if the query has `h` and the element's simhash differs by > 20 bits the element is treated as **not found** (`F[path]=false`) and spans on that path are nulled.
- Fallback `findBySig` (`Nn`): scan `getElementsByTagName(tag)` (skip if 0 or > 512 elements, or the cumulative text budget of 262 144 chars is exceeded) for a unique element within Hamming 20. Failed searches back off: skip 1, 2, 4, … up to 16 polls (`Rn`).
- Doc-point fallback: if the element is missing (and it was not merely present-but-unrendered), the page scrolls by > 32 px (`Kt`) in x or y with overflow not hidden/clip, and the path's head segment (`#id`/`[data-id]`) is present-and-rendered (or the path is a single segment), report `rects["doc:"+path] = {top: y-scrollY, left: x-scrollX, width:0, height:0}`.
- Rects are `null` when the element has no client rects. Host keeps a stale rect for up to 2 consecutive misses (`Qc`, "comments-locate-grace" hold/expire).
- Spans (`ye`/`resolveSpanRange`): `textContent` of the element (bail `mode:"element"` if > 16 777 216 chars); `exact` if `substr(start, quote.length) === quote`, else `requote` at the occurrence of `quote` nearest to `start` (`bn`), else `element`; range built by walking text nodes (`wn`); rects via `getClientRects()` (≤64, zero-size dropped).

### 2.9 Labels (`labels`/`commentSectionsEnabled`)

`labelIndex` (`lt`): all `h1..h6,[role=heading]` (≤2000) that are rendered and not under `[hidden],[aria-hidden=true],[data-uncommentable]`, with normalised text (`Gt`: ≤4096 → whitespace-collapsed → ≤384 chars, surrogate-safe, must contain a letter/digit).
`labelFor(el)` (`st`): the nearest enclosing heading, else the nearest enclosing sectioning element (`section,article,aside,nav,main,form,fieldset,details,dialog,table,figure,[role=region],[role=group],[role=tabpanel],[role=dialog]`) named by `aria-label` / `aria-labelledby` / LEGEND / SUMMARY / CAPTION / FIGCAPTION, else the preceding heading in document order whose level is strong enough (binary search `Bt` + level logic `Re`). Returns `{label, key: cssPath(labelEl)+"|"+headingIndex (or "|s<n>"), ord}`. Host caps label 128 bytes (`Sr`) and key ≤1100 chars.

### 2.10 Constants and regexes in `_comments`

`qe=24` bg tolerance px; `Tt=5` drag threshold; `Ye=16` touch threshold; `ce=12` min marquee side; `kt=.85`, `Ke=.7` region coverage; `ze=8` max kids; `Qe=4096` children scanned; `Ce=32` text nodes per element; `Ze=4096` client rects scanned; `Pt=14` horizontal word slop; `Et=512` text-node window for word segmentation; `sn=512` words scanned when no caret; `un=384` label chars; `fn=2000` headings; `ve=128` label bytes; `pn=128` spans; `Me=512` quote chars; `vn=64` span rects; `yn=512` quote bytes; `Yt=16777216` max offset; `Ne=128` sig/doc queries; `wt=4096` sig text chars; `Xn=20` Hamming max; `An=512` findBySig elements; `Sn=262144` findBySig text budget; `Rn=16` backoff cap; `Ie=16` candidates; `Kt=32` scroll threshold. Regexes: id `/^#[A-Za-z_-][A-Za-z0-9_-]{0,31}$/`, data-id `/^[A-Za-z0-9_-]{1,64}$/`, tag `/^[a-z][a-z0-9-]{0,23}$/`, hash `/^[0-9a-f]{16}$/`, word fallback `/[\p{L}\p{N}\p{M}_'’-]+/gu` (uses `Intl.Segmenter` word granularity when available), served-doc root `/^\/_f\/[A-Za-z0-9_-]{1,64}(?=\/|$)/`, scroll container `/\b(?:auto|scroll|overlay)\b/`.

### 2.11 What a self-host must replicate for pins to work

1. Send `{__fc_mode:{on:true, composing, labels?, regions?, cursor?}}` from the parent (this also triggers lazy load); `{__fc_mode:{on:false}}` on exit.
2. Poll `{__fc_locate:{paths, sigs, docs, spans, labels?, regions?, cursor?}}` (~500 ms + on resize) and consume `__fc_rects` to position pins/highlights **in the parent** — the frame draws nothing. Convert viewport rects to parent coordinates by adding the iframe's bounding rect. Hold a rect for 2 missed polls before dropping.
3. Consume `__fc_click` to open a composer at `rect`/`pin`, and persist the anchor `{path, x, y, pin, span?, sig?, doc?, file?, label?, detail?, region?}`.
4. Consume `__fc_hover` / `__fc_marquee` to draw the highlight / drag rectangle; send `__fc_region` when a drag that started over the parent chrome ends.
5. Send `__fc_reveal {path, span?}` to scroll to a thread; `__fc_goto {file}` for multi-file artifacts; expect `__fc_doc {file}`.
6. Honour `__fc_escape`. Note the frame swallows all clicks while `on` — turn mode off to let the page be interactive.
7. For `customAnchors` pages: answer `__fc_ca`, send `__fc_threads` with aliased ids, consume `__fc_placed`/`__fc_open`/`__fc_exit`, and send `__fc_reveal {id}` with the alias.
8. Serve the frame from an origin whose `/_runtime/<file>.js` paths exist, and make `__frame_init.capabilities.comments` (with `config.customAnchors`, `config.composer_only`, `config.headless`, `token`, `optional`) reflect the declaration.

---

## 3. `_translate.5HCW4BJh.js` — in-page translation

### 3.1 Install and command protocol

`install(shellOrigin, firstCmd)`. Listens for parent messages at `shellOrigin`:

- `{__ft_cmd:{action:"probe"|"translate"|"revert", target?, engineHost?}}`. `target` is a BCP-47 tag validated `/^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/`, ≤35 chars, default `"en"`.
- `{__ft_xlr:{id:number, texts?:[string], error?:string}}` — reply to a frame→shell translation request.

Sends:

- `{__ft_status:{state, lang?, usable?, progress?:{done,total}, error?}}` with states `"idle" | "translated" | "translating" | "downloading" | "reverted" | "error"`.
- `{__ft_xl:{id:number, texts:[string]}}` — when `engineHost:true`, each text node is sent to the shell for translation (one text per request).

### 3.2 Text collection (`C()`)

`TreeWalker(document.body, SHOW_TEXT)` accepting text nodes whose parent is not `SCRIPT, STYLE, NOSCRIPT, TEXTAREA, IFRAME`, not inside an element with `translate="no"` (nearest `[translate]` wins) or `.notranslate, code, pre, kbd, samp, var`, and whose whitespace-collapsed data is non-empty. Shadow DOM is not traversed.

### 3.3 Source-language detection (`H()`)

`document.documentElement.lang` if set; else `self.LanguageDetector` (Chrome built-in AI): `create()` (5 s timeout) then `detect(first 1000 chars of all collected text joined)` (5 s); accept `detectedLanguage` if `confidence >= .5`. Cached per sample string.

### 3.4 Actions

- **probe**: if translating → `{state:"translating", lang, usable:true}`. Else `lang = detected`, `usable = already translated || (lang && base(lang) !== base(target) && any text nodes && Translator.availability({sourceLanguage:base(lang), targetLanguage:target}) in {available, downloadable, downloading} within 2.5 s)`. Reply `{state: translated? "translated":"idle", lang, usable}`. The host polls probe every 1.2 s up to 15 times per iframe until a usable answer arrives.
- **translate** (ignored while in flight): source = cached or detected; if none or same base language as target → `{state:"error", error:"no-source-lang"}`. Engine:
  - `engineHost:true` → uses shell round-trips (`__ft_xl`), 10 s per text, ≤100 000 chars per text; a `{error:"cap"}` reply or a timeout sets `L` (capped) and every remaining text resolves `""` (left untranslated). Other errors reject with `DOMException("shell engine error", name)` where name must match `/^[A-Za-z][A-Za-z-]{0,39}$/` else `"unknown"`.
  - otherwise `self.Translator` in the frame: `availability` (2.5 s) must be usable else `{state:"error", error:"engine-unavailable"|"engine-timeout"}`; `create({sourceLanguage, targetLanguage, monitor})` with a 60 s inactivity timeout reset by `downloadprogress` events, which emit `{state:"downloading", lang, progress:{done:%, total:100}}`.
  - Then `{state:"translating", lang, progress:{done:0,total:N}}`; for each text node (sequentially): remember original in `d` (Map node→string), `translate(original)` with 10 s timeout, replace `node.data` if non-empty; progress every 4 nodes and at the end. If no node changed → restore state if this was the first pass and `{state:"error", error:"no-output"}`. Else set `lang` and `dir` attributes (`tt`): on `<html>` and on every `[lang]` / `[dir]` ancestor of a translated node (originals remembered in `N`/`P`), `dir` = `"rtl"` for `ar, ckb, dv, fa, he, iw, ji, ks, ps, sd, ug, ur, yi` or scripts `adlm, arab, aran, hebr, nkoo, rohg, syrc, thaa`; then `{state:"translated", lang:target}`.
  - Any throw → restore all text, `lang`/`dir`, `{state:"error", error: err.name|"unknown"}`.
- **revert** (ignored while translating): restore every node's original data, restore `lang`/`dir`, `{state:"reverted", lang: previousSource}`.

### 3.5 Host side (for completeness)

The host `Translate` button (rendered only when `boot.translateEnabled`, probe said usable and the base languages differ) prefers `engineHost:true` when the *host* has `globalThis.Translator`: it creates the translator itself (60 s create timeout, download progress UI), then answers `__ft_xl` requests: at most 32 texts per request (`dg`), each ≤100 000 chars (`fg`), a running cap of 4096 texts per engine (`mg` → `{error:"cap"}`), engine destroyed after 30 s idle (`pg`) or 10 min total (`hg`); errors `{error:"no-engine"|"bad-request"|"cap"|<DOMException name>}`. Otherwise it sends `{action:"translate", target: navigator.language}` and the frame uses its own `Translator`. "Show original" sends `{action:"revert"}`.

---

## 4. Cross-cutting notes for a self-hosted artifact host

- All frame→shell messages target `shellOrigin` exactly (the origin of the window that sent `__frame_init`); the shell must post from that origin and accept only from the iframe's `contentWindow`/`src` origin (the chrome bundle does `e.source !== iframe.contentWindow || e.origin !== new URL(iframe.src).origin` checks).
- `comments.js` RPC needs an ack within 130 s or a `__frame_cap_r`; use `__frame_cap_ack` for anything requiring a user prompt.
- `[data-uncommentable]` on any ancestor (including across shadow hosts) opts elements out everywhere (hover, click, marquee, locate labels, openComposer).
- Stable anchors: give elements `id` (≤32 chars, `[A-Za-z_-][A-Za-z0-9_-]*`) or unique `data-id` (≤64 chars) so paths are short and survive re-renders; the `sig` simhash (first 4096 chars of text, 4-gram FNV, Hamming ≤20) is the relocation fallback, and `doc` (document px) is the last-resort fallback for scrollable pages.
- The `__fc_*` and `__ft_*` handlers are absent from `frame-shell-*.js`; they live in `frame-shell-chrome-DzzMV3mP.js` (React UI), and the `cap:"comments"` RPC broker lives in the un-captured chunk `c26621f4a-CeTsb9NB.js`; the persistence API is `/api/frame/comments/{frameUuid}?org=…` (§1.9). Thread-data for public readers is also served as `/_f/<ver>/index.html.json?__frame_t=<assetToken>` (`commentsDataUrl`).
