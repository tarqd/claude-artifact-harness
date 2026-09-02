# `room` — presence and moments

The room is everyone viewing this artifact right now. Two arms: `emit`/`on`
are moments on topics (never stored, never replayed), `presence` is one
object per open document that the platform shares, hands to newcomers and
clears when they leave.

Contract: `reference/contract/0.2.32/room.d.ts`.
Wire: `docs/surface-area.md` §8. Behaviour: `docs/analysis/sample-room.md` §2.

## Files

| file | runs in | what it does |
|---|---|---|
| `frame.ts` | the artifact iframe | the whole page-facing namespace and every timing the contract promises |
| `validate.ts` | the frame | topic grammar, the loose plain-JSON check, the presence merge, the strict `ToClaude` walker |
| `protocol.ts` | shell + server | the lane's JSON messages and the topic ACL both halves evaluate |
| `broker.ts` | the shell page | `__frame_cap` ↔ websocket lane, plus the ACL that produces `not_permitted` |
| `server.ts` | Node | one in-memory room per artifact over `ws` |

## What is implemented

**Frame** (everything a page can observe lives here; the shell is transport):

- `emit(topic, data?)` — topic grammar `^[a-z][a-z0-9_.-]{0,47}$`, the plain-JSON
  and 4 KiB checks, and a token bucket of 40/s with a burst of 80. Over budget
  the moment is **dropped and the call still resolves**, with one
  `reportError` notice per page load.
- `on(topic, handler, onError?)` — `TypeError` for a non-function handler, a
  malformed topic through `onError` on a microtask, independent registrations.
- `presence(patch)` — per-field merge, top-level `null` deletes, `__proto__` /
  `constructor` / `prototype` skipped, the **merged** object capped at
  `maxBytes` (a patch that would exceed it rejects and is not applied).
  Applied locally at once, sent whole on a trailing-edge timer of
  `ceil(1000 / presenceHz)` = 34 ms, re-sent every 20 s as a keepalive and
  within a jittered 500 ms whenever an unknown peer appears (this is how a
  late joiner collects the room without the server storing anything).
- `peers()` — a synchronous frozen snapshot, the same array until something
  changes, a frozen empty array before the first answer. Unchanged peers keep
  object identity, so a keepalive does not bump `updatedAt`.
- `onPeers(handler, onError?)` — the first delivery presents the room so far
  as `joined` (no earlier than a microtask); after that one delivery per
  animation frame carrying `joined`/`left`/`updated` as the **net** change:
  three updates in a frame are one entry, a join and leave in a frame are
  neither, and `change.peers === room.peers()`. A hidden tab's pending batch
  is flushed on `visibilitychange`.
- `connected()` / `onConnection(handler, onError?)` — fires once with the
  current state on a microtask, then on every edge. `conn up` re-asserts the
  presence object without the page re-sending anything.
- Silence sweep: peers unseen for `silenceMs` (150 s) are removed, swept every
  15 s. The peer map is capped at `maxPeers` (256).
- Terminal state (`revoked`, `not_granted`, `capability_disabled`, …): every
  listener's `onError` fires once and dies, `peers()` decays to just you,
  `connected()` reads false, `emit`/`presence` reject thereafter, and the
  message is always "The room channel is no longer available to this view."
- `sendToClaudeSession(data, options?)` — the full strict validator (4 KiB,
  depth 8, 64 keys, 64 entries, identifier keys, the format-character table
  with the emoji joiner and variation-selector exceptions and the eight-joiner
  cap), posted with `includeUserActivation` where the browser supports it.
  Keeps working after a terminal error, exactly as the contract says.
- `canSendToClaudeSession()` — a non-string answer normalises to `"off"`.
- `config.limits` (`maxBytes`, `presenceHz`, `keepaliveMs`, `silenceMs`,
  `maxPeers`) read and clamped to the documented ranges.

**Broker** — one lane per mounted view at `/api/frame/room/ws` on the shell
origin (cookie auth, matching `Origin`, shell listener only — the frame
origin can never open it), reopened with
exponential backoff. It answers `hello` with the peer id it minted for this
view and the current transport state, forwards `presence`/`emit`, translates
lane messages into `__frame_room_ev` with the `presence` / `event` / `gone` /
`conn` / `revoked` arms, and enforces the declared topic levels against the
viewer's sharing level so an unauthorised `emit` rejects `not_permitted`
rather than vanishing. `dispose` closes the lane when the view is remounted.

