# Artifact frame runtime: `sample` and `room` capability modules

Sources (pretty-printed, minified identifiers):

- `scratchpad/pretty/sample.BW2Uysoh.js` (1072 lines) – the `sample` capability
- `scratchpad/pretty/room.VSdFwTE9.js` (683 lines) – the `room` capability
- Glue read for context: `scratchpad/pretty/_transforms.DSB5x63f.js` (`buildBoot`, `pipe().wrap()`), `scratchpad/runtime/handlerError.kGkFgEUi.js`, `scratchpad/pretty/frame-shell-BTPNFq1_.js` (boot `capBudgets`).
- Contracts: `artifact-capabilities/0.2.32/sample.d.ts`, `room.d.ts`.

Conventions in this report: "frame" = the artifact iframe running these modules; "shell" = `window.parent` (the viewer). Everything labelled **(inference)** is not visible in these two files. All other statements are read directly from the code.

---

## 0. Shared runtime plumbing both modules rely on

### 0.1 `install(ctx)`

Both modules `export { install }` and are called once with a boot context built by `buildBoot` (`_transforms.js` lines 70-91). The fields they read:

| field | used by | meaning |
|---|---|---|
| `ctx.shellOrigin` | both | the only origin accepted as `event.origin` for inbound messages and the `targetOrigin` for every `parent.postMessage` |
| `ctx.capabilities.<cap>.config` | both | per-capability config from the artifact's publish-time declaration merged by the shell |
| `ctx.capBudgets.sample.sample` | sample | reply-timeout budget (ms) sent by the shell in the boot message; the shell hard-codes `sample: { sample: 33e4 }` (frame-shell line ~175) |
| `ctx.pipe(cap)` | both | returns `{ wrap(method, fn) }` – wraps a method so registered *transforms* can rewrite parameters / returns / rejections; a parameters-transform throwing rejects `{code:"transform_error", id, scope, message:"parameters transform failed"}` |
| `ctx.mount(cap, namespaceObject)` | both | hands the finished namespace to the runtime, which resolves `claude.use(cap)` with it. **(inference)** `mount` freezes the object; neither module freezes it itself. |

`pipe().wrap()` additionally guarantees that a synchronous throw inside a wrapped method becomes a rejected promise (`try { return o(...d) } catch (l) { return Promise.reject(l) }`), which is what makes the documented "rejects, never throws" true for `emit`, `presence`, `sample`, etc. Methods mounted **without** `wrap` (`room.on`, `onPeers`, `onConnection`, `peers`, `connected`) can throw synchronously – and `on/onPeers/onConnection` do throw `TypeError` for a non-function handler.

### 0.2 `handlerError.t` (`H` in sample, `S` in room)

```js
function t(r){try{typeof reportError=="function"?reportError(r):setTimeout(()=>{throw r},0)}catch{}}
```

Used to report exceptions thrown by page callbacks (`onText`, room listeners) and the one-shot emit rate-limit notice, without affecting the call.

### 0.3 The request/reply envelope (both modules)

Outbound request (frame -> shell):
```js
{ __frame_cap: true, cap: "sample" | "room", id: "<prefix><n>", method: "<name>", args: [...] }
```
Inbound reply (shell -> frame):
```js
{ __frame_cap_r: true, id: "<same id>", error?: {code, message, ...}, result?: any }
```
`error` wins when it is not `null`/`undefined`; it is passed to the page **verbatim** (the frame never remaps shell error codes, it only *adds* `text` in sample). Inbound messages are accepted only when `e.source === parent && e.origin === shellOrigin`.

The shell-side validator for the request envelope (`shared-frame-RTyxa5Z-.js` ~line 10281) accepts the schema `{__frame_cap: true, cap: string, id: string, method: string, args: any[], done?: boolean, seq?: number}`; neither module sends `done`/`seq`.

Sample-specific extra inbound envelopes: `{__frame_cap_ack: true, id}` and `{__frame_cap_p: true, id, p}` (shell helpers at shared-frame ~10305/10312). Room-specific extra inbound envelope: `{__frame_room_ev: true, ev: {...}}`.

---

## 1. `sample` module (`sample.BW2Uysoh.js`)

### 1.1 Export / install / namespace shape

`install(ctx)` (`tt`, lines 803-1052):

```js
w = e.pipe("sample"),
E  = w.wrap("sample", (h, u) => m(h, u, null)),
ue = w.wrap("json",   (h, u) => m(h, u, "json")),
ce = w.wrap("limits", () => Promise.resolve({...xe(g), ...f && {tools:{maxCount:f.maxCount}}}));
e.mount("sample", Object.assign(E, { sample: E, json: ue, limits: ce }))
```

So the mounted value is a **function** (`sample(input, options?)`) carrying three own properties:

| member | returns |
|---|---|
| `sample(input, options?)` (the function itself and `.sample`) | `Promise<SampleResult>` – the shell's `result` object passed through unchanged (see 1.7) |
| `sample.json(input, options?)` | `Promise<any>` – `result.value` if the shell provided one, otherwise the text parsed locally |
| `sample.limits()` | `Promise<{maxPromptBytes: 65536, images?: {maxCount, maxInputBytes: 20000000, mediaTypes: ["image/jpeg","image/png","image/webp","image/gif"]}, tools?: {maxCount}}>` – purely local, no message to the shell |

A module-level flag `p` is `true` during install and set to `false` right after `mount`. Its only use: suppressing the console warning "the signal was already aborted when sample() was called - use a new AbortController per call" for calls replayed during install **(inference: the runtime replays calls queued before the capability was ready; those are allowed to be pre-aborted silently)**.

### 1.2 Configuration parsed from `ctx.capabilities.sample.config`

**Images** (`be`, lines 30-52) – `config.images` must be a non-null, non-array object, else images are unavailable (`g === null`). Defaults and clamps (integers only; out of range -> default):

