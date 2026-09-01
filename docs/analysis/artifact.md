# `artifact.EF7sW8YL.js` — reverse-engineering report

Source: `/tmp/claude-0/-home-user-claude-artifact-harness/13d61d90-49c5-5a05-870a-a548d5b30678/scratchpad/pretty/artifact.EF7sW8YL.js` (4009 lines, minified then pretty-printed).
Contract: `/tmp/claude-0/bundled-skills/2.1.257/a330e2b3974d756d10bc6540893d9fe1/artifact-capabilities/0.2.32/artifact.d.ts`.

Everything below is taken from the code. Statements marked **[inference]** are conclusions not literally present in this file (e.g. behaviour of the host runtime that calls `install`).

Minified identifiers are quoted in brackets so findings can be located (`[$a]` = the install function, `[xa]` = the DOM-sync engine factory, `[Ns]` = files validator, `[Fs]` = morph applier, `[ta]` = replica-patch applier, `[Us]/[Xs]` = replica pairing, `[ws]` = the batch-builder/drain loop).

---

## 1. Module / install shape

```js
export { $a as install }
```

The module exports a single function `install(ctx)` `[$a]`. It is idempotent via a module-level flag `hi` — a second call returns immediately.

### 1.1 What `install(ctx)` reads from the runtime context `ctx` (`n`)

| Member | Use |
|---|---|
| `ctx.shellOrigin` | Target origin for every `parent.postMessage` and the required `event.origin` on replies. The reply listener uses strict `E.origin !== o` (so an undefined `shellOrigin` would never resolve a call — **[inference]** the runtime always supplies it). |
| `ctx.pipe("artifact")` | Returns an object with `wrap(name, fn)`. `publish`, `edit` (inner) and `sync` are wrapped: `g.wrap("publish", …)`, `g.wrap("edit", …)`, `g.wrap("sync", …)`. **[inference]** `wrap` is where the runtime injects the lifecycle rejections (`not_granted`, `capability_disabled`, `capability_removed`, `transform_error`) and any argument transforms — none of those codes are produced in this file except `transform_error` for a non-function `sync` argument. |
| `ctx.capabilities.artifact?.config ?? ctx.capabilities.self?.config` | The capability's declared config. `liveDoc = config !== null && typeof config == "object" && config.kind === "live_doc"`. |
| `ctx.hooks` | A mutable object; the sync engine sets `hooks.editBefore` and `hooks.edit` while armed and nulls them on teardown (only if still its own functions). |
| `ctx.changes.has("artifact-sync-reject")` | Feature-change gate `[Oa]`. When set, `edit`/`sync` on a non-live-doc page with no sync region reject `invalid_content` (see §3). |
| `ctx.flags.has("artifact_files")` | Feature flag `[_s]` enabling the files form of `publish`. |
| `ctx.mount(name, obj)` | Called twice with the same object: `ctx.mount("artifact", k)` and `ctx.mount("self", k)`. |

The engine factory `[xa]` additionally accepts optional test/instrumentation options that `install` does **not** pass: `isTrusted(e)` (defaults to `e.isTrusted`), `warn(msg)` (defaults to `console.warn`), `isActivated()` (defaults to `navigator.userActivation?.isActive === true`), `onBudget(dataId)`.

### 1.2 The mounted namespace object `k`

The object passed to `mount` is a plain object literal; **this module never calls `Object.freeze`** (**[inference]**: freezing is done by `mount`). Members:

| Member | Argument | Behaviour | Resolves | Rejects |
|---|---|---|---|---|
| `publish(html: string)` | string | `send("publish", [html])` — **no client-side doctype or size check**. | `result` verbatim from shell (per d.ts `{version}`) | shell `error` verbatim; `upstream_error` on 130 s timeout; `invalid_content` if args not cloneable |
| `publish(files: Record<string, PublishFile\|null>)` | non-string | Validated by `[Ns]` (§3.1); on success `send("publish", [files])` where `files` is a null-prototype object mapping `path → null \| {content: string\|Blob, contentType: string}`. | as above | `[Ns]` errors (sync, as `Promise.reject`) or shell error |
| `edit(ops)` | anything (not validated client-side) | If `rejectClassic()` is true → reject; else `send("edit", [ops])` through the wrapped inner `C`. | `result` verbatim (d.ts: `{seq, created}`) | see §3 |
| `sync(fn)` | function | Non-function → reject `{code:"transform_error", message:"sync takes a function"}`. Otherwise `await engine.sync(fn)` then, if `rejectClassic()`, reject. | `undefined` | `{code, message: "sync: the changes were not saved (<code>)"}` from the engine, or the classic rejection |

`rejectClassic()` `[a]` = `changes.has("artifact-sync-reject") && !liveDoc && document.readyState !== "loading" && !engine.hasSyncRegion()`; its error `[p]`:

```js
{ code: "invalid_content", message: "this artifact is not a live doc and has no sync region, so there is nothing to save" }
```

Note `edit` is `E => a() ? Promise.reject(p()) : C(E)` — the outer function is *not* itself `wrap`ped, but `C` (`g.wrap("edit", …)`) is, so wrap semantics still apply to the shell call.

The engine object returned by `[xa]` has more members (`sync`, `stats()`, `hasSyncRegion()`, `sizes()`, `dispose()`) but only `sync` and `hasSyncRegion` are used by `install`; none are exposed on `window.claude`.

---

## 2. Wire protocol (window.postMessage with the parent shell)

All messages go `parent.postMessage(payload, shellOrigin)`. Every inbound handler requires `e.source === parent`; the engine handlers additionally require `isTrusted(e)` and, when `shellOrigin` is defined, `e.origin === shellOrigin` (`[pr]`, `[mr]`, `[vr]`, `[hr]`); the capability-call reply listener requires `E.origin === shellOrigin` (strict) but does **not** check `isTrusted`.

### 2.1 Capability RPC (`install` scope)

**Sent** — one per `publish`/`edit` call `[d]`:

```js
{ __frame_cap: true, cap: "artifact", id: "s" + (++counter), method: "publish" | "edit", args: [ … ] }
```
- `args` is `[html]`, `[files]` or `[ops]`.
- Correlation: `id` is `"s1"`, `"s2"`, … (module-local counter).
- Timeout `[Ca] = 130000` ms → pending entry deleted, reject `{code:"upstream_error", message:"no reply from shell"}`.
- If `postMessage` throws (non-cloneable args) → reject `{code:"invalid_content", message:"arguments must be cloneable"}`.

**Received**:

```js
{ __frame_cap_r: true, id: string, error?: any, result?: any }
```
- Matched by `id`; unknown ids ignored. `error !== null && error !== undefined` → `reject(error)` (object passed through untouched — **[inference]** shape `{code, message, live?}` per d.ts); otherwise `resolve(result)`.

