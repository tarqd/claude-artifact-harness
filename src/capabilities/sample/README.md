# `sample` — ask Claude

The page-facing API of `reference/contract/0.2.32/sample.d.ts`, the wire
protocol of `docs/surface-area.md` §7, and the frame behaviour reversed in
`docs/analysis/sample-room.md` §1.

```js
const sample = await claude.use("sample");          // null: hide the feature
const { text, truncated, modelTierApplied } = await sample(input, options);
const data = await sample.json(input, options);
const { maxPromptBytes, images, tools } = await sample.limits();
```

## Files

| file | runs in | what it does |
|---|---|---|
| `frame.ts` | artifact iframe | the namespace: validation, images, tools, the call lifecycle |
| `broker.ts` | shell page | consent, cache, concurrency, SSE → `__frame_cap_p` |
| `server.ts` | Node | `POST /api/frame/sample/call` (SSE) and the tool-results lane; two backends |
| `protocol.ts` | both | event shapes, tier→model table, byte counting, the tolerant JSON read |

`protocol.ts` is the one file beyond the three the layout names: it holds the
plain data both the browser sides and the server need, so neither side
imports the other.

## What is implemented

**Frame** (`frame.ts`) — everything the platform module does before the wire:

- `sample(input, options)`, `sample.json()`, `sample.limits()`, mounted as one
  callable namespace (`Object.assign(fn, {sample, json, limits})`), frozen by
  the preamble. Every method rejects, never throws.
- Input validation with the documented messages: non-blank prompt, 64 KiB of
  UTF-8, at most 1000 turns, `{role, content}` shape, user-first-and-last,
  turns copied to fresh objects.
- Option validation: the plain-object check with its five hints, one
  `console.warn` per unknown key, `onText`, `signal` (with the
  "pass ctl.signal" message), `modelTier`, `cache`
  (`true | false | {gcTime, refresh}`, gcTime capped at 24 h), `images`
  (Blob, or any iterable of Blobs), `tools` — and `cache` with `tools` is
  `invalid_request`.
- Tool definitions: name/description/schema rules, alias hints
  (`input_schema` → `inputSchema`), depth ≤ 8, 4 KB per schema, 32 KB for all
  definitions; only `{name, description, inputSchema}` reaches the shell.
- Images: header sniffing (PNG, GIF, WebP VP8/VP8L/VP8X, JPEG SOF walk),
  10 000 px / 64 MP refusal, `createImageBitmap` with a decode-time resize
  for PNG/GIF, canvas downscale to `min(maxEdgePx, √(maxPatches·patchPx²))` —
  about 1.2 MP with the defaults — alpha-preserving encodings first when the
  image has any, else white flattening and the `[0.85, 0.7]` JPEG/WebP
  quality ladder, per-image and total byte budgets.
- The lifecycle: one id counter for `sample`/`toolResults`/`cancelCall`, a
  332 s reply budget from `capBudgets.sample.sample`, `__frame_cap_ack`
  extending it to 900 s, `cancelCall` on abort, on either timeout and on
  `pagehide`, tool rounds run concurrently in the frame with a 150 s
  per-tool timeout and their own `context.signal`, `onText({text, delta})`
  with the whole text and the new part, the `startsWith` consistency check,
  partial text attached to every error except `refused`, and the tolerant
  JSON read (`result.value`, else the whole reply, one fence, or first
  `{`/`[` to last `}`/`]`).

**Shell** (`broker.ts`):

- First-call consent per artifact per viewer. `__frame_cap_ack` goes out
  first, the iframe is `inert` while the dialog is up, and the answer is
  persisted in the shell's `localStorage` under `consent:<artifactId>:sample`
  as `granted`/`denied` — the key the `permissions` slice reads. A decline is
  `not_granted` and is never re-asked. Calls that arrive while the dialog is
  open all wait on that one dialog.
- A 5-minute reply cache keyed by `(input, modelTier, image bytes, verb)`
  plus artifact and viewer; `cache: false`, `{refresh: true}` and `{gcTime}`
  are honoured, calls with `tools` are never cached, and a `json()` answer
  that holds no JSON — or that was cut short before its JSON was complete —
  is not stored either. Every write sweeps expired entries and keeps at most
  64, so a page that asks endless distinct questions cannot grow it forever.
- Concurrency: three calls per viewer at a time, five more may wait (acked
  while they do), and beyond that `rate_limited`. A viewer's slot record is
  dropped once nothing is running or waiting on it.
- Streams the backend's events: `text` becomes `__frame_cap_p {type:"text"}`
  deltas, `tool_use` becomes a tool round, `done` settles the call,
  `error` is passed through as its code. A remount (`dispose`) abandons
  everything the view held.