| key | default | accepted range |
|---|---|---|
| `maxCount` | 4 | 1..20 |
| `maxBytes` (per encoded image) | 2 000 000 | 100 000..10 000 000 |
| `maxTotalBytes` | 5 000 000 | 100 000..40 000 000 |
| `maxEdgePx` | 1568 | 64..8000 |
| `patchPx` | 28 | 8..256 |
| `maxPatches` | 1568 | 16..65536 |
| `mediaTypes` (output encodings) | `["image/jpeg","image/png"]` | filtered to `["image/jpeg","image/webp","image/png"]`; empty after filtering -> images unavailable |

Note `limits().images.mediaTypes` always reports the *input* list `ge = [jpeg, png, webp, gif]` and `maxInputBytes = 2e7`, regardless of config; `config.mediaTypes` only governs what the canvas re-encodes to.

**Tools** (`Ne`, lines 289-301) – `config.tools` must be a non-null, non-array object, else tools are unavailable (`f === null`). `maxCount`: integer 1..128, default `Ce = 16`.

### 1.3 Input and option validation (`Qe`, lines 694-780; `We`, `Ke`, `ke`, `Le`)

Order of checks (first failure wins; all are rejected promises of `{code, message}`):

**input**
- string: `trim()===""` -> `invalid_request` "the prompt must be a non-empty string"; UTF-8 bytes > 65536 -> `prompt_too_large` "the prompt exceeds the 64 KiB limit". Sent as-is.
- array -> `We`:
  - empty -> `invalid_request` "the turn list is empty"
  - `> 1000` entries (`ee = 1e3`) -> "at most 1000 turns per call"
  - entry not an object -> "each turn must be {role, content}"
  - role not `"user"`/`"assistant"` -> `turn role must be "user" or "assistant"`
  - content not a non-blank string -> "each turn needs non-blank text content"
  - first or last role not `user` -> "the turn list must start and end with a user turn"
  - summed content bytes > 65536 -> `prompt_too_large` "the turns exceed the 64 KiB limit"
  - turns are **copied** to fresh `{role, content}` objects (extra keys dropped).
- other non-null object -> `invalid_request` "pass the prompt as the first argument: sample(prompt, options)"
- anything else -> `invalid_request` "input must be a prompt string or a list of {role, content} turns"

**options** (`null`/`undefined` accepted)
- prototype must be `Object.prototype` or `null`, else `invalid_request` "options must be a plain object - <hint>" where hint (`He`) is: function -> "for streaming pass {onText: fn}"; string -> "for a model tier pass {modelTier}; the prompt is the first argument"; `AbortController` -> "to cancel pass {signal: ctl.signal}"; `AbortSignal` -> "to cancel pass {signal}"; otherwise "for images pass {images}".
- unknown keys (not in `{onText, signal, tools, images, modelTier, cache}`) -> `console.warn('claude.sample: unknown option "<k>" ignored')` once per key per page load.
- `tools` -> `ke` (see 1.5). If tools present and `cache` is anything other than `undefined`/`null`/`false` -> `invalid_request` "calls with tools are never cached - remove cache".
- `onText` non-nullish and not a function -> "onText must be a function".
- `signal` non-nullish and not `instanceof AbortSignal` -> "signal: pass ctl.signal, not the controller" (if it is an `AbortController`) else "signal must be an AbortSignal".
- `modelTier` non-nullish and not in `["default","complex","quick"]` -> "modelTier must be default, complex, or quick". (Omitted tier is sent as `undefined`; the frame never substitutes `"default"`.)
- `cache` (`Ke`): `undefined` -> omitted; `true`/`false` -> sent as boolean; non-plain-object -> "cache must be true, false, or {gcTime?, refresh?}"; `gcTime` present but not a finite number > 0 -> "cache.gcTime must be a number of milliseconds above zero (cache: false disables caching)"; `refresh` present but not boolean -> "cache.refresh must be true or false"; `gcTime` is capped at `Ge = 86 400 000`. `{}` is sent as `cache: {}`.
- `images`: a `Blob` becomes `[blob]`; any other iterable object (FileList, Set...) is `Array.from`'d; the result must be an array of `Blob`s else "images must be a Blob or File, or a list of them". If non-empty: no image config -> `images_unavailable` "image input is not available in this view"; `> maxCount` -> `image_rejected` "at most N images per call".
- any exception during all of the above -> `invalid_request` "input and options must be plain data".

If `signal.aborted` is already true after validation the call rejects `{code:"cancelled", message:"the call was cancelled"}` without `text` and sends nothing (line 900).

### 1.4 Image preparation (`Ae`/`Oe`, lines 171-270)

Runs on a microtask after the call, *before* the `sample` request is posted; runs only when `images` is non-empty and image config exists. Per-image encoded budget `r = min(cfg.maxBytes, floor(cfg.maxTotalBytes / count))` (2 MB / 5 MB defaults). Images are processed **sequentially**; running total exceeding `maxTotalBytes` -> `image_rejected` "images total over 5 MB after resizing".

Per image N (1-based; every `image_rejected` message is prefixed `image N: `):

1. `blob.size` throws -> `invalid_request` "images must be plain Blobs".
2. size 0 -> "the file is empty"; size > 20 000 000 -> "the file is over 20 MB - choose a smaller one".
3. Reads the first 1 048 576 bytes and sniffs the header (`Te`): PNG (IHDR), GIF87a/89a, WebP (`VP8 `, `VP8L`, `VP8X`), JPEG (walks markers to the first SOFn other than DHT/JPG/DAC). Read failure -> "the file could not be read"; no match -> "not a JPEG, PNG, WebP, or GIF file"; `unreadable` or non-positive dims -> "the file's header could not be read - re-save it as JPEG or PNG".
4. width or height > 10 000 or area > 64 000 000 -> "larger than 10,000 pixels on a side or 64 megapixels - choose a smaller version".
5. Decode with `createImageBitmap(blob, {imageOrientation:"from-image", resizeWidth/Height/Quality:"high"?})`. PNG/GIF get a decode-time resize target from `K(headerW, headerH)`; JPEG/WebP are decoded at full size (EXIF orientation may swap dims). A `TypeError` (old browser) falls back to `createImageBitmap(blob)`. Failure -> "the file could not be decoded - try a different file".
6. Target size `K(w, h, cfg)`: `scale = min(1, maxEdgePx/max(w,h), sqrt(maxPatches*patchPx²/(w*h)))`, then shrink by 0.99 up to 400 times until `max(w',h') <= maxEdgePx && ceil(w'/patchPx)*ceil(h'/patchPx) <= maxPatches`. With defaults that is ~1.23 megapixels (1568 patches of 28 px).
7. Draw on a `<canvas>` with `imageSmoothingQuality = "high"`; no 2D context -> "this browser cannot process images".
8. If the source is not JPEG, an alpha-preserving encoding (`["image/png","image/webp"] ∩ cfg.mediaTypes`) is allowed, and any pixel has alpha != 255 -> try those encodings first (`Q`: PNG with no quality; WebP at q 0.85 then 0.7), accepting the first blob `<= r` bytes.
9. Otherwise (or if that failed) white is composited behind (`destination-over`, `#ffffff`) and `Q` tries `["image/jpeg","image/webp","image/png"] ∩ cfg.mediaTypes` in that order, JPEG/WebP at 0.85 then 0.7. Nothing fits -> "could not be compressed under X MB".
10. Any other exception -> "the file could not be processed". `finally` closes the bitmap and zeroes the canvas.