### 2.2 Engine handshake (sent once at engine construction, only if `shellOrigin` is defined)

```js
{ __frame_morph_ready: true, arms: ["move"] }       // always ([As] = ["move"])
{ __frame_replica_ready: true }                      // only when liveDoc
```

### 2.3 Co-writer structural edits — `__frame_morph` (handler `[pr]`, installed at construction)

**Received**:
```js
{ __frame_morph: { seq: number /*safe int*/, elements: MorphElement[] /*1..64*/ } }
```
`MorphElement` (validated by `[Ms]`+`[Is]`):
```ts
{
  target: string;                         // /^[A-Za-z0-9_-]{1,64}$/   [tt]
  text?: string;
  attrsSet?: Record<string /* /^[a-zA-Z_:][a-zA-Z0-9_:.-]{0,127}$/ [Zr] */, string>;
  attrsRemoved?: string[];                // same name regex
  // at most one of:
  create?: { tag: string /* /^[a-z][a-z0-9-]{0,63}$/ [yi] */, parent: id, prev?: id, next?: id };
  remove?: true;                          // then no attrsSet/attrsRemoved/text
  move?:   { parent: id, prev?: id, next?: id };   // then no attrsSet/attrsRemoved/text
}
```
Processing: malformed → reply `__frame_patch_miss` with the seq if it is a safe integer, else silent. `seq <= lastSeq [Ve]` → ignored. Otherwise: fence (`[Rt]`), apply with `[Fs]` (§7.9), then `[ln](elements, seq)` clears local dirty state for the touched targets and records the seq in `At` (≤64). If apply threw or `missed` → `__frame_patch_miss`. On success `Ve = seq` and:
```js
document.dispatchEvent(new CustomEvent("claude:edit", { detail: { seq, targets: applied /* string[] */ } }))
```

**Sent** on any failure:
```js
{ __frame_patch_miss: { seq } }
```

### 2.4 Replica pairing / exact patches (handler `[mr]`, installed at construction)

**Received** `__frame_replica_pair`:
```js
{ __frame_replica_pair: { seq: number, nodes: EngineNode[], caps?: string[] /* ≤16 kept */ } }
```
`EngineNode` (validated by `[Ps]`, ≤ 200 000 nodes total):
```ts
{ id: string /* /^[^\0]{1,200}:[0-9]{1,18}$/ [qs] */, kind: string /* "element"|"text"|"comment"|"doctype"|"other" */,
  tag: string, dataId?: string, text?: string, children: EngineNode[] }
```
The engine tree is paired against `document.childNodes` by `[Us]` (see §7.10). Result sets the node map `J`, rebuilds the shadow text model, stores `caps` as `yn` (known values used: `"html"`, `"stage"`), updates `Ve = max(Ve, seq)`.
**Sent** reply:
```js
{ __frame_replica_paired: { seq, ok: boolean, reason?: string } }
```
Reasons seen: `"malformed pairing"`, `"the engine has no nodes"`, ``engine <kind>[:tag][[dataId]] has no counterpart under <el|the document>``.

**Received** `__frame_replica_pair_subtree` (no reply):
```js
{ __frame_replica_pair_subtree: { target: string /* data-id */, node: EngineNode } }
```
Requires `J !== null`; re-pairs the subtree under `[data-id=target]` with `[Xs]`, stamping `dataId` from engine nodes onto unstamped elements (`setAttribute("data-id", …)`). Failure only bumps `stats.unsynced`.

**Received** `__frame_replica_patches`:
```js
{ __frame_replica_patches: { seq: number, patches: Patch[] /* ≤ 200000, each {op: string, …} */ } }
```
`Patch` ops handled by `[ta]`:
```ts
| { op: "reset" }                                        // always refused → re-pair
| { op: "text", node: id, pos: uint, del: uint, ins: string }   // code-point offsets
| { op: "value", node }                                  // refused ("interpreted content")
| { op: "retag", node, tag }                             // refused ("re-pair")
| { op: "set-attr", node, ns: "", key, val }
| { op: "del-attr", node, ns: "", key }
| { op: "remove", node }
| { op: "insert", node, parent: id | ":0", index: uint, subtree?: SubtreeNode }   // no subtree = move of a known node
```
`SubtreeNode` = `{ id, kind: "text"|"comment"|"element", text?, tag, ns: "", attrs: [ns, name, value][], children }`. `":0"` `[Bs]` names the document root (insert there is refused).
Processing: malformed → `J = null` and `__frame_patch_miss {seq}` (no reason). `seq <= Ve` → ignored. `J === null` → `__frame_patch_miss {seq, reason:"unpaired"}`. Else fence, apply; on failure `J = null` and `__frame_patch_miss {seq, reason}`; on success `Ve = seq`, trailing-space fix (§7.11), `claude:edit {seq, targets}`, and 2×`setTimeout(0)`+rAF later the touched bare elements are re-snapshotted and a flush is scheduled.

**Sent**:
```js
{ __frame_patch_miss: { seq, reason?: string } }
```

### 2.5 Staged (uncommitted) edits — sent by `[lo]`

Only when paired (`J !== null`), `caps` includes `"stage"`, and not disabled. Debounced 60 ms, ≤ 64 ops per message:
```js
{ __frame_local_edit: { ops: (
    { op: "set-text", target, text, base? } |
    { op: "set-html", target, tag, html }          // only with caps "html"
  )[] } }
```
Target origin: `shellOrigin ?? lastSeenShellOrigin`. **[inference]** This is a live preview of in-progress typing; the committed write still goes through `edit`.

### 2.6 Applied-edit notifications — `__frame_patch` and hooks (handler `[hr]`, installed on arm)

**Received**:
```js
{ __frame_patch: { seq: number, elements: (string | MorphElement-like)[] } }
```
If `seq` is already in the `ft` set (seen via `hooks.editBefore`) it is ignored; else fence + `[ln](elements, seq)`.

Hooks set on `ctx.hooks` while armed:
- `hooks.editBefore = [gr]` — called with `{seq, elements}`; records `seq` in `ft` (≤64) and `elements` in `dt` (≤64), fences, marks each `elements[i].target` element as co-writer-applied (`at`).
- `hooks.edit = [yr](seq, appliedTargets: string[], failedTarget?: string)` — takes the recorded elements for `seq`, keeps the prefix whose `.target` equals `appliedTargets[i]` and stops at `failedTarget`, then `[ln]` on that prefix.
- `document.addEventListener("claude:edit", [wr], true)` — for a `claude:edit` whose `detail.seq` is unknown to `At`/`ft`, runs `[ln](detail.targets)` then fences.

**[inference]** The base runtime applies the shell's `__frame_patch` deliveries itself (for Claude's ordinary `edit`s), invoking these hooks before/after and dispatching `claude:edit`; this module only uses them to discard its own stale dirty state so a page re-render cannot roll back a co-writer.