- `cancelCall` works from the call's first instant: the call is registered
  before consent is asked, so Stop ends one still held for the dialog or
  still waiting for a slot without ever reaching the backend.

**Server** (`server.ts`):

- `POST /api/frame/sample/call` on the shell origin (cookie auth), answering
  `text/event-stream` with `start{modelTierApplied}`, `text{text}`,
  `tool_use{calls}`, `done{truncated}` and `error{code,message}`. It refuses
  an artifact that does not declare `sample`, a `view`-level viewer, and a
  prompt over 64 KiB.
- Every page-side limit is re-checked here, because this route — not the
  shell page — is what a direct HTTP caller meets: a body over 8 MB is
  `too_large` (413) before it is parsed; `images`/`tools` are refused as
  `images_unavailable`/`tools_unavailable` unless
  `capabilities.sample.config` declares them, and are then held to that
  config's `maxCount`, per-image `maxBytes` and `maxTotalBytes`, the four
  media types the Messages API reads, and 32 KB of tool definitions; one
  viewer may hold 8 streams open at once (`rate_limited`, 429) and only 64
  calls server-wide may be parked on page tool results.
- The real backend calls the Messages API with `fetch` (no SDK): tiers
  `quick` → `claude-haiku-4-5-20251001`, `default` → `claude-sonnet-5`,
  `complex` → `claude-opus-5`, streaming, tool round trips (up to 8 rounds,
  a blank line between rounds), images as base64 blocks, `max_tokens`
  truncation reported on `done`, and API failures mapped to `rate_limited`,
  `sampling_disabled`, `not_granted`, `invalid_request` or `upstream_error`.
- `SAMPLE_BACKEND=fake` selects a deterministic stand-in: it echoes the
  prompt in 24-character chunks as `echo #<n> (<tier>): <prompt>`, calls the
  first offered tool once, and reads three markers in the prompt —
  `!error:<code>`, `!truncate`, `!slow`.

Environment: `ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL`,
`SAMPLE_BACKEND=fake`. With no key and no fake backend the call route answers
`503 {code: "sampling_disabled"}`.

## Deviations, and why

- **A second route, `POST /api/frame/sample/tool_results`.** The documented
  surface names only the call route; a tool round needs a way back in while
  the SSE response is still open. The shell posts the page's results there
  with the `callId` it generated, and only the viewer whose call is waiting
  may answer it. Nothing about the frame↔shell protocol changes.
- **`fetch` instead of `ctx.api` for the stream.** `BrokerContext.api` parses
  one JSON body; SSE needs the raw response. The broker still calls its own
  origin with `credentials: "same-origin"`, so no credential is handled in
  the shell and none can reach the frame.
- **Consent is stored per browser, not per viewer id.** The key is fixed by
  the spec (`consent:<artifactId>:sample`) and `localStorage` is per browser
  profile, which is where a viewer identity lives in this harness anyway.
- **Tier substitution is the identity.** `modelTierApplied` is always the
  tier asked for; a self-host has no plan that would substitute one.
- **A cached answer replays as a single `text` delta**, not re-chunked, so
  `onText` still renders it but the pacing differs from a live answer.
- **`prompt_too_large` for a tool round that outgrows the context** is not
  detected: the API's own error surfaces as `invalid_request` instead.
- **Backend state is per process.** The tool-results lane holds waiting calls
  in memory, so the shell must reach the same process that started the
  stream — true for the single-process harness, not for a cluster.
- `resetSampleBrokerState()` and `fakeBackendCallCount()` exist for tests
  only; nothing in the runtime path calls them.

## How to test

```sh
npm run build
npx vitest run test/sample                 # frame validation + lifecycle, broker, server
npx playwright test e2e/sample.spec.ts     # fixtures/sample.html through the real stack
```

The unit tests need no browser: `frame.test.ts` drives the whole call
lifecycle over a fake `RpcHost`, `broker.test.ts` over a fake `fetch` and
`localStorage`, and `server.test.ts` starts the real server on ephemeral
ports with `SAMPLE_BACKEND=fake` and a temporary `DATA_DIR`.

The e2e opens `fixtures/sample.html` — an ask box with streaming output, a
Stop button, a `json()` call, a page tool and an image made in the page —
and checks the consent dialog (allowed and declined), streaming deltas,
cancellation with the partial kept, Stop while the dialog is still up (no
request reaches the backend at all), the tool round, the cache
(`cache: false` asks again), `images_unavailable` in a view that serves no
images, and `not_granted` for a view-only viewer.