**Server** — a `Map<artifactId, Room>` of live connections and nothing else.
An upgrade is refused unread unless it arrives on the shell listener, carries
`Origin: <shell origin>` and a valid viewer cookie (`av`, `__Host-av` on
https — read through `Auth`, never by name); an artifact that is gone or
does not declare `room` gets the upgrade and then one `{kind: "revoked", code:
"not_granted"}`, so the frame's terminal path fires instead of the broker
reconnecting forever. A connection is one peer, named by the id the shell
minted and **bound to the viewer that presented it**: a second connection with
the same id is that view reconnecting and displaces the first, but the same id
from a different viewer is refused. Presence and event payloads are held to
the artifact's own `maxBytes` (4 KiB by default, the same cap the frame
applies on the way out), frames larger than the largest declarable limit are
never read, and each connection has a token bucket (120 messages/s burst 240,
40 emits/s burst 80) mirroring the frame's. Presence goes to everyone but the sender; a moment goes to everyone
**including** the sender, whose copy carries `isMe: true, sameTab: true` —
that is the echo pages render on. `gone` on close. The topic ACL is enforced
here too, as a backstop behind the broker's `not_permitted`.

## What deviates from the platform, and why

- **`sendToClaudeSession` cannot succeed in v0.** There is no conversation
  beside a self-hosted artifact, so `canSendToClaudeSession()` answers `"off"`
  (the contract's "not offered in this view at all") and a send rejects
  `claude_unavailable`. The frame-side validator is complete, so a page that
  gates its control on `canSendToClaudeSession` behaves identically here; only
  the outcome of a send it should never offer differs.
- **`by` is `null` for every peer**, as the v1 contract requires. The server
  knows the viewer ids — it needs them to answer "is this me?" — but sends
  only the boolean `isMe`, never an id. Two *anonymous* viewers are never
  reported as each other.
- **`kind` is always `"viewer"`.** Agent peers are flag-gated and off by
  default on the platform; nothing here admits one.
- **Peer ids are minted by the shell, not the server.** The frame needs a
  stable id in the `hello` reply before the socket is necessarily open, and
  the id must survive reconnects for the document's life. A page cannot forge
  one: the lane answers only on the shell listener, with the shell's `Origin`
  and a valid viewer cookie, so the frame never reaches it — and the server
  binds each id to the viewer holding it, so no other lane client can wear it.
- **No presence replay on the server.** Like the platform, a newcomer is
  answered by the *peers*, not by storage: the frame re-sends its own object
  within 500 ms of seeing an unknown peer.
- **The `ToClaude` node budget is two counters against one constant.** The
  platform charges nodes and string lengths against a single 16 384 budget
  with two different messages; this splits which message you get by which
  kind of node blew it. The accept/reject decision is the same.
- **Lane sockets are dropped at shutdown.** An upgraded socket keeps
  `server.close()` waiting forever, so the slice registers a
  `ctx.onShutdown` hook that destroys its own sockets first.
- Level names come from this harness's sharing model (`view` < `interact` <
  `admin` < `owner`); `admin` is exactly what `user.canEdit()` answers.

## How to test

```
npm run build
npx vitest run test/room
npx playwright test e2e/room.spec.ts
```

- `test/room/validate.test.ts` — the grammars a page sees directly, including
  the emoji joiner exceptions and the format-character table.
- `test/room/frame.test.ts` — the module under a fake clock and a fake
  animation frame (`test/room/harness.ts`): handshake, coalescing, keepalive,
  newcomer answers, the silence sweep, `onPeers` batching, the token bucket,
  the terminal state.
- `test/room/broker.test.ts` — the wire mapping and the topic ACL.
- `test/room/protocol.test.ts` — the declaration reader and level comparison.
- `test/room/server.test.ts` — two real lane clients against a real server on
  an ephemeral port: presence, echo, the ACL backstop, departure, isolation
  between artifacts.
- `e2e/room.spec.ts` — two browser contexts (two viewers) on one artifact:
  presence crosses, a moment crosses, and the sender hears its own echo
  marked `sameTab`.

`fixtures/room.html` is the cursor-sharing page: pointer moves publish a
cursor, peers are listed and drawn, moments are logged with their `isMe` and
`sameTab` stamps.

## Spine changes requested

None outstanding. The one this slice asked for landed in the integration
pass: `ServerContext.onShutdown(fn)` runs a slice's cleanup before the
listeners close, so `room` (and `db`, which held the same lane problem) drops
its upgraded sockets through the seam instead of monkey-patching
`server.close()`.