`[ln]` semantics: for each entry (string id or object with `target`): pure `move` entries are skipped; if the entry has no `attrsSet`/`attrsRemoved`/`text` or has `create`/`remove` → clear **all** dirty attrs/text/parked/lane state for that element; otherwise clear only the named attrs, and for `text` set the element's known baseline `a` to `text`, drop pending text, and mark undo as unsafe if the element is contenteditable.

### 2.7 Translation command (handler `[hr]`)

```js
{ __ft_cmd: { action: "translate" } }   // → disable sync with why "translated"
```
Any other `__ft_cmd` value is ignored.

### 2.8 Diagnostics (handler `[vr]`, installed at construction)

**Received**:
```js
{ __frame_diag_reveal: { id: string /* data-id, 1..128 chars */ } }
{ __frame_diag_probe:  { id: number /* safe int */ } }
```
Reveal: `scrollIntoView({block:"center", inline:"nearest", behavior:"instant"})` and a fixed overlay `<div data-frame-diag-reveal style="position:fixed;pointer-events:none;z-index:2147483647;outline:2px solid rgba(255, 106, 0, 0.95);outline-offset:2px;">` appended to `documentElement` for 1000 ms.

**Sent** reply to probe:
```js
{ __frame_diag: { id,
    // stats [c]:
    sent, calls, droppedUngestured, unsynced, lost, scriptBuilt, taintedRegions, noop, budgeted, parkedGone, armed, disabled,
    disabledWhy?,           // only when disabled
    dirtyAttrs, dirtyText, added, removed, pending, parked, draining, fenced, fenceTyped,
    stagedHosts, stagePending, paired, mapped, lastSeq,
    refusal?,               // last invalid_content message (≤200 chars)
    caret?,                 // data-id of the element holding the caret/focus
    dirtyIds: string[] /*≤32*/, stagedIds: string[] /*≤32*/,
    applied: { seq, ids: string[] /*≤32*/, ok }[]  /* last 48 replica-patch applications */ } }
```

### 2.9 Summary table of message keys

| Direction | Key | Payload |
|---|---|---|
| → shell | `__frame_cap` | `{__frame_cap:true, cap:"artifact", id, method, args}` |
| ← shell | `__frame_cap_r` | `{__frame_cap_r:true, id, error?, result?}` |
| → shell | `__frame_morph_ready` | `{__frame_morph_ready:true, arms:["move"]}` |
| → shell | `__frame_replica_ready` | `{__frame_replica_ready:true}` |
| ← shell | `__frame_morph` | `{seq, elements[]}` |
| ← shell | `__frame_patch` | `{seq, elements[]}` |
| ← shell | `__frame_replica_pair` | `{seq, nodes[], caps?}` |
| → shell | `__frame_replica_paired` | `{seq, ok, reason?}` |
| ← shell | `__frame_replica_pair_subtree` | `{target, node}` |
| ← shell | `__frame_replica_patches` | `{seq, patches[]}` |
| → shell | `__frame_patch_miss` | `{seq, reason?}` |
| → shell | `__frame_local_edit` | `{ops[]}` |
| ← shell | `__ft_cmd` | `{action:"translate"}` |
| ← shell | `__frame_diag_reveal` | `{id: string}` |
| ← shell | `__frame_diag_probe` | `{id: number}` |
| → shell | `__frame_diag` | `{id, …stats}` |

---

## 3. Error codes produced in this file and their conditions

Codes that only arrive from the shell (`conflict`, `not_writer`, `not_declared`, `too_large`, `read_only_path`, `rate_limited`, `consent_required`, and the wrap-injected `not_granted`/`capability_removed`) are passed through verbatim from `__frame_cap_r.error`.

### 3.1 `publish` — files-form validation `[Ns]` (rejected before any message is sent)

| code | message | condition |
|---|---|---|
| `invalid_content` | `publish takes an HTML string or an object mapping file paths to contents` | arg is `null`, non-object, or an array |
| `capability_disabled` | `publishing files is not available in this view` | flag `artifact_files` not set |
| `invalid_content` | `files must be plain data` | `Object.entries(files)` throws, or reading `.content`/`.contentType` of an entry throws |
| `invalid_content` | `files names no paths` | zero entries |
| `invalid_content` | `files names more than 256 paths` | > 256 entries |
| `invalid_content` | `a file path must not be empty` | key `""` |
| `invalid_content` | `<path>: content must be a string or a Blob` | content not string/Blob |
| `invalid_content` | `<path>: contentType must be a bare media type such as text/plain, with no parameters` | `contentType` given but not a non-empty string, or contains `;` |
| `invalid_content` | `<path>: the blob must be plain bytes` | reading `blob.type` throws |
| `invalid_content` | `<path>: cannot infer a content type from the name; pass {content, contentType}` | no `contentType`, blob type empty, and extension not in the table |

Content-type resolution order: explicit `contentType` → `blob.type.split(";")[0].trim()` if non-empty → extension table `[ks]` (§4). A `null` value means delete. **Not checked here**: string content with a non-text type, total size, doctype (all shell-side).

### 3.2 RPC transport `[d]`

| code | message | condition |
|---|---|---|
| `upstream_error` | `no reply from shell` | no `__frame_cap_r` within 130 000 ms |
| `invalid_content` | `arguments must be cloneable` | `parent.postMessage` threw |

### 3.3 `edit` / `sync` gate

| code | message | condition |
|---|---|---|
| `invalid_content` | `this artifact is not a live doc and has no sync region, so there is nothing to save` | `changes.has("artifact-sync-reject")` && not live doc && document loaded && no `artifact-sync`/`[artifact-sync]` element |
| `transform_error` | `sync takes a function` | `typeof fn !== "function"` |
| `<code>` | `sync: the changes were not saved (<code>)` | the engine's drain returned a non-null error code (last failing batch's code) |

### 3.4 Engine internal `[Es]` (never surfaces directly to page code except via `sync` and `claude:sync-lost`)

| code | condition |
|---|---|
| `upstream_error` (`message: "edit timed out"`) | `ctx.edit(ops)` did not settle within 60 000 ms `[pa]` |
| `conflict` | returned after 5 attempts are exhausted |

Lifecycle set `[ga]` = `not_writer, not_granted, not_declared, capability_disabled, capability_removed, consent_required` → **disable** the engine permanently for the view (`[fo](code)`), return code. `invalid_content` → stored as `refusal` (message truncated to 200), and if the message matches `/not a live doc/i` → disable with why `"classic"`. `rate_limited` → sleep 1500 + rand·1500 ms and retry (counts toward the 5 attempts). `conflict` → up to 3 retries `[ha]` with 40·n ms sleeps. Any other code → returned as-is.

### 3.5 Disable reasons (`why` in `claude:sync-off`, `disabledWhy` in diag)

