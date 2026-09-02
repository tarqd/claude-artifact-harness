# `db` — persistent realtime document store

The page-facing API is `reference/contract/0.2.32/db.d.ts`; the wire protocol
is `docs/surface-area.md` §5.9. A page written for claude.ai runs here
unchanged: same methods, same argument shapes, same error codes, same
`__frame_db_ev` snapshot events.

```
frame.ts    the namespace: doc/collection refs, query builders, snapshots,
            the subscription mirror
broker.ts   the shell half: one POST per verb, one websocket lane per view,
            mirror diffing into added/modified/removed ops
server.ts   HTTP routes + the lane, identity, rules, `me` resolution
rules.ts    access rules: sharing levels, inheritance, `{self}` privacy
store.ts    the filesystem document store: writes, leases, queries, limits
```

## What is implemented

**Frame (`frame.ts`).**

- `db.doc(path)` / `db.collection(path)` and the builders on refs
  (`ref.collection()`, `collection.doc()`, `collection.add()`). They are pure
  and synchronous, and throw a `TypeError` naming the broken rule — including
  the segment count on a parity failure — exactly where the path is written.
  The grammar is the documented one: segments `^[A-Za-z0-9_\-.~:@+]+$`, never
  `.` or `..`, ≤ 200 bytes per segment, ≤ 1000 bytes and ≤ 16 segments per
  path, even segment count for documents and odd for collections.
- `get`, `set`, `update`, `delete`, `acquire` on a document; `where` /
  `orderBy` / `limit` / `get` / `onSnapshot` on a query. Every terminal call
  rejects and never throws (sync throws are converted by `ctx.pipe().wrap`),
  with `{code, message}` plain objects.
- Argument validation before anything is posted: plain JSON only, ≤ 40 levels,
  ≤ 131072 entries per container, ≤ 286720 bytes serialized → `invalid_argument`.
- Query validation at the terminal call (builders stay pure): ≤ 10 filters,
  the nine documented operators, `in` / `not-in` arrays ≤ 30, at most one
  `orderBy`, `limit` 1–1000.
- `onSnapshot` for documents and queries on the mirror-and-ops model: the
  shell sends index-based splices, this module keeps one mirror array per
  subscription and applies them. Snapshots, their bodies and `docs` arrays
  are frozen; a document that did not change is the **same object** across
  deliveries; `docChanges()` reports `added` / `modified` / `removed` with
  `oldIndex` / `newIndex`, and a `removed` change carries the last body the
  listener saw. Client-minted ids are 20 base-36 characters.
- At most 64 active subscriptions per view — refused in the frame, in the
  broker and on the lane, because only the trusted sides can be believed; the
  65th is refused with `resource_exhausted` on the error callback
  (asynchronously, after `onSnapshot` has returned its `Unsubscribe`). Without an error callback a
  terminal error goes to `reportError` and the listener still dies.
  `Unsubscribe` is idempotent. `pagehide` releases every subscription.
- Terminal `unavailable` on a call the shell never answers (the RPC client's
  `onTimeout`). A pushed `unavailable` on a live subscription is swallowed —
  delivery falls back to refresh, as the contract requires. A `revoked` event
  kills every listener once and makes later calls reject `revoked`.

**Broker (`broker.ts`).** One same-origin POST per verb carrying the viewer
cookie (no token ever reaches the frame). Per view it keeps a mirror of every
subscription and opens **one** websocket lane to `/api/frame/db/ws`. Every
delivery is stamped when it is issued, so a slow HTTP refresh can never move a
mirror backwards over a lane push that landed while it was in flight. Row sets
from the lane are diffed against the mirror into the `ops` the frame replays;
`fromCache` is true exactly when the lane is not connected, and
`hasPendingWrites` while this view has a write in flight. When the lane drops,
delivery falls back to a 30 s refresh and the lane reconnects with backoff.
A write is applied to this view's mirrors before it is sent — the writer sees
its own row at once, in a delivery marked `hasPendingWrites: true` — and the
same write refreshes those subscriptions when the server answers, which
clears the flag and rolls the row back if the write was refused. The local
apply runs the server's own filters, ordering and merge (`query.ts`), so the
optimistic view is the view the confirmation brings. A subscription killed on the refresh path is unsubscribed on the
lane too, and the refresh timer stops as soon as nothing is subscribed.
`dispose` tears the lane and timers down when the view remounts.

**Server (`server.ts`, `store.ts`, `rules.ts`).**

- `POST /api/frame/db/:id/call` (verbs), `POST /api/frame/db/:id/subscribe`
  (mints a signed lane grant for ONE subscription id), `WS /api/frame/db/ws` —
  all on the shell origin. The lane checks `Origin`, reads identity from the
  `av`/`ao` cookie pair exactly as the HTTP path does, and refuses a grant
  minted for another viewer, artifact or subscription id, so a frame-origin
  page cannot reach another artifact's rows and one grant cannot be replayed
  into unbounded subscriptions.
- One JSON file per document under `artifacts/<id>/db/`, an in-memory index
  rebuilt on first touch, and a single-process write lock per artifact.
  Last-writer-wins; `update` merges nested objects recursively, replaces
  everything else, and rejects `invalid_argument` when the document is
  absent; `delete` is idempotent and leaves nested documents alone.
