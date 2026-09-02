# `assets`

Upload, list and delete the blobs an artifact serves from its own origin at
`/_blob/<id>` — the capability described in `docs/surface-area.md` §5.4.

```js
const assets = await claude.use("assets");
const shot = await assets.upload(pngBlob);          // {id, url, type, size, createdAt}
img.src = shot.url;                                  // "/_blob/<32 hex>"
const { assets: all, usage } = await assets.list();  // usage = {count, bytes}
await assets.delete(shot.url);                       // id or /_blob/<id>
```

## What is implemented

**Frame** (`frame.ts`, page-facing, id prefix `e`, 130 s budget,
`upstream_error` on timeout)

- `upload(blob, {type?})` — wire `["<Blob>", "<contentType>"]`. The Blob crosses
  `postMessage` by structured clone; an explicit `{type}` wins over the Blob's
  own `type`, and the type is reduced to a bare media type (no `; charset=…`).
- `list()` — follows the backend's `next` cursors for **at most 16 pages** and
  returns `{assets, usage}`. It also stops if a cursor ever repeats, so a
  misbehaving backend cannot make `list()` hang.
- `delete(idOrUrl)` — accepts a 32-hex id or `/_blob/<id>` (a `?query`/`#hash`
  is ignored); anything else is `invalid_request` without a round trip.
- Validation before the wire: accepted media types exactly as §5.4 lists them,
  20 MiB per blob, 2 MiB for `image/svg+xml`. §5.4 sets caps and no minimum, so
  an empty Blob is stored as an empty asset rather than refused.
- Every method rejects, never throws; every rejection carries one of the four
  documented codes — `invalid_request`, `too_large`, `unsupported_type`,
  `upstream_error` — or an unchanged lifecycle code (`capability_disabled`,
  `capability_removed`, `not_granted`, `transform_error`).

**Broker** (`broker.ts`, shell side) — three same-origin `ctx.api` calls
carrying the viewer's cookie. `upload` posts the Blob as a **raw body** with
the validated type in `Content-Type`, so 20 MiB of bytes stay 20 MiB instead of
becoming ~27 MiB of base64 JSON. It re-runs the type and size checks (a frame
is not a trusted validator), refuses a viewer who cannot write before asking
the backend, and folds any undocumented backend code into `upstream_error`.

**Server** (`server.ts`)

- Storage under `DATA_DIR/artifacts/<artifactId>/blobs/`: `<blobId>` holds the
  bytes, `<blobId>.json` is the sidecar (`{id, url, type, size, createdAt, seq,
  by}`), `usage.json` is the usage record. Every read and write for one
  artifact is serialised through a promise chain, so a page is never handed
  rows and a usage count that disagree. Usage is always derived from the
  sidecars; `usage.json` is a cache that is rewritten whenever it disagrees
  with them (through a uniquely named temp file), never trusted on its own.
- **Ordering.** `seq` is a per-artifact counter assigned under the write lock,
  and the sort key is `"<seq>|<createdAt>|<id>"`, so two uploads in the same
  millisecond cannot tie: list order is always upload order. The cursor is that
  key and is opaque to the page.
- **Per-artifact ceiling** (a self-host restriction §5.4 does not name): 512
  MiB across at most 2000 blobs, enforced inside `put` under the lock and
  refused with the documented `too_large` (HTTP 413). `new BlobStore(dir,
  {maxBytes, maxCount})` takes both for tests.
- **The upload body is metered as it arrives.** An oversized upload is refused
  from `Content-Length` when the client declares one, and otherwise as soon as
  the running total crosses the cap for its type — a chunked body that declares
  no length is never buffered whole. The refusal carries `connection: close`,
  since the rest of the body was never read.