View-wide (`[fo]`): any code in `[ga]`, `"classic"`, `"translated"`. Element-level (`[Un]`): `"script-built"`, `"pasted"`.

---

## 4. Constants, limits, regexes

### 4.1 Numbers

| Name | Value | Meaning |
|---|---|---|
| `[Ca]` | 130 000 ms | shell RPC reply timeout |
| `[pa]` | 60 000 ms | `edit` timeout inside the engine drain |
| `[Qe]` | 32 | max ops per engine `edit` batch |
| `[ia]` | 16 | max non-marker attrs on an engine-emitted `create-element` |
| `[fa]` | 1500 ms | default-lane attribute coalescing delay |
| `[pt]` | 60 | default-lane writes per element per window before budgeting |
| `[vo]` | 60 000 ms | budget window |
| `[Eo]` | 600 ms | typing settle: value-only batches wait this long after the last key event |
| `[ma]` | 2000 ms | minimum interval between script-built rescans (`[Ir]`) |
| initial rescan | 2050 ms after DOMContentLoaded (`setTimeout(Ir, 2050)`) | |
| `[ha]` | 3 | max conflict retries |
| attempts | 5 | outer retry loop in `[Es]` |
| rate-limit sleep | 1500 + random·1500 ms | |
| conflict sleep | 40·attempt ms | |
| backoff `[gn]` | 2000 ms → ×2 → cap 30 000, + random·500 | re-drain after a transient failure (`claude:sync-lost`); reset to 2000 on `online` |
| stage debounce | 60 ms; ≤ 64 ops | `__frame_local_edit` |
| `[ui]` | 2000 | max list length for the LCS pairing (`[_o]`); longer lists are not paired |
| `[di]` | 512 | max secret ids remembered per sessionStorage list |
| `Na` text key | first 256 chars of trimmed textContent | re-render pairing key |
| morph `elements` | 1..64 | `[Rs]` |
| engine nodes | ≤ 200 000 | `[Ps]` |
| replica patches | ≤ 200 000 | `[Hs]` |
| `At`/`ft`/`dt` | 64 entries each | seen-seq rings |
| `kt` | 48 entries, 32 ids each | diag `applied` log |
| `caps` | first 16 strings | |
| files publish | ≤ 256 paths | |
| diag reveal id | ≤ 128 chars; overlay 1000 ms | |
| reveal z-index | 2147483647 | |
| flush scheduling | 2 nested `setTimeout(0)` (and rAF for fence release) | |

### 4.2 Regexes / sets

```js
tt  = /^[A-Za-z0-9_-]{1,64}$/            // a minted data-id
Zr  = /^[a-zA-Z_:][a-zA-Z0-9_:.-]{0,127}$/ // attr names in inbound morph payloads
yi  = /^[a-z][a-z0-9-]{0,63}$/           // creatable tag name
qs  = /^[^\0]{1,200}:[0-9]{1,18}$/       // replica engine node id
sa  = /^[a-z][a-z0-9_:-]{0,127}$/        // attr name capturable from the DOM (lowercase only)
aa  = /^on|^srcdoc$|^formaction$/         // never captured (tested on lowercased name)
$i  = /(^|\s)(cc-|one-time-code|current-password|new-password)/i   // secret autocomplete
/^(password|hidden|file)$/                // secret input types (Ft); set Ci = {password, hidden, file}
/\u00a0/g → " "                        // NBSP normalisation in text diffs ([mi], [Ys])
```

Sets:
- `[xs]` in-place patchable attributes (`nt(name)` = `data-*` | `aria-*` | this set): `class hidden value checked style title alt placeholder lang dir role tabindex disabled readonly contenteditable open colspan rowspan`.
- `[gi]` elements whose text is never edited/moved (HTML ns): `script style iframe noscript noframes noembed xmp plaintext template title textarea object embed`; SVG ns: `script style` `[Cs]`. `gt(el)` = HTML and not in `gi`, or SVG and not in `Cs`; other namespaces → false.
- `[Ls]` `svg math` and `[vi]` `html head body frameset` — never creatable (`ko`), and `vi` never removed/moved/text-edited (`Wt`).
- `[$o]` elements never captured as created and whose attrs are never captured: `script iframe object embed base meta link style frame frameset noscript noembed noframes xmp plaintext`; `[va]` subset that is never re-created even from a snapshot: `script iframe frame frameset base meta link`.
- `[Oi]` "script-like" (`wo`, `Ce` = has such an ancestor): `script style iframe xmp plaintext noscript noembed noframes frameset`.
- `[zs]` selector that blocks a morph `move`: `script,style,iframe,object,embed,template`; `[Gs]` blocks a replica move: `script style iframe object embed`.
- `[hs]` inline editing hosts where Enter becomes a line break: `p h1 h2 h3 h4 h5 h6 span a b i em strong small u s code label legend summary dt q cite mark`.
- Discrete events `[li]` (listened capture+passive): `click contextmenu copy cut auxclick dblclick dragend dragstart drop input keydown keypress keyup mousedown mouseup paste pointercancel pointerdown pointerup submit touchcancel touchend touchstart change textInput compositionstart compositionend compositionupdate beforeinput dragover`.
- Pure-gesture subset `[la]` (no activation check): `click contextmenu auxclick dblclick dragend dragstart drop dragover keydown keypress keyup mousedown mouseup pointercancel pointerdown pointerup touchcancel touchend touchstart`.
- `[ca]` `input beforeinput change` count when the target is `<input>/<select>/<textarea>` (`ua`); otherwise (and for the remaining `li` events) `navigator.userActivation.isActive` must be true.
- Continuous events `[fi]` that end the discrete lane: `pointermove mousemove touchmove scroll wheel drag dragenter dragleave dragexit mouseover mouseout pointerover pointerout`.
- `[ci]` typing events that set the settle clock: `keydown keyup beforeinput input`.
- `[da]` paste/drop inputTypes: `insertFromPaste insertFromPasteAsQuotation insertFromDrop`.
- `[ya]` `dragover drop` keep the remembered drag-source host.
- `[Ci]` secret input types; `[ba]` expando `"__artifactSecret"`.

### 4.3 Extension → content type table `[ks]`

`html,htm→text/html; css→text/css; js,mjs→text/javascript; json→application/json; webmanifest→application/manifest+json; txt→text/plain; md→text/markdown; xml→application/xml; svg→image/svg+xml; png→image/png; jpg,jpeg→image/jpeg; gif→image/gif; webp→image/webp; avif→image/avif; ico→image/x-icon; woff→font/woff; woff2→font/woff2; ttf→font/ttf; otf→font/otf; mp3→audio/mpeg; wav→audio/wav; mp4→video/mp4; webm→video/webm; pdf→application/pdf; wasm→application/wasm`.
`[Ss]`: extension = text after the last `.` that comes after the last `/`; a leading-dot name (`.env`, `dir/.x`) or no dot → undefined. Lowercased before lookup.

