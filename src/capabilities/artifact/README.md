# `artifact` (alias `self`)

Self-publish: the page hands the shell a complete replacement page, or just
the files that changed, and the shell mints a new immutable version.

## Implemented

- `publish(html)` — compare-and-set against the version this view is running.
  Rejects `conflict` (carrying `live`) when someone published first,
  `not_writer` for a read-only viewer, `invalid_content` when the string does
  not start with a doctype, `too_large` past 16 MiB.
  On success the shell reloads this view to the new version; other open views
  notice within `VERSION_POLL_MS` (5 s by default).
- `publish(files)` — gated on the `artifact_files` flag, which the shell sets
  only for a viewer that can write. Validated in the frame exactly as the
  platform does (≤ 256 paths, bare media types, extension inference), then
  encoded for JSON transport (`utf8` or `base64`). Rejects `too_large` when a
  version's files — the submitted ones plus those carried over — pass 16 MiB.
  On success **this** view keeps running and only other views reload.
- The same frozen namespace is mounted as both `artifact` and `self`.

## Stubbed

- `edit(ops)` and `sync(fn)` reject `capability_disabled`: they are live-doc
  verbs, and v0 serves classic (versioned) artifacts only. `sync` still
  rejects a non-function argument with `transform_error` first, as the
  contract specifies.
- No live-doc replica/morph/patch protocol, no `data-id` stamping.
- Reload fan-out is polling, not a websocket lane.

## Wire

| Direction | Message |
|---|---|
| → | `{__frame_cap, cap:"artifact", id:"s<n>", method:"publish", args:[html \| files]}` |
| ← | `{__frame_cap_r, id, result:{version}}` or `{..., error:{code, message, live?}}` |

Backend: `POST /api/frame/self/<artifactId>` on the shell origin with
`{baseVersion, html}` or `{baseVersion, files}` → `{version}`, 409 on
conflict.

## Testing

- `test/artifact/*.test.ts`: envelope injection, compare-and-set publish,
  files validation, path helpers, RPC timeout.
- `e2e/artifact.spec.ts`: `fixtures/artifact.html` through the real shell —
  the namespace resolves, `use("db")` resolves `null`, and a publish click
  produces a new version whose reloaded page shows the incremented counter.