The prepared images are sent to the shell as an array of `Blob`s in `args[2].images` (structured-cloned by `postMessage`). Metadata stripping is a side effect of re-encoding; "first frame of an animation" is a side effect of `createImageBitmap`.

### 1.5 Tools (`ke`, `Le`, `Re`, `ze`, `Je`, lines 271-602)

**Validation** (`ke(tools, toolCfg)`):
- `null`/`undefined` -> no tools; not an array -> `invalid_request` "tools must be an array of {name, description, inputSchema?, execute} - not an object keyed by name"; empty array -> no tools.
- tools present but no tool config -> `tools_unavailable` "this view cannot run page tools - check (await sample.limits()).tools".
- `> maxCount` -> `invalid_request` "at most N tools per call (got M)".
- Per entry, messages prefixed `tools[i] (<name>): ` :
  - not a plain object -> "each tool is a plain object {name, description, inputSchema?, execute}"
  - alias keys present without the real one (`input_schema`/`parameters` -> `inputSchema`, `run`/`handler` -> `execute`) -> `"input_schema" - did you mean "inputSchema"?`
  - `name` not matching `/^[A-Za-z0-9_-]{1,128}$/` -> "name is 1-128 of A-Z a-z 0-9 _ -"; repeated -> "duplicate name"
  - `description` not a non-blank string -> "description is required - say what the tool does and returns"; > 1024 bytes -> "description is at most 1 KB"
  - `inputSchema` (`Le`): default `{type:"object", properties:{}}` when nullish. Otherwise: plain object; `structuredClone`able ("inputSchema must be plain JSON data (it contains a <Ctor>)"); `type === "object"` at root ('inputSchema needs type: "object" at its root'); no root `anyOf`/`oneOf`/`allOf` ("inputSchema cannot use anyOf at its root - put it on a property"); `required` a string array; `properties` a plain object whose keys match `/^[A-Za-z0-9_.-]{1,64}$/` ('property "x" - names are 1-64 of A-Z a-z 0-9 _ . -'); no non-plain objects inside; nesting <= 8 object levels ("inputSchema nests deeper than 8"); JSON <= 4096 bytes ("inputSchema is at most 4 KB").
  - `execute` not a function -> "execute must be a function".
- Sum of `JSON.stringify([{name, description, inputSchema}...])` > 32768 bytes -> "the tool definitions together are at most 32 KB".

Only `{name, description, inputSchema}` per tool are sent to the shell (`ae`), under `args[2].tools`.

**Tool round** – triggered by an inbound progress message `{__frame_cap_p:true, id, p:{type:"tool_use", calls:[{id, name, input}]}}` (`Ue`: `calls` must be a non-empty array; every entry needs string `id`, string `name`, plain-object `input`, otherwise the whole message is silently dropped). Handler `l` (lines 848-875): ignored if the call has no tools or a round is already `running`; clears the reply timer, runs `Re(toolMap, calls, toolCtl)`:

- All calls in the batch run **concurrently** via `Promise.all`.
- Unknown name -> `{id, content:'Error: no tool named "x"; available: a, b', isError:true}` (truncated to 2048 bytes).
- `toolCtl.signal` already aborted -> "Error: the call ended before the tool started".
- Each execution gets its own `AbortController`; `execute` is invoked as `tool.execute.call(tool, input, {signal})` inside `Promise.resolve().then(...)` (never synchronously).
- Outer abort (`toolCtl`) -> inner abort with the same reason and result "Error: the call ended before the tool finished".
- 150 000 ms (`J`) timeout -> "Error: the tool did not finish within 150 s" and inner abort with `DOMException("the tool ran too long","TimeoutError")`.
- Return value (`ze`): string <= 32768 bytes -> `{content: string}`; `undefined` -> `{content:"(no return value)"}`; otherwise `JSON.stringify`: unserialisable -> `{content:"Error: the result cannot be sent as JSON (<reason≤200B>)", isError:true}`; > 32768 bytes -> `{content:"Error: result too large (N bytes > 32768); return less", isError:true}`; contains a non-plain object (class instance / DOM node with no `toJSON`, detected by `U`) -> "Error: the result contains a <Ctor>, which has no JSON form - return plain data (picked fields, .textContent, Array.from(...))"; else `{content: <json text>}`.
- Throw/rejection (`Je`): `{content: truncate("Error: " + (err.message | string | JSON), 2048), isError:true}` plus `console.warn("claude.sample: tool <name> threw:", err)`.
- A getter that throws while reading the result -> "Error: the result could not be read - return plain data".

Results `[{id, content, isError?}]` are posted back as
```js
{ __frame_cap: true, cap: "sample", id: "<fresh id>", method: "toolResults", args: [<callId>, results] }
```
only if the call is still pending and not aborted. Posting failure -> reject `upstream_error` "the tool results could not be sent". After posting, the reply timer is re-armed with the full budget; expiry -> `cancelCall` + `upstream_error` "no reply from shell after the tools ran". The shell then keeps streaming with the **original** call id.

### 1.6 The call lifecycle and wire protocol (`m`, lines 883-1036)