### 4.4 Storage keys / attribute / selector strings

```js
"__artifact_sync_secret_ids"        // sessionStorage: JSON string[] of secret+typed ids (≤512 each list)
"__artifact_sync_secret_ids_typed"  // sessionStorage: JSON string[] of ids the viewer typed into
"artifact-sync" [Y]  "artifact-local" [me]  "artifact-sync-state" [mt]  "data-id" [G]  "data-local-" [Ao]
Ge  = "artifact-sync,[artifact-sync]"
xi  = Ge + ",artifact-local,[artifact-local]"
Ws  = 'artifact-local,[artifact-local],artifact-sync,[artifact-sync],[artifact-sync-state="off"]'   // capture-scope boundary (Ei)
bn  = ':is(:not([data-id]),[data-id=""])'
ra  = '[data-id]:not([data-id=""]),' + xi
"data-frame-diag-reveal"
```
Injected style on arm: `<style>artifact-sync,artifact-local{display:contents}</style>` appended to `<head>`.

---

## 5. DOM sync engine `[xa]` — lifecycle

### 5.1 Construction (runs inside `install`, before `mount`)

1. `[Aa]` defines custom elements `artifact-sync` and `artifact-local` (if not defined). Each: `this.__syncStates = this.attachInternals().states` (best effort), `connectedCallback → ht?.connected(this)` (arms the engine when a sync element connects), getter `saving` → `ht?.saving(this) ?? false` (true iff the element is a sync marker, not tainted, engine not disabled).
2. If `document.readyState !== "loading"`: `[hn]` adopt `<body>` (§5.2) and `[ro]` secret-input scan.
3. Listeners (all on `window` unless noted): `beforeinput` capture ×4 (`un` paste/drop detection, `zr` Enter-in-inline, `Hr` undo guard, `Jt` typed-fence marker), `input` capture (`Jt`, `un`), every `[li]` event → `[ur]` `{capture:true, passive:true}`, every `[fi]` → `[fr]` `{capture:true, passive:true}`, `pointercancel` capture + `blur` → `[sn]` (clears pointer-down), `input`/`change` capture → `[mn]` (input mirroring), `paste` → `[Or]`, `drop` → `[Cr]`, `message` capture → `[pr]`, `[mr]`, `[vr]`.
4. If `shellOrigin` defined: post `__frame_morph_ready`, and `__frame_replica_ready` when `liveDoc`.
5. `DOMContentLoaded` (once) or immediately → `[io]`: `hn()`, `ro()`, `qt()` (arm if a sync region exists), `setTimeout(Ir, 2050)`.

### 5.2 Body adoption `[hn]` (live docs only)

Only when `liveDoc === true`, not disabled, and this engine owns `ht`. If `<body>` has neither marker and `<html>` has neither marker: `body.setAttribute("artifact-sync", "")` (observer suspended via `[fe]`), remember `oe = body` and `Bn.add(body)`. If the adopted body is later disconnected, the attribute is removed and `oe` reset. On teardown the attribute is removed only if its value is still `""`.

With an adopted body, an element that is a **direct child of body with no data-id and no descendant with a data-id** (`[Zo]`) is *not* in the sync region (`te()` false) — script-appended toasts/portals stay local — and adding such an element logs once:
> `<artifact-sync>: an element appended straight to <body> (<tag>) stays in this view only - toasts and overlays belong there. To add to the shared document, append inside one of the page's served elements instead.`

### 5.3 Arming `[qt]`/`[ps]`

`qt()` arms when: not armed, not inside a paste/drop window, `readyState !== "loading"`, and `document.querySelector("artifact-sync,[artifact-sync]") !== null`. Called from `io`, from every gesture (`ur`), from custom-element connection, and from `sync()`.

`ps()`:
- `stats.armed = true`; inject the `display:contents` style;
- `X = new MutationObserver(he); X.observe(document, { subtree:true, childList:true, attributes:true, attributeOldValue:true, characterData:true, characterDataOldValue:true })`;
- `addEventListener("message", hr, true)`; set `ctx.hooks.editBefore = gr`, `ctx.hooks.edit = yr`; `document.addEventListener("claude:edit", wr, true)`; `visibilitychange` (document) and `pagehide` (window) → `[an]`;
- run the script-built scan `[Mr]`; snapshot baseline text `a[el] = textContent` for every bare (no element children) `[data-id]` element.

### 5.4 Teardown `[Yr]` (on disable or `dispose`)

Disconnects both observers, clears all timers/maps, removes all listeners registered in §5.1 and §5.3, nulls the hooks if still its own, closes the MessageChannels, removes the body attribute it added, and releases `ht`.

---

## 6. Gesture window, capture predicate, lanes

### 6.1 Gesture handler `[ur]`
For a trusted event whose type qualifies (§4.2): flush pending observer records; on `dragstart` remember the editing host being dragged from if it is outside a sync region (`ct`); `pointerdown` → `st = true`; `pointerup|pointercancel|drop|dragend` → `st = false`; `hn()`; arm if needed; if a `[ci]` typing event targets a synced node → `Ot = Date.now()`; `vt = false`; `xn = true` (discrete lane), `On = true` for pure gestures; schedule end-of-task `[It]` via a MessageChannel message **and** rAF **and** `setTimeout(0)`; `[Ir]` (rescan if > 2 s since last); `[Zi]` (`St = true`, then after two nested `setTimeout(0)` → `[cr]`: mirror touched inputs, flush records, `St = false`, `[Be]` drain).

### 6.2 Capture predicate
In `[he]`, mutations are captured iff `Bi()` = `(St || st || it > 0) && !qe`, i.e. inside the post-gesture window, while a pointer is held down, or inside `sync(fn)` — and not while a co-writer patch is being applied (fence `qe`). Uncaptured mutations inside sync regions are counted in `stats.droppedUngestured` (the "not a gesture" rule of the d.ts).

### 6.3 Lanes
`[Vi]()` = `"discrete"` if `it > 0 || xn` (same task as the gesture event, or inside `sync`), else `"default"`. Continuous events (`[fi]`) call `It()` immediately, so writes from pointermove/scroll handlers are `default`. There is no `continuous`/`transition`/`idle` lane in code — `idle` content (`artifact-local`, `data-local-*`, `open` on details/dialog) is simply skipped in `he`.

