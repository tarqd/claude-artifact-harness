# `downloads`

Offer a file the page generated to the viewer. One method:

```js
const downloads = await claude.use("downloads");
if (!downloads) return hideSaveButton();          // design for absence
await downloads.save({ filename: "summary.csv", data: csvText });  // {status: "saved"}
```

Contract: `reference/contract/0.2.32/downloads.d.ts`. Wire protocol:
`docs/surface-area.md` §5.3 (and §4 for the envelope and the reply budget).

## What is implemented

Everything the contract describes, with no backend at all: the bytes go from
the frame to the shell over `postMessage` and from the shell to the browser
through an object URL. Nothing is uploaded, stored or logged.

**Frame (`frame.ts`)** — mounts `{save}` under `downloads`.

- `data` accepts all four documented shapes. A string is UTF-8; an
  `ArrayBuffer` is **transferred** (the caller's buffer is detached before the
  call returns, as documented); an `ArrayBufferView` is copied, `byteOffset`
  and all; a `Blob` is copied and its own `type` is ignored — MIME comes from
  the extension.
- `bad_request` for the caller bugs the contract names: a request that is not
  an object, a non-string `filename`, a `filename` over 512 characters, and
  data that is empty, detached or of no supported type. None of these reach
  the shell.
- Wire shape `[{filename, bytes}]` with the buffer in the `postMessage`
  transfer list (`transferringHost`), so a 16 MiB save costs no copy.
- Reply budget 150 s, timing out as `unavailable`; an `__frame_cap_ack`
  extends it to 900 s.
- Every failure is a rejection, never a throw: the validation runs inside
  `ctx.pipe("downloads").wrap("save", …)`.

**Broker (`broker.ts`)** — the shell decides, in this order:

1. **Filename.** Sanitized to a bare basename (directory separators,
   control characters, `<>:"|?*`, leading dots and trailing dots/spaces all
   go), extension lower-cased, final name capped at 200 characters. The
   viewer confirms that final name, which may differ from the page's.
2. **Allowlists.** `gif png jpg jpeg webp mp4 webm txt json md` always;
   `docx pptx epub csv ttf html svg pdf` while the second list is switched on.
   Off the lists → `rejected_extension`; on the second list while it is off →
   `extension_not_enabled`; no usable extension → `rejected_extension`.
3. **Size.** Over 16 MiB → `too_large`.
4. **Rate.** One undecided prompt at a time (`rate_limited`, first-wins) and
   at most five prompts a minute per artifact, on a sliding window
   (`rate_limited`). A declined prompt still counts; a refused filename or an
   oversized file never does, because it never prompted.
5. **Consent.** `ctx.ack(id)` first, then `ctx.consent` with the final name
   and a human-readable size, over an iframe the shell makes `inert`. "No" is
   `declined`, and a refusal is never remembered — the next offer asks again.
6. **Delivery.** `new Blob([bytes], {type: mimeFor(extension)})` → object URL
   → a hidden `<a download>` in the shell document, clicked and removed, with
   the URL revoked a minute later. A view with no save surface answers
   `unavailable`.

**Server (`server.ts`)** — deliberately empty; see the note in the file.
claude.ai has no endpoint for this either (surface-area.md §12).

## Deviations from the platform, and why

- **The extra-extension switch is not a server env var.** The platform's
  toggle is a boot flag, and the spine owns the flag list
  (`src/server/boot.ts` emits only `artifact_files`), so this slice cannot
  add one without editing spine files. The broker therefore resolves the
  switch as: boot flag `downloads_extra_extensions` /
  `no_downloads_extra_extensions` if either is ever present → the artifact's
  own `{"downloads": {"config": {"extraExtensions": false}}}` declaration →
  **on**. Wiring `DOWNLOADS_EXTRA_EXTENSIONS` to the flag is one line in the
  spine, and the integration pass deliberately did not make it: nothing in the
  harness produces the flag today, so the env var would be untested surface.
  The per-artifact declaration already covers the tested behaviour, and
  nothing here changes if the flag is wired later.
- **The broker acks before it prompts.** The documented table gives
  `downloads` a 150 s budget and no ack. But the contract also says a viewer
  who "lets the prompt expire" gets `declined`, which needs a prompt the shell
  can withdraw — and `src/shell/consent.ts` has no way to dismiss a dialog
  programmatically. Racing a timer would leave a modal up over an inert frame
  forever. So instead of expiring the prompt this broker acks it, which
  extends the frame's budget to 900 s: a viewer reading the question can never
  turn it into a spurious `unavailable`. Pages cannot observe an ack, and the
  150 s budget still applies to a shell that answers nothing at all.
- **`invalid_content` is re-mapped to `bad_request`.** That code is the RPC
  client's own (arguments that would not clone); it is not in the contract's
  list, and it means the same thing there — a caller bug.
- **Final names are capped at 200 characters** even though the input may be
  512. The contract already warns that the final name may differ; 512-byte
  names are rejected outright by common file systems.
- No native share sheet: `status: "saved"` here always means a browser
  download was started.

## How to test

```
npm run build
npx vitest run test/downloads          # frame envelope + broker rules
npx playwright test e2e/downloads.spec.ts
```

`test/downloads/frame.test.ts` drives the namespace through an `RpcHost`
double: the envelope and its transfer list, the four data shapes, every
`bad_request`, and the 150 s / 900 s budgets on fake timers.
`test/downloads/broker.test.ts` drives the broker through a `BrokerContext`
double: filename resolution, both allowlists and the switch, the cap, the rate
limit, the prompt copy, and `domDelivery` against a fake document.

`e2e/downloads.spec.ts` loads `fixtures/downloads.html` in the real shell: the
page builds a CSV from its own table and a PNG from a canvas, and the test
asserts the consent dialog's text, the Playwright download event (filename and
bytes — including the PNG signature), the detached ArrayBuffer, and the
`declined` / `rejected_extension` / `bad_request` / `too_large` /
`rate_limited` / `extension_not_enabled` paths.