Ids: a single counter `a() => "a" + ++o` shared by every outbound sample message (`sample`, `toolResults`, `cancelCall`); the *call id* is the id of the `sample` request. Replies to `toolResults`/`cancelCall` ids are ignored (no pending entry).

Reply timeout `r`: `capBudgets.sample.sample` finite > 0 -> `min(budget, 600000) + 2000`; the shell sends 330 000 so **r = 332 000 ms**; fallback `Xe = 130 000`.

Sequence:
1. Validate (sync). Register `abort` listener on `signal`.
2. `queueMicrotask`: if not settled, prepare images (1.4) if any, then `Y(images?)`.
3. `Y` builds `args`:
   ```js
   x = { images?: Blob[], cache?: true|false|{gcTime?,refresh?}, format?: "json", tools?: [{name,description,inputSchema}] }
   args = Object.keys(x).length ? [input, modelTier, x] : [input, modelTier]
   ```
   `input` is the string or the copied turn array; `modelTier` may be `undefined`. `format: "json"` is present only for `sample.json`. Registers the pending entry `{settle, progress, tools?, toolCtl?, timer}` and posts
   ```js
   { __frame_cap: true, cap: "sample", id, method: "sample", args }
   ```
   `postMessage` throwing (unclonable) -> `invalid_request` "arguments must be cloneable" (no `cancelCall`).
4. Inbound handling for the pending id:
   - `{__frame_cap_ack:true, id}` – the shell acknowledges it is holding the call (consent dialog / queue). Timer is replaced by `$e = 900 000 ms`; expiry -> `cancelCall` + `upstream_error` "the call was held (consent or its turn) and no outcome came".
   - `{__frame_cap_p:true, id, p:{type:"text", text}}` – **`text` is a delta** (non-empty string), appended to the accumulator `A`. Progress messages do **not** extend the timer.
   - `{__frame_cap_p:true, id, p:{type:"tool_use", calls}}` – runs a tool round (1.5). Timer is cleared while tools run.
   - `{__frame_cap_r:true, id, error}` / `{__frame_cap_r:true, id, result}` – settles.
5. Timer expiry (no ack) -> `cancelCall` + `upstream_error` "no reply from shell".
6. `pagehide` with `persisted === false` -> every pending call gets `cancelCall` + `upstream_error` "the page was hidden before the answer finished".

`cancelCall` wire shape: `{__frame_cap:true, cap:"sample", id:"<fresh>", method:"cancelCall", args:[<callId>]}`. Sent on: page abort, reply-timeout, ack-hold timeout, tools-reply timeout, pagehide. **Not** sent when the shell itself replied, nor on image-preparation failure (nothing was posted yet).

**`onText` delivery** (`fe`/`D`): on each text delta, if `onText` exists, the call is not settled, there is new text, and the first delivery would not be blank, call `onText({text: A, delta: A.slice(lastDelivered.length)})`; a thrown error or rejected returned promise goes to `reportError`. On final result the remaining tail (`result.text.slice(P.length)`) is delivered once more before resolving, so the last `onText` always equals `result.text`. Per-message delivery – the "few times a second" pacing is the shell's.