Per-element lane maps: `B` (attr → lane), `Q` (text lane), `Lo` (lane of an added element). Default-lane handling happens in the drain (§8.4):
- attribute: parked in `ee[el][attr] = {v, lane, why:"coalesce", due: now+1500}` unless it is an input `value`/`checked`, the attr was already coalesced once (`Ue` set keyed by `"<id>\0<attr>"`), or the page is hiding (`vt`) — then it goes out immediately;
- budget: if `[ar](el)` (≥ 60 default-lane journaled writes in the last 60 s per element, log `ke`) → parked with `why:"budget", due: Infinity`; released by `[Zn]` = timestamp of the 60th most recent write + 60 s. First time an element hits the budget, warn once and call `onBudget(id)`:
  > `<artifact-sync>: <tag data-id="…"> changed 60 times in a minute from the page's own timers - not from a gesture. Only its latest value now reaches the shared document, at most 60 writes a minute; mark such state with data-local-* attributes or an <artifact-local> element.`
- text on default lane over budget → parked in `ae[el]`.
- Parked writes on disconnected elements are dropped at the next forced release (`stats.parkedGone`).
- `pagehide`/hidden → `vt = true`, release everything parked immediately and drain.

---

## 7. What is captured, what is ignored, how co-writer edits are applied

### 7.1 Region resolution
- `se(el)` → `"local"` if `localName === "artifact-local"` or has attribute `artifact-local`; `"sync"` for `artifact-sync`; else `null`.
- `Ze(node)` = closest `artifact-sync,[artifact-sync],artifact-local,[artifact-local]` (of the node or its parent for text nodes).
- `te(node)` (synced) = `Ze(node)` exists and is `sync`, no tainted (`artifact-sync-state="off"`) ancestor between node and that region (`[Qo]`), and not the adopted-body local-child case (§5.2). Innermost marker wins (nesting both ways works as the d.ts says).
- `[Ei]` capture-scope boundary for moves: parent's closest `Ws` (which includes `[artifact-sync-state="off"]`) must equal the target's.

### 7.2 Mutation handling `[he]` (per record)
**attributes**: skipped outright if name is `data-id`, one of the three marker attributes, starts with `data-local-`, or is `open` on `<details>/<dialog>`. Old value remembered. Must be `te()`. Skipped (no journal) when the element is a `[$o]` tag or inside script-like (`bo`), the attr is `type`/`autocomplete` on `input/textarea/select/button` (`zt`), or `value`/`checked` on a secret input (`[Fe]`). Otherwise `dirtyAttrs[el][name] = getAttribute(name)` + lane.

**characterData**: parent element must be `te()`; if not inside script-like, mark text dirty (`g[el] = textContent`), stage (`[lo]`), set lane.

**childList**: removed elements with a data-id are recorded in `I[id] = {node, parent, next}` (unless a same-id sibling remains, or they were pending). Added elements go to `E` (and all descendants to `x`) with the lane; adding an element that has no non-empty `data-id` into a sync region resets the rescan clock (`zn = 0`) so the script-built scan runs on the next gesture. Text-node adds/removes mark the parent text-dirty. During a paste/drop window (`Dt()`), elements inserted into a sync region from outside are stripped of `data-id` and their sync markers are switched off with why `"pasted"` (`[Sr]`); html/uri/file drops into a sync region are converted to a text node (`[kr]` + `replaceWith(createTextNode)`).

### 7.3 Attribute name rule for outbound writes `[_n]`
name.toLowerCase() is not `data-id`, not a marker, does not start with `data-local-`, matches `/^[a-z][a-z0-9_:-]{0,127}$/` (**case-sensitive lowercase**), and does not match `/^on|^srcdoc$|^formaction$/`. `artifact-sync`/`artifact-local` and `type`/`autocomplete` are carried on `create-element` without counting toward the 16-attr cap.

### 7.4 Secrets
`[Ft](el, attr)`: `data-id` is never written; `value`/`checked` are never written when `el.__artifactSecret === true`, `type ∈ {password, hidden, file}`, or the `autocomplete` attribute/property matches `[$i]`. Additionally `:autofill`/`:-webkit-autofill` matches mark an input secret (`[Do]`), and secret ids are remembered in `sessionStorage` (§4.4) so re-created inputs (after a re-render) stay secret; ids the viewer *typed* into are kept in the "typed" list. `[Ae]`: any input under an ancestor whose id is in the secret sets is also secret. On co-writer create/set-attr, `value`/`checked` for such ids are silently skipped (`[So]`).

### 7.5 Input mirroring `[pn]`
On trusted `input`/`change`: checkbox/radio → `toggleAttribute("checked", el.checked)` (observer suspended) and journal `checked` = `""`/removed on lane `discrete`; a checked radio unchecks siblings with the same `name` and `form` inside the closest sync region (or document) and journals their `checked` removal; other inputs → `setAttribute("value", el.value)` and journal `value` (`discrete`). `<textarea>`/`<select>` values are not mirrored (matches the d.ts).

### 7.6 Re-render reconciliation `[tr]/[nr]/[Xi]`
When a gesture replaced a container's children (`innerHTML = …`): removed stamped elements are paired with added unstamped ones by LCS (`[_o]`, lists ≤ 2000) first on key `Na` = `"<tag> <region|-> [k<data-key|id>]"` + `"t<first 256 trimmed chars>"` when no key, then on `Oo` (tag/region/key only). A pair re-stamps the old `data-id` onto the new element (observer suspended), moves lane/parked/budget state, diffs attributes (order-insensitive for `class`) and text, and recurses into children. Unpairable adds become `create-element`; unpaired removes become `remove`.

### 7.7 Script-built detection `[Mr]`
Runs on arm, ≥ 2 s after the previous run on each gesture, and 2050 ms after load. For every element matching `artifact-sync :is(:not([data-id]),[data-id=""]), [artifact-sync] :is(…)` whose parent's region is sync, that is not pending/refused/added-by-gesture, not inside `[contenteditable]:not([contenteditable="false" i])` or `<head>`, and not the adopted-body local case: the nearest ancestor with a non-empty `data-id` or marker (or, under the adopted body, the body-child) is switched off:
- `setAttribute("artifact-sync-state", "off")`, `__syncStates.add("off")`, and
- `el.dispatchEvent(new CustomEvent("claude:sync-off", { bubbles: true, detail: { why: "script-built" } }))`.
Once per new taint batch: console warning (text in `[Mr]`, begins `<artifact-sync>: a script rendered elements into shared markup (found without a server id). Saving is OFF inside the element holding them in this view …`) and `claude:sync-dropped {reason:"script_built", count, scriptBuilt: count}`. Moving/copying a switched-off element by gesture is dropped with a one-time warning `[Vn]`.

### 7.8 Other viewer-facing behaviours
- Paste into contenteditable inside a sync region: `preventDefault`, plain text inserted with `execCommand("insertText")` (fallback: range replace). Drops carrying `text/html`, `text/uri-list` or `Files` are likewise reduced to `text/plain` at `caretPositionFromPoint`/`caretRangeFromPoint`.
- Enter (`insertParagraph`) in an inline host (`[hs]`) that is synced and stamped → `preventDefault` + `execCommand("insertLineBreak")`, one warning `[zr]`.
- After a co-writer changed text in a contenteditable, `historyUndo`/`historyRedo` are `preventDefault`ed with one warning `[Hr]`; cleared when the viewer types again.
- Mixed content (text + element children in one element) is never sent; one warning `[Pt]` and `claude:sync-dropped {reason:"mixed", count, mixed: count}` at the end of a drain.
- `<script>/<style>/<iframe>/…` inserted into a sync region → never sent, one warning `[Vr]`.

