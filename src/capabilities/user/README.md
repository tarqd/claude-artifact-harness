# `user`

Viewer identity for a page: who is looking, whether they own or may edit the
artifact, their display name and avatar, and the names behind the ids a page
already holds (a db row's author, a room peer). Wire shapes and error codes
follow `docs/surface-area.md` §4 and §5.1 and `docs/analysis/shell.md` §4–§5,
so a page written for claude.ai behaves the same here.

```
src/capabilities/user/
  identity.ts   pure helpers shared by all three sides (colour, avatar, normalisers)
  frame.ts      the page-facing namespace, bundled to /_runtime/user.js
  broker.ts     the shell's __frame_cap handler → the shell's own backend
  server.ts     the backend routes (shell origin, cookie identity)
  store.ts      the viewer directory on disk
```

## The page-facing surface

| Member | Answer | Backend call |
|---|---|---|
| `id()` | `string \| null` | none — `__frame_init` config |
| `isOwner()` / `canEdit()` | `boolean` | none — config |
| `name()` | `string` (`""` when unknown) | `profile` |
| `avatarUrl()` | `string \| null` | `profile` |
| `email()` | `string \| null` | `email`, only with the scope |
| `me()` | `{id, name, avatarUrl, color, email, isOwner, canEdit}` | `profile` (+ `email`) |
| `profiles(ids)` | `Record<id, {id, name, avatarUrl, color, email, isMe}>` | `profiles([ids])` |
| `search(q)` | `Profile[]` | `search([q])` |

Implemented as documented:

- **Nothing ever rejects.** A refusal, a malformed reply, or no reply at all
  becomes the benign default (`null`, `false`, `""`, `[]`, an unresolved
  profile). The RPC client uses the documented 20 s budget with the `u` id
  prefix and, on timeout, *resolves* `null` instead of rejecting
  (`RpcOptions.onTimeout`). Synchronous throws cannot escape either: every
  member goes through `ctx.pipe("user").wrap`.
- **Deterministic identity for unresolved ids.** A hash of the id picks one
  of six swatches and a data-URI circle avatar (`identity.ts`), so an id the
  directory cannot resolve still renders, and renders the same way every
  time, on every side. `me()` and `profiles()` fill in that placeholder for a
  profile with no stored picture; `avatarUrl()` alone answers `null` then,
  as the platform's module does. The palette, hash and data URI are the
  platform's own, byte for byte (pinned by the conformance run).
- **Cache until the tab comes back.** Resolved profiles (the viewer's own
  included) are cached and dropped on `visibilitychange` when the document
  is visible again, so a page left open overnight redraws with current names.
  Each fetch carries the cache epoch it was sent under: a reply that was
  already in flight when the tab came back still answers its own caller, but
  never repopulates the cleared cache. Concurrent readers of `name()`,
  `avatarUrl()`, `me()` and `email()` share one round trip.
- **`search` is latest-wins.** The query is trimmed to 100 characters; a
  superseded call resolves with the newest call's rows, so a per-keystroke
  caller cannot paint an older list over a newer one. Emptying the box
  supersedes too — stale rows never repaint a list the page just cleared.
- **`profiles(ids)` answers for every id.** The wire batch stays at 128 ids
  and a longer list is chunked (up to 8 batches); ids past that keep their
  unresolved placeholder. The returned record always has a key per requested
  id, so page code indexing it never finds `undefined`.
- **Scopes are honoured frame-side.** Without `profile` no directory call is
  made at all; without `email` no `email` call is made.

## Wire protocol

Frame → shell, `cap: "user"`, ids `u1`, `u2`, …:

| method | args | result |
|---|---|---|
| `profile` | `[]` | `{id, name, avatarUrl, email} \| null` |
| `email` | `[]` | `{email: string \| null}` |
| `profiles` | `[ids]` | `Record<id, {id, name, avatarUrl, email}>` |
| `search` | `[q]` | `[{id, name, avatarUrl, email}, …]` |

`color` and `isMe` are derived in the frame and never sent. Any other method
is refused with `capability_disabled`; the frame swallows that like any other
error, so a page built against a newer contract degrades instead of breaking.

## Backend (all on the shell origin)

Identity is the signed viewer cookie, so these are reachable from the shell
and never from the frame origin, which has no cookie. The broker adds the
artifact id from the boot record — a page cannot name another artifact.

| Route | Purpose |
|---|---|
| `GET /api/account[?slug=<artifactId>]` | the caller's own profile; with `slug` *and* the boot token, records them as a peer of that artifact |
| `POST /api/frame/user/profile` `{name}` | set the caller's display name (shell/tooling only — the namespace has no setter) |
| `POST /api/frame/user/email/<artifactId>` | `{email: null}`; `not_granted` without the `email` scope |
| `POST /api/frame/user/profiles/<artifactId>` `{ids}` | resolve ids |
| `POST /api/frame/user/search/<artifactId>` `{q}` | search by name; writers only |

Storage (`store.ts`), under `DATA_DIR`:

```
users/profiles/<viewerId>.json   {id, name, updatedAt}
users/peers/<artifactId>.json    {ids: [viewerId, …]}
```

Every route but the bare `GET /api/account` refuses a request that carries no
viewer cookie. Identity is minted by reading your own account (what opening a
page does), never by posting at a write endpoint, so a cookieless client can
neither name itself nor touch a directory. Writes are rate-limited per client
address.

Joining a peer list takes more than a cookie. The broker forwards the signed
asset token from the boot record in `x-artifact-frame-token`, and the backend
records the viewer only when that token names *this* artifact and *this*
viewer — proof the shell really rendered the artifact for them. A token that
has since expired is not an error: the viewer joined at load, and a
long-open page keeps reading the directory.

The peer list is the privacy boundary. A viewer becomes a peer of an
artifact by opening it (the page's first `profile` call). `profiles(ids)`
resolves only peers of the calling artifact plus the caller, so one artifact
can never resolve another's audience; `search`, which is enumeration, also
requires a writer (`owner`/`admin`), as it does on claude.ai. Ids that are
not resolvable are simply absent from the answer, and the frame draws its
deterministic placeholder for them.

## Deviations from the platform, and why

1. **No real accounts.** v0 has no user records beyond the viewer cookie:
   `avatarUrl` is always `null` from the backend (the frame's data-URI circle
   stands in) and `email()` always resolves `null`, which the contract
   explicitly allows. The `email` scope gate is implemented and tested so the
   wire path is real; only the address book is missing.
2. **Display names are self-service.** `POST /api/frame/user/profile` lets a
   viewer name themselves, because nothing else in this harness knows a
   human's name. The platform's directory comes from the account service.
   The endpoint is deliberately *not* a broker verb: the documented namespace
   has no setter, so no page can rename a viewer.
3. **`profile` scope is granted by default.** The shell forwards
   `profile: true` for every page that declares `user`
   (`src/server/boot.ts`), so the backend grants `profile` whether or not the
   declaration lists scopes; `email` must be declared. Both spellings of the
   declaration are accepted (`{user: {scopes: […]}}` and
   `{user: {config: {scopes: […]}}}`).
4. **`profiles` does not require a writer.** shell.md notes "peers + canEdit +
   profile scope" for the directory. Requiring a writer to resolve an id
   would make the common case — a reader seeing who wrote a db row — fail, so
   `profiles` needs only the peer relationship and `search` keeps the writer
   requirement.
5. **The colour palette is ours.** The platform's six swatches are not
   observable from the runtime modules. The *rule* (deterministic hash of the
   id over six swatches, plus a data-URI circle avatar) is reproduced
   exactly; the hex values are a choice.
6. **Peers are remembered, capped at 1000 per artifact**, least recently seen
   first out — so a burst of new viewers cannot push an active one (the
   owner, say) out of the window. The platform's directory is unbounded.

## How to test

```
npm run build
npx vitest run test/user
npx playwright test e2e/user.spec.ts
```

- `test/user/identity.test.ts` — colour/avatar determinism and the shared
  normalisers.
- `test/user/frame.test.ts` — the namespace over a fake `RpcHost`: local
  members send nothing, caching and the visibility reset, the 20 s timeout
  resolving `null`, refusals and malformed replies becoming defaults,
  `profiles` placeholders, `search` latest-wins.
- `test/user/broker.test.ts` — verb → backend path, argument normalisation,
  that only requested ids come back, the boot token on every request, and
  that an address never rides along on a verb other than `email`.
- `test/user/server.test.ts` — the endpoints over real sockets: name
  storage, scope gates, peer scoping across two artifacts, reader vs writer
  search, the write gate (no session, no token, wrong artifact), the rate
  limiter, the `email` verb driven through the broker against the real
  backend, plus the store directly (including LRU eviction).
- `e2e/user.spec.ts` — `fixtures/user.html` through the real shell: the owner
  sees their own name, colour and data-URI avatar and can search; a second,
  anonymous viewer is neither owner nor writer, resolves the owner as a peer,
  and gets `[]` from `search`; a page that never declared `user` gets `null`
  from `use()`.