**Settlement (`L`)**:
- error: if `error.text === undefined && error.code !== "refused"` the accumulated text `A` is attached as `text` (only when non-blank); otherwise the shell error object is rejected **as-is**. So `refused` strips the partial, every other shell code carries the partial.
- result: `result.text` must be a string, else `upstream_error` "the viewer app's reply is not one this page runtime reads - reload the view"; must `startsWith(A)` else `upstream_error` "the reply disagrees with the text sent"; if the signal aborted meanwhile -> `cancelled` with `text`.
- `sample()`: resolves with the shell `result` object unchanged (the frame never constructs `truncated`/`modelTierApplied`; those must come from the shell).
- `sample.json()`: `"value" in result` -> resolve `result.value`; `result.truncated === true` -> `invalid_json` "the reply was cut short before the JSON was complete" (`text` = full reply); else `Ze(text)` (whole string -> body of exactly one ```` ``` ```` fence -> slice from first `[`/`{` to last `]`/`}`); parse failure -> `invalid_json` "the reply held no JSON value".
- Settling removes the pending entry and aborts `toolCtl` (so running `execute`s see their `context.signal` abort).

**Caching**: the frame computes no keys and stores nothing. It forwards `cache` verbatim and `format` distinguishes the verb; the key (`input`, `modelTier`, image bytes, verb) and the 5-minute default window are **shell-side (inference from d.ts)**.

### 1.7 Error codes produced or handled in the sample module

| code | produced by the frame when | message(s) |
|---|---|---|
| `invalid_request` | any validation failure in 1.3/1.5; unclonable args; Blob whose `size` throws | as listed above; "arguments must be cloneable"; "images must be plain Blobs" |
| `prompt_too_large` | prompt or summed turns > 65536 UTF-8 bytes | "the prompt exceeds the 64 KiB limit" / "the turns exceed the 64 KiB limit" |
| `images_unavailable` | non-empty `images` and no `config.images` | "image input is not available in this view" |
| `tools_unavailable` | non-empty `tools` and no `config.tools` | "this view cannot run page tools - check (await sample.limits()).tools" |
| `image_rejected` | too many images; every failure in 1.4 | "at most N images per call"; "image N: ..."; "images total over X MB after resizing" |
| `cancelled` | signal aborted before send, during the call, or observed at settle | "the call was cancelled" (+`text` when partial) |
| `invalid_json` | `json` only, see 1.6 | two messages above |
| `upstream_error` | reply timeout, ack-hold timeout, tools-reply timeout, pagehide, toolResults post failure, malformed/inconsistent result | as listed |
| `transform_error` | a registered parameters-transform threw (`pipe.wrap`) | "parameters transform failed" |
| pass-through | anything in the shell's `error` (`not_granted`, `sampling_disabled`, `not_declared`, `rate_limited`, `refused`, `empty_completion`, `session_expired`, `capability_disabled`, `capability_removed`, `queue_overflow`, ...) | shell's message; `text` appended except on `refused` |

`empty_completion`, `refused`, `not_granted`, `rate_limited`, `modelTierApplied` substitution and the caching window are never decided in the frame.

### 1.8 Sample constants

| constant | value | meaning |
|---|---|---|
| `he` | 65536 | max prompt/turn bytes |
| `re` | 20 000 000 | max input image file bytes |
| `W` | 10 000 | max image side px |
| `pe` | 64 000 000 | max image megapixels |
| `de` | 1 048 576 | bytes sniffed for the header |
| `ye` | `[0.85, 0.7]` | JPEG/WebP quality ladder |
| `_e` | see 1.2 | image config defaults |
| `Pe` | `/^[A-Za-z0-9_-]{1,128}$/` | tool name |
| `Me` | `/^[A-Za-z0-9_.-]{1,64}$/` | schema property name |
| `je`/`Ie`/`Z`/`qe` | 1024 / 4096 / 8 / 32768 | description bytes / schema bytes / schema depth / all-definitions bytes |
| `F` | 32768 | max tool result bytes |
| `oe` | 2048 | max bytes of an error `content` |
| `J` | 150 000 | tool execute timeout ms |
| `Ce` | 16 | default max tools |
| `Xe` | 130 000 | fallback reply timeout ms |
| `Fe` | 2000 | added to the shell budget |
| `$e` | 900 000 | post-ack hold timeout ms |
| `ee` | 1000 | max turns |
| `Ge` | 86 400 000 | gcTime cap ms |
| effective `r` | 332 000 | with the shell's `capBudgets.sample.sample = 330000` |

---

## 2. `room` module (`room.VSdFwTE9.js`)

### 2.1 Export / install / namespace shape

`install(ctx)` (`rt`, lines 164-681) ends with:

```js
a.mount("room", {
  emit: m.wrap("emit", Me), presence: m.wrap("presence", De),
  sendToClaudeSession: m.wrap(_, $e), canSendToClaudeSession: m.wrap(W, ke),
  on: ze, onPeers: Re, onConnection: xe,
  peers: () => (b && (h = Object.freeze(Array.from(d.values())), b = !1), h),
  connected: () => O
})
```

Config from `ctx.capabilities.room.config.limits` (`Ze`, finite numbers clamped, else default):

| key | default | range |
|---|---|---|
| `maxBytes` | 4096 | 1024..65536 |
| `presenceHz` | 30 | 1..120 |
| `keepaliveMs` | 20 000 | 1000..600 000 |
| `silenceMs` | 150 000 | 10 000..3 600 000 |
| `maxPeers` | 256 | 2..4096 |

Note: the `topics: {...}` part of the declaration is not read by the frame; permission is enforced by the shell (`not_permitted` arrives as a reply error).

### 2.2 Request/reply (`g`, lines 171-205)

Ids `"r" + n`. Each request registers `{resolve, reject, timer}`; timer `Je = 130 000 ms` -> reject `{code:"upstream_error", message:"no reply from shell"}`. Envelope `{__frame_cap:true, cap:"room", id, method, args}`. When the request needs a proven user gesture (`sendToClaudeSession`) and `"userActivation" in MessageEvent.prototype`, it is posted as `parent.postMessage(msg, {targetOrigin: shellOrigin, includeUserActivation: true})`; otherwise `parent.postMessage(msg, shellOrigin)`. A `postMessage` throw -> `{code:"invalid_argument", message:"arguments must be plain JSON data"}`. Reply `{__frame_cap_r:true, id, error?, result?}`: `error` non-null -> reject verbatim, else resolve `result`.

Methods sent: `hello []`, `presence [presenceObject]`, `emit [topic, data]`, `sendToClaudeSession [data, {deliver}]`, `canSendToClaudeSession []`.

### 2.3 Inbound room events `{__frame_room_ev: true, ev}` (lines 399-449)

`ev.arm` must be a string. After a terminal error only `arm:"revoked"` is processed.

| `arm` | required fields | effect |
|---|---|---|
| `"presence"` | `peer` non-empty string; `p` non-null object (the sender's **whole** presence object); optional `by` string, `isMe` bool, `kind` (`"agent"` else `"viewer"`), `sameTab` | dropped if `isMe && sameTab` (own echo). Sender is built with `sameTab: false` always. Fed to `Te` (2.5). |
| `"event"` | `topic` string, `peer` string; optional `by`, `isMe`, `sameTab`, `kind`, `d` | if any `on(topic)` listeners exist, each gets a frozen `Message {peer, by, isMe, sameTab, kind, topic, data: d}`. No inbound topic-grammar check. |
| `"gone"` | `peer` string | removes the peer (unless it is self). |
| `"conn"` | `up` boolean | `te(up)`; when `up===true` and `hello` has not succeeded yet, (re)sends `hello` (or flags a retry if one is in flight). |
| `"revoked"` | optional `code` string | terminal with `code` (default `"revoked"`). |

### 2.4 Handshake and connection (`Y`, `Ie`, `te`, lines 206-219, 650-669)

At install `Y()` posts `hello []`. Result (`Ie`):
- `result.terminal` object -> terminal with `terminal.code` (default `"revoked"`); this is how `not_granted` reaches the page **(inference: the shell answers hello with `{terminal:{code:"not_granted"}}` for viewers it cannot connect)**.
- `result.peer` non-empty string and no id yet -> own peer id `y`; self is inserted into the peer map with the current local presence (`ae()`).
- `result.up === true` -> connected.
A failed hello is retried only if a `conn up` event arrived during the attempt.

`te(up)`: no-op if unchanged or terminal. On `true` it immediately calls `C()` (send full presence + arm keepalive – this is the "re-assert on reconnect"). Then every live `onConnection` listener is called with the boolean. `connected()` returns the raw flag; `onConnection(handler, onError)` throws `TypeError("room.onConnection requires a handler function")`, delivers the current state once on a microtask, then on every edge; if terminal it gets `onError(terminalError)` on a microtask instead.

### 2.5 Presence

**Local model**: `R` = own presence object (starts `{}`); `d: Map<peer, frozen Peer>`; `E: Map<peer, lastSeenMs>`; `h` = frozen snapshot array (rebuilt lazily when dirty); `P` = map of the last objects delivered to `onPeers`; pending sets `v` (joined), `T` (left -> last delivered Peer), `w` (updated).

`Peer` objects (`I`) are `Object.freeze({peer, by, isMe, sameTab, kind, presence: Object.freeze(obj), updatedAt})`. Own sender (`ie`) is `{peer: y ?? "", by: null, isMe: true, sameTab: true, kind: "viewer"}`.

**`presence(patch)`** (`De`, lines 485-523): terminal -> reject terminal error. `patch` must be a non-null non-array object -> else `invalid_argument` "room.presence takes one object of fields to merge". Merge into a copy of `R`: top-level `null` deletes the key; keys `__proto__`/`constructor`/`prototype` are skipped. Result must pass `Se` (plain JSON: no functions/symbols/typed arrays/non-plain prototypes, <= 4096 entries per array/object, depth <= 24, <= 16384 nodes) -> else "presence fields must be plain JSON data - the patch was not applied"; `JSON.stringify` failure -> "presence fields must be plain JSON data"; UTF-8 bytes of the merged JSON > `maxBytes` -> "your merged presence object serializes over 4096 bytes - the patch was not applied". On success `R = JSON.parse(text)` (drops `undefined` values), self is updated locally at once (`ae()` -> an `updated`/`joined` entry for `isMe && sameTab`), and a coalesced send is scheduled (`we`): a trailing-edge timer of `ceil(1000/presenceHz)` ms (34 ms at 30 Hz) after which `C()` posts `presence [R]` – the **whole merged object**, never the patch. The promise resolves `undefined` immediately; the shell's reply to `presence` is ignored (`.catch(()=>{})`).

**Keepalive** (`je`/`C`): every send re-arms a timer that re-posts `presence [R]` after `keepaliveMs` (20 s). **Newcomer answer** (`Oe`): when a previously unknown peer's presence arrives, the frame re-sends its own presence after a random 0..500 ms delay unless the keepalive is due within 500 ms anyway – this is how late joiners collect everyone's presence without server storage **(inference: the shell/server does not replay presence; peers answer each other)**.

**Inbound merge** (`Te`/`q`): unknown peer -> ignored if `d.size >= maxPeers`, else joined with `updatedAt = Date.now()`. Known peer -> `q(prev, incoming)` builds a new object only if some field's `JSON.stringify` differs or a key disappeared; identical content returns the previous object so keepalives do not bump `updatedAt` and `===` identity holds across deliveries. `E` (last-seen) is refreshed on every message.

**Silence sweep** (`fe`): every 15 000 ms, peers other than self not seen for `silenceMs` (150 s) are removed (`left`).

**`peers()`**: synchronous; returns the same frozen array until something changed (`Z = Object.freeze([])` before the first hello). After a terminal error it is `[self]` or `[]`.

**`onPeers(handler, onError)`** (`Re`): `TypeError("room.onPeers requires a handler function")`; terminal -> `onError` on a microtask. Otherwise registers, and on a microtask flushes any pending diff, marks the listener `primed`, and if the snapshot is non-empty delivers `{peers: h, joined: h, left: [], updated: []}` (all frozen). Subsequent deliveries are batched per `requestAnimationFrame` (`B`/`re`, also flushed on `visibilitychange -> visible`): `joined` = peers newly added since the last delivery, `left` = last delivered objects of removed peers, `updated` = peers whose object differs from the last delivered one; a join+leave inside one frame cancels out; `change.peers === room.peers()`.

### 2.6 Events

**`emit(topic, data?)`** (`Me`, lines 461-484): terminal -> reject terminal error. `topic` must be a string matching `/^[a-z][a-z0-9_.-]{0,47}$/` -> else `invalid_argument` "emit topic must match ^[a-z][a-z0-9_.-]{0,47}$ (colon-free)". `data` (if not `undefined`) must pass `Se` -> "emit data must be plain JSON data"; JSON bytes > `maxBytes` -> "emit data serializes over 4096 bytes". Rate limiter (`Ee`): token bucket, capacity 80, refill 40 tokens/s; when empty the call **resolves `undefined` and the moment is dropped**, and once per page load `reportError(new Error("window.claude.room: rate limit - dropping emits sent faster than the budget (about 40/s; the page keeps working; high-rate state belongs in presence; this is reported once per page load)"))`. Otherwise posts `emit [topic, data]` and resolves with the shell's `result` (**inference**: `undefined`). The frame does not check `connected()` – dropping while disconnected is the shell's job. `not_permitted` arrives as the shell's reply error.

**`on(topic, handler, onError?)`** (`ze`): non-function handler -> `throw TypeError("room.on requires a handler function")`. Bad topic -> `onError({code:"invalid_argument", message:"on topic must match ^[a-z][a-z0-9_.-]{0,47}$ (colon-free)"})` on a microtask and a no-op unsubscribe. Terminal -> `onError(terminal)` on a microtask. Else adds to `M: Map<topic, Set<listener>>`; unsubscribe marks the listener dead and removes it. Each registration is independent.

### 2.7 `sendToClaudeSession` / `canSendToClaudeSession`

`sendToClaudeSession(data, options?)` (`$e`, lines 541-567) – **not** gated on the terminal state or on `connected()`:
1. `Ne(data)`: not a non-null non-array object -> `invalid_argument` "room.sendToClaudeSession takes one plain object the artifact defines, e.g. {selectedText, blockId}". Then the strict walker `ee(data, 0, "data")` (2.8); any message is prefixed "room.sendToClaudeSession: ". Unserialisable -> "room.sendToClaudeSession's object must serialize as JSON"; JSON bytes > 4096 -> "room.sendToClaudeSession's object may be at most 4096 bytes of JSON text; it is N"; the JSON round-trip (`JSON.parse(JSON.stringify(e))`) with zero keys -> "nothing to send: the object has no fields". A throw during validation -> "room.sendToClaudeSession takes plain data".
2. `Pe(options)`: `{deliver: options?.deliver === "send" ? "send" : "stage"}` – an **undocumented second argument**; anything but `"send"` means stage. (A throwing options getter -> `invalid_argument` 'room.sendToClaudeSession's options must be a plain object such as {deliver: "send"}'.)
3. Posts `sendToClaudeSession [data, {deliver}]` **with `includeUserActivation: true`** when supported – this is how the click is proven; the shell **(inference)** checks `event.userActivation.isActive` (the shell code has `uv(mode, activation, fallback)` returning `t?.isActive === true` in `"strict"` mode) and rejects `claude_unavailable` otherwise.
4. Result normalised to `{to: result.to === "session" || result.to === "new" ? result.to : "pane"}`. Errors (`claude_unavailable`, `rate_limited`, `upstream_error`, `invalid_argument`, `capability_removed`) are the shell's, verbatim; plus the 130 s `upstream_error` "no reply from shell".

`canSendToClaudeSession()` (`ke`): posts `canSendToClaudeSession []`; a string result is returned as-is, any non-string -> `"off"`. Not gated on terminal state. (The shell computes `"off" | "no_session" | "available" | "writers_only"` – `ri()` in frame-shell-deferred – so an unlisted value such as `"writers_only"` can reach pages; the d.ts says to treat unknown values as unavailable.)

### 2.8 The strict `ToClaude` validator (`ee`/`Ge`, lines 41-97)

Budget `Ye = 16384` nodes; every string also charges its length against the budget ("data...: the object has too many nodes to check" / "... carries more text than the whole object may (4096 bytes)"). Rules, with the exact message tails (path such as `data.items[3].label` is prepended):

- number not finite -> "is not a finite number"
- string > 4096 code units -> "is longer than the whole object may be (4096 bytes)"
- string containing: a lone surrogate; C0/C1 controls except tab/LF/CR (`Ce`); any `\p{Cf}` or `\p{Co}` (`He`); the explicit range table `Le` (U+00AD, U+034F, U+061C, U+115F-1160, U+17B4-17B5, U+180B-180F, U+200B-200F, U+202A-202E, U+2060-206F, U+2800, U+3164, U+FE00-FE0F, U+FEFF, U+FFA0, U+FFF0-FFF8, U+FFFD, U+16FE4, U+1BCA0-1BCA3, U+1D173-1D17A, U+E0000-E0FFF); non-characters U+FDD0-FDEF and U+xxFFFE/xxFFFF -> "has a control, private-use, format or invisible character (strip format characters from picked text before sending)"
- **exception**: variation selectors U+FE00-FE0F are allowed directly after an Extended_Pictographic/Emoji_Modifier char or a Han char (U+FE0F also after a keycap base `[#*0-9]`); U+E0100-E01EF only after Han; U+200D only after a pictograph or after a pictograph+U+FE0F; U+200C/U+200D after a character of a joining script (Arabic, Syriac, Mongolian, Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam, Sinhala, Myanmar, Tibetan, Khmer). At most 8 such joiners per string; a joiner resets the state to `none` so runs are refused, with one exception: after `pictograph U+FE0F` the state becomes `selector`, so `pictograph U+FE0F U+200D` (a standard emoji ZWJ sequence) is accepted; violations -> "has a joiner or variation selector with no character to carry it (or a run, or more than 8)"
- non-object, non-primitive (function, symbol, bigint) -> "is not plain JSON data"; `ArrayBuffer.isView` -> same
- depth >= 8 -> "nests deeper than 8"
- array > 64 entries -> "has more than 64 entries"
- object whose prototype is neither `null` nor an object whose own prototype is `null` (so only null-prototype objects and direct `Object.prototype` instances pass; class instances, `Map`, `Date` fail) -> "is not a plain object"
- object > 64 keys -> "has more than 64 keys"
- key not matching `/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/`, or `"prototype"`, or `key in Object.prototype` -> "has a key that is not an identifier ([A-Za-z_][A-Za-z0-9_-]*, at most 64) or is a reserved name"

### 2.9 Terminal state (`de`, lines 375-398)

Triggered by `hello -> {terminal:{code}}` or `arm:"revoked"`. Sets `l = {code, message: "The room channel is no longer available to this view."}`, clears keepalive/newcomer/silence timers, flips `connected()` to `false` (notifying `onConnection` listeners with `false` first), empties the peer map except self, sets the snapshot to `[self]` or `[]`, then calls every `on`, `onPeers`, `onConnection` listener's `onError` once with `l` and marks them dead. Thereafter `emit`/`presence` reject `l`, `on/onPeers/onConnection` deliver `l` on a microtask; `sendToClaudeSession`/`canSendToClaudeSession` still work. `pagehide` (not persisted) only clears timers.

### 2.10 Room error codes and where they originate

| code | frame-produced? | condition |
|---|---|---|
| `invalid_argument` | yes | topic grammar (`emit`, `on`), non-JSON/oversized emit data, non-object/non-JSON/oversized presence patch, every `ToClaude` rule in 2.8, options getter throwing, `postMessage` clone failure ("arguments must be plain JSON data") |
| `upstream_error` | yes | 130 s with no reply to any request ("no reply from shell") |
| `not_permitted` | no – shell reply to `emit` | viewer may not send on that topic |
| `claude_unavailable`, `rate_limited` | no – shell reply to `sendToClaudeSession` | no proven gesture / nothing beside the view; cadence |
| `revoked` | shell (`arm:"revoked"` without `code`, or `hello.terminal` without `code`) | default terminal code |
| `not_granted`, `capability_disabled`, `capability_removed` | shell (`terminal.code` / `revoked.code` / reply errors) | passed verbatim |
| `transform_error` | `pipe.wrap` | a parameters-transform threw |

The terminal `message` is always "The room channel is no longer available to this view." regardless of code.

### 2.11 Room constants

| constant | value | meaning |
|---|---|---|
| `Je` | 130 000 | request reply timeout ms |
| `z` | 4096 | `ToClaude` byte cap and string cap |
| `me`/`ye`/`ge`/`Q` | 8 / 64 / 64 / 8 | `ToClaude` depth / keys / array entries / joiners |
| `Xe` | `/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/` | `ToClaude` key grammar |
| `Ye` | 16384 | `ToClaude` node+char budget |
| `he` | `/^[a-z][a-z0-9_.-]{0,47}$/` | topic grammar |
| `k` | see 2.1 | limits defaults |
| `We`/`be` | 40 / 80 | emit refill per second / burst |
| `_e` | 500 | newcomer-answer jitter ms |
| `Ae`/`Qe`/`et` | 4096 / 24 / 16384 | `Se` plain-JSON check: entries per container / depth / nodes |
| `le` | 15 000 | silence sweep period ms |
| presence coalescing | `ceil(1000/presenceHz)` = 34 ms | trailing-edge |

---

## 3. What a self-hosted `window.claude` must match

If the goal is to run existing pages unchanged, the cheapest faithful approach is to **reuse these two frame modules as-is** and implement only the shell (parent) side of the postMessage contract. That side must:

### 3.1 Boot / mount

- Provide `ctx.shellOrigin`, `ctx.capabilities.sample.config` (`{images?: {...}, tools?: {maxCount?}}`) and `ctx.capabilities.room.config` (`{limits?: {...}}`), `ctx.capBudgets.sample.sample` (330 000 to match; any finite number > 0 works, capped at 600 000), a `pipe()` that at minimum wraps sync throws into rejections (transforms may be empty), and a `mount()` that freezes and exposes the namespace via `claude.use()`. Omitting `config.images`/`config.tools` makes `limits()` report neither and calls with images/tools reject `images_unavailable`/`tools_unavailable` locally.

### 3.2 `sample` shell handlers (cap `"sample"`)

- `method:"sample", args:[input, modelTier|undefined, opts?]` where `opts` may hold `images: Blob[]`, `cache: true|false|{gcTime?, refresh?}`, `format:"json"`, `tools:[{name, description, inputSchema}]`.
- Optional `{__frame_cap_ack:true, id}` while waiting for consent/queue – it extends the frame's timeout from ~332 s to 900 s. Send it if you may hold a call longer than the budget.
- Stream with `{__frame_cap_p:true, id, p:{type:"text", text:<DELTA>}}` (non-empty deltas; the frame concatenates them) – coalesce to a few per second if you want to match the documented pacing.
- Tool rounds: `{__frame_cap_p:true, id, p:{type:"tool_use", calls:[{id, name, input:<plain object>}]}}`; expect `method:"toolResults", args:[callId, [{id, content:string, isError?:true}]]` (its own fresh `id`; reply to it is ignored). Only one round at a time per call; keep the original call id for later progress/reply. Insert a blank line between rounds' text yourself (the frame just concatenates deltas).
- Final reply `{__frame_cap_r:true, id, result:{text, truncated:boolean, modelTierApplied:"default"|"complex"|"quick", value?:any}}` – `text` must be a string that **starts with the concatenation of all deltas sent**, otherwise the page sees `upstream_error`. `value` (optional, `json` only) short-circuits client-side parsing. Never send an empty/blank `text`: produce `{error:{code:"empty_completion", ...}}` instead – the frame does not check for it.
- Error reply `{__frame_cap_r:true, id, error:{code, message, text?}}` with the documented `SampleErrorCode` strings; the frame attaches partial text for every code except `refused` (unless you include `text` yourself).
- Honour `method:"cancelCall", args:[callId]` by stopping generation; nothing is expected back.
- Implement caching (key: input + modelTier + image bytes + verb; default window 5 min, `gcTime` cap 24 h, `refresh`, never with tools), consent (`not_granted`), concurrency (`rate_limited`) and tier substitution on this side – none of it is in the frame.

### 3.3 `room` shell handlers (cap `"room"`)

- `method:"hello", args:[]` -> `result:{peer:<opaque id>, up?:boolean}` or `result:{terminal:{code:"not_granted"|...}}`. The frame will not show self in `peers()` until `peer` arrives.
- `method:"presence", args:[wholePresenceObject]` -> any result; broadcast to every other document as `{__frame_room_ev:true, ev:{arm:"presence", peer, p:<object>, by?:string, isMe?:boolean, kind?:"viewer"|"agent"}}` (set `isMe:true` for the sender's other tabs; deliver nothing back to the sending tab, or set `sameTab:true` so the frame drops it). Expect it every 20 s as a keepalive and within 500 ms of any newcomer; the frame drops peers silent for 150 s and caps the map at 256.
- `method:"emit", args:[topic, data|undefined]` -> `result:undefined` or `error:{code:"not_permitted"|...}`; broadcast to **everyone including the sender** as `ev:{arm:"event", topic, peer, by?, isMe, sameTab, kind?, d:data}` (the sender's own document must get `isMe:true, sameTab:true`). Drop while the sender is not connected. Enforce the declared `topics` levels here.
- Send `ev:{arm:"conn", up:true|false}` on every transport edge (`up:true` makes the frame re-post its presence), `ev:{arm:"gone", peer}` when a document leaves, `ev:{arm:"revoked", code?}` to end the channel.
- `method:"canSendToClaudeSession", args:[]` -> `result:"available"|"no_session"|"unsupported"|"off"`.
- `method:"sendToClaudeSession", args:[data, {deliver:"stage"|"send"}]` – the message arrives with `event.userActivation` when the browser supports `includeUserActivation`; check `isActive` and reject `claude_unavailable` otherwise; reply `result:{to:"pane"|"session"|"new"}` or `error:{code:"claude_unavailable"|"rate_limited"|"upstream_error"|"invalid_argument"|"capability_removed"}`. Attach the sender's current presence (minus `cursor`/`who`) yourself; the frame sends only `data`.
- Reply to every request within 130 s or the page sees `upstream_error`.

### 3.4 Behavioural details pages may depend on

- `sample()` resolves with the shell's result object by reference – extra fields you add are visible to pages.
- `sample.json()` without `value` parses tolerantly on the client (whole / single fence / outer brackets).
- `onText` is never called synchronously, never after settle/abort, first call is non-blank, last call equals `result.text`.
- Room `Peer`/`Message`/`PeersChange` objects are frozen; unchanged peers keep identity; `updatedAt` is the receiver's `Date.now()`.
- Room `by` is `null` for self and whatever string the shell puts in `by` for others.
- `emit` beyond 40/s (burst 80) is dropped **client-side** with a resolved promise.
- `sendToClaudeSession`/`canSendToClaudeSession` keep working after a terminal room error.