### 7.9 Applying `__frame_morph` `[Fs]`
Per element, in order; the first violation returns `{applied, missed:true}` (→ `__frame_patch_miss`):
- all ids must match `tt`;
- **move**: target and parent must exist, be HTML-namespace, target not `html/head/body/frameset`, parent text-capable (`gt`), target must not contain the parent, tag creatable (`ko`), target must contain none of `script,style,iframe,object,embed,template`, and both must share a capture scope (`Ei`). Anchor: `next`/`prev` must be children of `parent` (≠ target); with no valid anchor the parent must have no other element children. Moves preserve the selection (`[Sn]`) and are verified after the batch (final prev/next must match).
- **remove**: target must not be `html/head/body/frameset`; secret input ids under it are remembered so a later re-create in the same batch does not receive `value`/`checked`.
- **create**: if `target` already exists it must have the same tag and parent (idempotent), else miss. Parent HTML-ns and `gt`; tag `ko`; every `attrsSet` key must be `nt()`. Anchor rules as for move (or parent has no element child). Creates `<tag data-id=target>`, applies attrs (property-mirrored for inputs via `[yt]`), `textContent = text`.
- **attrs/text on existing**: element must exist; all keys `nt()`; `text` allowed only if `gt(el)` and not `html/head/body/frameset`. Sets/removes attributes (skipping secrets), mirrors `value`/`checked` to properties, `textContent = text`.

### 7.10 Replica pairing `[Us]` / `[Xs]`
`Us` walks `document.childNodes` against the engine's `nodes`: a node matches when `kind` matches (`element|text|comment|doctype|other`), for elements `localName === tag` and `data-id` equals `dataId` (must be absent if the engine has none), for text/comment `data === text` when given. An engine empty text node with no counterpart is materialised as an empty text node. Any engine node without a counterpart → fail (all materialised nodes removed). `Xs` does the same for a subtree rooted at an existing element and stamps `dataId` onto unstamped elements (refusing ids not matching `tt`, already present in the document, or stamped twice). The map `J` (`[wi]`) keeps `byId`, `idOf` (WeakMap), and `hostOf` (text node → host element, used to re-target a text node the browser replaced: `[retarget]`).

### 7.11 Applying `__frame_replica_patches` `[ta]`
Rules (first failure aborts; `J` is then dropped and `__frame_patch_miss {seq, reason}` sent):
- `text`: `pos/del` in code points; the node must be a known text node inside an element that is `gt()`; splices with `replaceData`, adjusting selection anchors/focus in that node; remembers a "pending" caret when the co-writer split the caret's own text node and re-places it (`[Ys]`).
- `set-attr`/`del-attr`: `ns` must be `""`; `data-id` may only be set on a node this batch created and that has none yet, must match `tt` and be unique; removal of `data-id` refused; name must be `nt()`; secret guard; property mirroring for inputs.
- `remove`: not `html/head/body/frameset`.
- `insert`: parent `":0"` refused; parent must be an HTML element and not `script/style`; index ≤ number of *known* children; with `subtree` → new nodes (ids must be new and unique, element tags `ko`, `ns` `""`, attrs non-namespaced and `nt()`/`data-id` rules); without → move of a known node (not `html/head/body/frameset`, containing none of `script style iframe object embed`, not across a capture-scope boundary). `<template>` parents insert into `.content`.
- `value`, `retag`, `reset`, unknown → refused with the messages listed in the code (`value on <node> refused (interpreted content)`, `retag of <node> to <tag>: re-pair`, `the engine rebuilt its state (reset)`, `unknown patch op <op>`).
After success, in a contenteditable host with `white-space` not `pre|pre-wrap|break-spaces`, a text node that is the last child and ends in an ASCII space gets that space replaced by **U+00A0** (`replaceData(len-1, 1, " ")`, byte-verified) keeping the caret at the end. This is the counterpart of the NBSP-insensitive diff on the way out.

---

## 8. Journaling: the drain `[ws]` and the op set it emits

### 8.1 Scheduling
`[Be]`: if the only dirty state is input `value` attributes (`[Rr]`) and less than 600 ms have passed since the last typing event, retry after the remainder; else `[vn]` chains `[Xr]` onto a single promise `Fn` (drains are serialised). Drain triggers: end of gesture window, released parked writes, `sync()`, `pagehide`, backoff timer, `online`, after co-writer patches, after pairing changed a text baseline.

### 8.2 Batch composition (≤ 32 ops, then `await ctx.edit(ops)`; loop while anything remains dirty)
Order within a batch:
1. `set-html` — only when paired **and** `caps` includes `"html"`: for a dirty element whose nearest stamped, reportable ancestor is mixed-content or was restructured (`[Nn]`), emit `{op:"set-html", target, tag, html}` where `html` is a sanitised `innerHTML` (`[Br]`: `artifact-local` islands emptied, attributes not `data-id`/`_n()` stripped, `open` stripped on details/dialog). Unstamped descendants are later stamped from the tail of `result.created` (`[qi]`), provided a reparse round-trip matches (`[ys]`).
2. `remove` — `{op:"remove", target}` for each recorded removal not superseded by a set-html, not moved back, not a switched-off element.
3. (unpaired only) `set-text` with `text:""` for containers emptied by a re-render.
4. `create-element` — for each added element in document order: parent must be synced (or itself a sync marker with a stamped parent); dropped (`stats.unsynced++`) if parent has no id, is script-like, or the element is a `[$o]` tag without a usable snapshot. Emitted as `{op:"create-element", target:<parent id>, tag, index?, attrs?, text?}`; `index` only when the element is not last among counted siblings (child *elements* not pending removal, plus non-element nodes — i.e. it counts child nodes, matching the d.ts). `attrs` follow §7.3 (≤ 16 extra). `text` = `textContent` when bare and non-empty. An added element that still carries a unique live `data-id` (moved/cloned) is emitted as `remove` + `create-element`.
5. `set-attr`/`del-attr` — `{op:"set-attr", target, key, val}` / `{op:"del-attr", target, key}` per dirty attr on connected, synced, non-pending elements, subject to lanes/coalescing/budget (§6.3).
6. `set-text` — `{op:"set-text", target, text, base?}` for bare elements; `text` = `[mi](base, current)`: unchanged prefix/suffix (space≡NBSP) kept from `base`, the changed middle has NBSP→space. `base` is included when a baseline (replica text, last sent text, or observer `oldValue`) is known. Skipped as `noop` when equal to the baseline.