- Shell origin (viewer cookie; `admin` or `owner` to write, and behind the
  spine's origin guard — `src/server/guards.ts` — like every other write here):
  - `POST /api/frame/blob/:id/upload` — raw body, `Content-Type` header. This
    is the one lane exempt from the guard's "a caller that sends no `Origin`
    and no `Sec-Fetch-Site` must post `application/json`" rule, since the body
    is the asset itself. Such a caller is instead refused the content types a
    forged cross-site form could have sent — of the accepted types, that is
    `text/plain`. Every other accepted type, and any request from the shell
    page, is unaffected.
  - `POST /api/frame/blob/:id/list` — `{after?}` → `{assets, usage, next?}`
  - `POST /api/frame/blob/:id/:blobId/delete` → `{id, deleted}`
- Frame origin: `GET`/`HEAD` `/_blob/:blobId` — the stored bytes and content
  type, `cache-control: public, max-age=31536000, immutable`,
  `x-content-type-options: nosniff`. An id that is not 32 lowercase hex is this
  slice's own 404, and a `__frame_t` that is forged, expired or minted for
  another artifact is a 403, exactly as on every other frame path.
- **Cross-artifact boundary**: the frame-origin read resolves the artifact from
  the *host label* (or the `x-artifact-id` header the spine's own listener sets
  for the `/_a/<id>/` prefix form — a client-supplied one is stripped before the
  app sees it). `<B>.localhost/_blob/<A's id>` therefore looks under B's
  directory and 404s. Blob ids and artifact ids are both matched against strict
  32-hex regexes before they touch a path, so no reference can traverse.
- No token ever reaches the frame; the broker only ever sends the shell's own
  same-origin path.

## Deviations, and why

- **`/_blob/<id>` is this slice's route, on the frame origin.** `serve.ts` used
  to hold the path with a 501 placeholder registered before
  `mountCapabilityRoutes`, which — Hono ends a chain at the first handler that
  returns — hid the slice's own registration; the slice worked around it by
  wrapping the frame app's `fetch`. The placeholder is gone, the wrapper with
  it, and `apps.frame.on(["GET","HEAD"], "/_blob/:blobId", …)` serves the path
  inside the frame middleware, where the `__frame_t` refusal and the identity
  in `frameViewer` come from the spine rather than being repeated here. One
  visible consequence: `/_blob/` with no id matches no route at all, so it is
  Hono's own 404 rather than this slice's `not found` body.
- **Authorization uses a documented code.** §5.4 names four codes and
  `not_writer` is not among them, so a viewer who may not upload or delete is
  refused with `upstream_error` ("this viewer cannot change this artifact's
  assets"), HTTP 403. A page written for claude.ai only ever branches on the
  four documented codes. The same reasoning covers "no such artifact" and "this
  artifact does not declare assets", which are `invalid_request` (404/400) —
  the broker cannot reach them anyway, because the shell's dispatcher refuses an
  undeclared capability first.
- **`list` is readable by any viewer; `upload`/`delete` need `admin` or
  `owner`.** Blobs are already served anonymously on the frame origin (an
  `<img>` carries no credential), so listing them tells a viewer nothing the
  page could not show them. Writes follow the spine's `auth.canEdit`.
- **Shapes §5.4 leaves open.** `upload` resolves `{id, url, type, size,
  createdAt}`; `list` resolves `{assets: AssetRecord[], usage: {count, bytes}}`
  and pages with `next`; `delete` resolves `{id, deleted}`. A page that only
  reads `.url` and `.assets` — what the documented signature promises —
  behaves identically here.
- **Delete is idempotent.** Deleting an id that is already gone resolves
  `{deleted: false}` rather than failing: there is no "not found" code in the
  documented set, and the page's intent ("this id must not resolve") holds.
- **Page size and cursors.** One `list` page carries 100 rows; the cursor is
  the sort key of the last row returned, so a row deleted between two pages
  cannot make the next page skip its neighbour. The cursor is opaque to the
  page, which only sees the flattened result.
- **Serving details.** `text/*` and `application/json` are served with
  `; charset=utf-8`. Every blob also carries
  `content-security-policy: default-src 'none'; sandbox`, which is inert for
  `<img>`, `<video>`, fonts and `fetch` but stops an uploaded SVG from
  executing if it is ever navigated to directly on the artifact's origin.

## Spine changes requested

None outstanding. The one this slice needed — dropping the `/_blob/:blobId`
placeholder in `src/server/serve.ts` so a slice route can claim the path —
landed in the integration pass.

## How to test

```bash
npm run build
npx vitest run test/assets
npx playwright test e2e/assets.spec.ts
```

- `test/assets/protocol.test.ts` — the accepted type list, the two caps, the
  `delete(idOrUrl)` grammar, the four error codes.
- `test/assets/frame.test.ts` — the wire envelope under an `RpcHost` double:
  `[Blob, type]`, the 16-page bound and the repeated-cursor guard, the
  rejections that never reach the wire, error folding, the 130 s budget.
- `test/assets/broker.test.ts` — which backend call each verb makes, the raw
  body, the write gate, and what a page can be told.
- `test/assets/server.test.ts` — the real server on ephemeral ports over a
  temporary `DATA_DIR`: store layout, gates, paging over 101 uploads (upload
  order holds within one millisecond), the streaming size cap on an undeclared
  body, usage derived from the sidecars over a stale cache, the frame-origin
  headers, `HEAD`, the 404 for a malformed id, the 403 for a forged
  `__frame_t`, the per-artifact ceiling, the slice's own frame route on a bare
  Hono app, and that one artifact's origin never serves another's blob.
- `e2e/assets.spec.ts` — `fixtures/assets.html` uploads a canvas PNG, renders
  it back from `/_blob/<id>`, lists it with its usage, deletes it, and proves a
  second artifact's origin gets a 404 for the same id (checked both from Node
  and from a real browser on that origin).