- Leases: `ttlMs` defaults to 30000 and is clamped to [1000, 600000] (never
  rejected); a busy lease resolves `{acquired: false, expiresAt}` and never
  names the holder; renewal requires the same holder; `data` merges on grant.
- Queries: the nine operators, one `orderBy` (missing field sorts last),
  default order by document id, `limit` 1–1000, direct children of the
  collection only.
- Limits: documents ≤ 256 KiB serialized and ≤ 32 levels deep
  (`invalid_argument`), 5000 documents per artifact (`quota_exceeded` on
  create — writes to existing documents still succeed).
- Rules by sharing level from `capabilities.db.config.rules`, with the two
  platform rules always present: root (`read: "view"`, `write: "interact"`)
  and the private `data/users/{self}`. Levels inherit down and a deeper rule
  may loosen or tighten; a rule's write level is never below its read level;
  the owner meets every level but not `{self}` privacy. `{self}` works under
  any prefix; a rule declared at a `{self}` rule's prefix must set both levels
  — including at `data/users`, whose `{self}` rule the platform supplies, so a
  half-declaration there is refused instead of opening every private subtree. A read that is not permitted looks like a missing document
  (`exists: false`, omitted from queries and subscriptions); a write that is
  not permitted rejects `invalid_argument`.

## Deviations from the platform, and why

- **Path grammar is always enforced in the frame.** `surface-area.md` §5.9
  says the client-side check is gated on `__frame_init.changes` carrying
  `db-path-call-site`, but no spine `changes` id exists, and `db.d.ts` states
  flatly that the builders throw a `TypeError` synchronously. This slice
  follows `db.d.ts` and throws unconditionally — a deliberate divergence from
  the wire spec, not a gate this code reads; the server validates every path
  again regardless.
- **The lane carries rows, not ops.** The server pushes the full row set for
  a subscription and the broker computes the ops. claude.ai diffs further
  upstream (`store:db` frames on the frame-sync socket). Doing it in the
  broker means the realtime path and the refresh fallback share one diff, so
  the two delivery paths cannot drift — which is the property the contract
  actually promises the page.
- **Latency compensation covers the writes this view can place.** A `set`
  or `delete` is applied to every subscription that holds the document, and
  an `update` to every subscription that already holds the document being
  merged into — an `update` against rows this view does not hold (filtered
  out, or never fetched) waits for the confirming refresh rather than
  inventing a row. A subscription is matched by its path or collection, with
  a `me` segment resolved against this viewer's id; any other server-side
  path rewriting is not reproduced here, and those subscriptions also just
  wait. Everything else follows `db.d.ts`: the row appears immediately with
  `hasPendingWrites: true`, and the confirmation (or the refusal, rolled
  back) clears it.
- **A query document's `metadata` is fixed at the delivery that created it.**
  The contract requires an unchanged document in a `QuerySnapshot` to be the
  same object across deliveries; keeping that identity means its `metadata` is
  the metadata of the delivery that produced it. The `QuerySnapshot`'s own
  `metadata` — and the `DocumentSnapshot` a document subscription delivers —
  is always the current delivery's, re-dressed around the same frozen body so
  `data()` identity survives.
- **Rule declarations are validated at compile time, not at publish.** The
  admin API is spine-owned, so a bad `rules` declaration cannot be refused at
  publish; `compileRules` reports the errors and the view falls back to the
  defaults (fail closed), rather than running a half-understood declaration.
- **Not implemented:** the per-viewer call-rate limit and the
  concurrent-write / active-lease budgets (other `resource_exhausted`
  sources); the query scan cap exists but is unreachable below the 5000
  document cap. Nothing here backs off, so a page cannot observe them.
- **`data/users/me/...` is a harness extension.** The segment right after any
  `{self}` prefix may be spelled `me`, and the server resolves it to the
  calling viewer's id, so a page can reach its own subtree without the `user`
  capability. `db.d.ts` says the platform recognises no such alias — only the
  awaited `Claude.user.id()` value — so the fixture and the e2e address the
  subtree by the real id, and nothing here depends on the alias.
- **Single process.** The in-memory index and the change listener are per
  process, matching the spine's store. Two server processes over one
  `DATA_DIR` would not see each other's writes live.

## How to test

```
npm run build
npx vitest run test/db          # grammar, mirror diff, rules, store, HTTP + lane, broker
npx playwright test e2e/db.spec.ts
```

The e2e opens `fixtures/db.html` in **two browser contexts** — two viewer
cookies, so two viewers — and proves that one page's `set()` reaches the
other page's `onSnapshot` live, that an update is a `modified` op and a
delete a `removed` op, and that `data/users/<viewer id>/profile` is a
different document for each viewer: reading the other's path sees
`exists: false`, writing it rejects `invalid_argument`. The second spec
drives the page-facing surface directly (frozen snapshots, `add()` ids,
leases, the 64-subscription cap, and the synchronous `TypeError`s).

`test/db/server.test.ts` starts the real server on ephemeral ports with a
temporary `DATA_DIR` and speaks the lane protocol with a raw `ws` client.