### 8.3 Result handling
`result.created: string[]` — ids assigned in op order to the batch's `create-element`s; leftover entries stamp set-html descendants. Created elements get `setAttribute("data-id", id)`, a snapshot for later re-creation, secret status inherited from the element they replaced, and their children queued as further adds when applicable. Removed targets go to the confirmed set `K`. Default-lane writes are logged for the budget (`[Ji]`).

### 8.4 Failure handling
- `invalid_content`: the batch is dropped (not retried); elements it created are marked `refused`; warning `<artifact-sync>: the document refused N change(s) (invalid_content): <refusal message or "an element another writer removed, or a name the document cannot store">. They were not saved.`; `document` gets `claude:sync-dropped {reason:"invalid_content", count:N, targets:[…unique op.target]}`.
- lifecycle code (`[ga]`) / `"classic"`: engine disabled (§3.5); the batch is reported as lost below.
- anything else (incl. `conflict` after retries, `upstream_error`): state restored so the changes go out with the next batch (`stats.lost += N`), warning `<artifact-sync>: N change(s) could not be saved (<code>); they are kept and go out with the next change.`, exponential backoff `[ms]`, and `document` gets `claude:sync-lost {code, count:N}`.

### 8.5 `sync(fn)` `[engine.sync]`
`hn(); qt();` flush observer; snapshot every `<input>` inside sync regions as `"<value>|<checked>"`; `it++` (capture on, lane discrete); `await fn()`; for each input whose snapshot changed run `[pn]` (so programmatic `.value=` inside `fn` is journaled); flush observer; `it--`; `await vn()`; if the drain returned a code → `throw {code, message:"sync: the changes were not saved (<code>)"}`.

---

## 9. Custom events and DOM markers (what page code can observe)

| Event | Target | bubbles | `detail` |
|---|---|---|---|
| `claude:edit` | `document` | no | `{ seq: number, targets: string[] }` — after a `__frame_morph` or `__frame_replica_patches` batch applied in place. (Also listened to, capture phase, for seqs applied by the base runtime.) |
| `claude:sync-off` | the switched-off element | **yes** | `{ why: "script-built" \| "pasted" \| <lifecycle code> \| "classic" \| "translated" }` |
| `claude:sync-lost` | `document` | no | `{ code: string, count: number }` |
| `claude:sync-dropped` | `document` | no | `{ reason:"invalid_content", count, targets: string[] }` \| `{ reason:"script_built", count, scriptBuilt }` \| `{ reason:"mixed", count, mixed }` |

Attributes/markers: `artifact-sync` (element or attribute; `<body artifact-sync="">` is added on live docs), `artifact-local`, `artifact-sync-state="off"` (plus custom-state `off` via ElementInternals → `:state(off)`), `data-id` (server ids, regex `tt`; also stamped by the engine from `created`), `data-local-*` (ignored), `data-key`/`id` (re-render pairing keys), `data-frame-diag-reveal` (overlay). Expando `__artifactSecret` on inputs; `__syncStates` on the custom elements. Injected `<style>` in `<head>`.

Console warnings (all prefixed `<artifact-sync>: `, each emitted once per view unless noted): body-append, script-built (per taint batch), switched-off move/copy, forbidden element insert, mixed text, budget (per element), Enter-in-inline, undo unavailable, invalid_content refusal (per batch), lost batch (per batch), translation, plus the two "applying a co-writer's … threw … reloading this view instead." messages.

---

## 10. Compatibility checklist for a self-hosted `window.claude` reimplementation

1. **Namespace**: `claude.use("artifact")` and `claude.use("self")` must resolve the same object with exactly `publish`, `edit`, `sync`. `publish` dispatches on `typeof arg === "string"`; the files form is gated by a flag and must reproduce the `[Ns]` messages/codes above. No client-side doctype/size validation — those codes come from the server. `edit` forwards `ops` untouched (the 32-op cap is enforced only for the engine's own batches; the server must enforce it for direct calls).
2. **RPC envelope**: `{__frame_cap:true, cap:"artifact", id:"s<n>", method, args}` ↔ `{__frame_cap_r:true, id, error|result}`, 130 s timeout → `upstream_error "no reply from shell"`, non-cloneable → `invalid_content`. Error objects are surfaced verbatim, so the shell must send `{code, message, live?}`.
3. **Handshakes**: expect `{__frame_morph_ready:true, arms:["move"]}` at load and `{__frame_replica_ready:true}` on live docs; the shell should send `__frame_replica_pair` (with `caps` such as `["html","stage"]` if it supports `set-html` and `__frame_local_edit`) before sending `__frame_replica_patches`, and must accept `__frame_replica_paired` / `__frame_patch_miss` replies (a miss means: reload the view, or re-pair).
4. **Edit op set the shell must accept from this frame** — beyond the d.ts: `set-text` may carry `base` (string) for 3-way merge; `set-html {target, tag, html}` when it advertised `caps:["html"]`; `create-element` carries `target` (parent id), `tag`, `index`, `attrs` (≤16 + markers/type/autocomplete), `text`; `remove`, `set-attr`, `del-attr`. `EditResult.created` must list ids for every `create-element` in op order, then (if `set-html` was accepted) ids for unstamped descendants of each `set-html` host in document order.
5. **Error semantics the engine relies on**: lifecycle codes permanently disable capture; `invalid_content` drops the batch without retry (and a message containing "not a live doc" disables it); `rate_limited`/`conflict` are retried inside a 5-attempt loop; anything else is kept and retried with backoff.
6. **Server-stamped ids** must match `/^[A-Za-z0-9_-]{1,64}$/` and be unique document-wide; the engine locates elements by `[data-id="…"]` (with `CSS.escape`) including inside `<template>` content for uniqueness checks.
7. **Live-doc marker**: the capability config must be `{kind:"live_doc"}` for body adoption, `__frame_replica_ready`, and for `edit`/`sync` not to be rejected by the `artifact-sync-reject` gate; on a classic artifact the page must contain an `artifact-sync` element/attribute for `sync` to do anything.
8. **Co-writer application fidelity**: to keep `claude:edit` in-place semantics identical, only `nt()` attributes, text inside `gt()` elements, and moves/creates obeying §7.9/§7.11 can be applied in place; anything else must be delivered as a reload (the frame answers `__frame_patch_miss`).
9. **Events/attributes** in §9 are the page-facing surface (`claude:edit`, `claude:sync-off`, `claude:sync-lost`, `claude:sync-dropped`, `artifact-sync-state="off"`, `:state(off)`, `.saving` getter, `display:contents` for the two custom elements).
10. **Origin discipline**: every inbound message is accepted only from `window.parent` at `shellOrigin`; the frame posts only to `shellOrigin` (falling back to the last seen shell origin only for `__frame_local_edit`).
