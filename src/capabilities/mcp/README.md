# `mcp`

Call the viewer's connectors — MCP servers — from a page. Four methods:

```js
const mcp = await claude.use("mcp");
if (!mcp) return renderWithoutConnectors();                 // design for absence
const { servers } = await mcp.listTools();                  // what is connected, per the manifest
const result = await mcp.callTool("Weather", "forecast", { city: "Oslo" });
render(result.payload);                                     // structuredContent, else parsed text
const stop = mcp.watchTool("Weather", "forecast", { city: "Oslo" }, (ev) => {
  if (ev.type === "data") render(ev.result.payload, ev.result.cache?.storedAt);
}, { refetchInterval: 60_000 });
await mcp.invalidate("Weather", "forecast");                // after a write: cached reads refetch
```

Contract: `reference/contract/0.2.32/mcp.d.ts`. Wire protocol:
`docs/surface-area.md` §5.8 (and §4 for the envelope, the `c` id prefix,
the `w<rand>-<n>` watch ids and the reply budget); shell side
`docs/analysis/shell.md` §"mcp".

A page declares the servers and tools it will call — the manifest — and the
server the artifact is published to decides which of those servers exist:

```json
{"mcp": {"servers": [{"server": "Weather", "tools": ["forecast"]}]}}
```

## Files

| File | Runs in | What it does |
|---|---|---|
| `protocol.ts` | frame, shell, server | the manifest grammar, the error vocabulary, the plain-JSON rule for `input`, the order-insensitive call identity, the cache policy, result normalisation (`payload`) |
| `frame.ts` | the iframe | the namespace: validation, the `__frame_cap` client with its own ids (for `cancelCall`), watch bookkeeping and the `__frame_mcp_watch` push, `pagehide` release |
| `broker.ts` | the shell page | the manifest gate, `host:` refusal, consent per server, the result cache and its `cache` marker, coalescing, the watch registry and refetch loop, `invalidate` |
| `server.ts` | Node | `POST /api/frame/mcp/servers` and `POST /api/frame/mcp/call`: re-validation, the viewer gate, the directory lookup, timeouts, the `X-Frame-Mcp-No-Store` header |
| `directory.ts` | Node | where connectors come from: the `ConnectorDirectory` seam, the env-configured server-wide directory, and the fake (`MCP_BACKEND=fake`) |
| `client.ts` | Node | the upstream MCP client on `@modelcontextprotocol/sdk`: one lazily connected `Client` per configured server, Streamable HTTP with an SSE fallback, error mapping. The only file that imports the SDK |

## Where connectors come from

On claude.ai `mcp` calls *the viewer's* connectors: per-account servers with
per-viewer credentials, addressed by display name. This harness has no
account service, so its first directory is **server-wide**: the operator
declares named servers and every viewer shares them. The page still
addresses them by display name, and consent is still per viewer.

```bash
MCP_SERVERS='[{"name":"Weather","url":"https://weather.example/mcp",
               "headers":{"authorization":"Bearer …"}}]'
# or
MCP_SERVERS_FILE=./mcp-servers.json      # the same JSON, from a file
# or, for tests and local development with no upstream at all
MCP_BACKEND=fake
```

Each entry is `{name, url, headers?, transport?, noStore?}`: `transport` is
`http` (Streamable HTTP, the default — a server that refuses it with a 4xx
gets one SSE attempt) or `sse`; `noStore: true` marks a server whose results
the shell must never cache. A `host:` name is refused: those are reserved
for servers on the viewer's device. A configuration that cannot be read
throws at first use rather than silently serving nothing; no configuration
at all is fine, and reads as "this viewer has no connectors".

`ConnectorDirectory.resolve(viewerId, displayName)` is the seam a per-viewer
store would implement later: nothing in the broker, the routes or the frame
knows that today's directory ignores `viewerId`.

The fake directory serves three connectors: **Fake Tools** (`echo`, a
declared read; `write`, a declared write; `plain`, unannotated; `fail`,
which reports a tool-level failure; `slow`, `flaky`, `image`), **Needs
Auth** (lapsed credentials: `token_invalid`, every call `needs_reauth`) and
**No Store** (`echo`, never cached). `fakeCallCount()` tells a test a cache
hit from an execution.

## What is implemented

**Frame (`frame.ts`)** — mounts `{callTool, watchTool, invalidate, listTools}`
under `mcp`, frozen.

- `callTool` validates the names, that `input` is a plain JSON object of
  arguments (no `Map`, `Set`, `Date`, typed arrays or `BigInt`; `undefined`
  and `null` mean `{}`), the `cache` option and the `signal`; a caller bug
  rejects `bad_request` and never reaches the shell. The signal is held in
  the frame: an abort posts `cancelCall [id]` and rejects `cancelled`. The
  reply's `isError` becomes a `tool_error` rejection carrying the result;
  `payload` is `structuredContent`, else the first text block parsed as
  JSON, else that text.
- `watchTool` returns a synchronous, idempotent unsubscribe. A missing
  handler is the one synchronous `TypeError`; every other failure —
  validation, the 64-watch cap, a registration the shell refused — arrives
  as an `{type: "error"}` event no earlier than a microtask later. Data
  arrives on `__frame_mcp_watch {watchId, ev}`; unsubscribing posts
  `unwatchTool [watchId]`; `pagehide` releases every watch.
- `invalidate` posts only the arguments given; an `input` without both
  `server` and `tool` is `bad_request`.
- `listTools` folds upstream auth statuses to `connected` / `needs_reauth`
  / `unknown`.
- Reply budget `capBudgets.mcp[method]` clamped to 600 s plus 2 s (132 s
  here), `upstream_error` "no reply from shell" on expiry, 900 s once acked.

**Broker (`broker.ts`)** — the shell decides, in this order:

1. **Manifest.** `(server, tool)` outside `capabilities.mcp.config.servers`
   → `not_in_manifest`.
2. **Device servers.** A `host:<name>` server → `server_not_connected`,
   exactly what the platform answers outside the Claude app.
3. **Consent, per server.** `ctx.ack(id)` first, then one dialog naming the
   server and the tools the manifest declares for it. The answer is stored
   under `consent:<artifactId>:mcp:<server>`, the key the `permissions`
   slice reads for `state("mcp:<server>")`, so whichever surface asks first
   the other honours it. "Not now" is `not_granted` and is never asked again.
4. **Policy.** The connector's own `readOnlyHint` (from a `listTools` the
   broker keeps for a minute) decides the default: a declared read caches
   with `staleTime: 0` and `gcTime: 5 min`; a declared write never caches,
   whatever the page asks; an unannotated tool caches only when the page
   opts in. `staleTime` is capped at 5 min, `gcTime` at 24 h, `refresh`
   skips the read.
5. **Cache.** Keyed by artifact, viewer and the order-insensitive identity
   of `(server, tool, input)`; successful results only; a result the server
   marks `X-Frame-Mcp-No-Store: 1` is never stored. A hit carries
   `cache: {storedAt, revalidating: false}`; a fresh execution carries no
   marker; any `cache` field from upstream is stripped. Identical cached
   calls in flight share one execution; a caller that aborts leaves the
   shared flight running for the others.
6. **Watches.** Reads only (a wire-explicit `readOnlyHint: false` rejects).
   Registration answers first; a turn later the stored entry is replayed
   (`revalidating: true` when past `staleTime`), a refresh executes when the
   entry is missing or stale, and every later result for the identity —
   the watch's own polls, other cached callers, `invalidate` — is delivered.
   `refetchInterval` is clamped to a 30 s floor, paused while the page is
   hidden with one catch-up refetch on return. At most 64 per view.
7. **`invalidate`.** Drops the matching entries (all, one server, one tool,
   or one exact input, where `null`, `{}` and an omitted input are the same
   call) and re-executes every watched identity among them.

**Server (`server.ts`)** — the boundary a direct HTTP caller meets. Both
routes require the artifact to declare `mcp` and the viewer to be able to
interact (`view` → `not_granted`). `/servers` answers the manifest
intersected with the directory: a server the directory does not know or a
`host:` one is omitted; a server that fails to list answers with an empty
tool set and its auth status. `/call` re-checks the manifest, refuses `host:`
servers and non-object arguments, holds at most 8 calls per viewer
(`rate_limited`), gives a call 120 s and aborts it when the client goes
away, and maps every failure to a page code and a status. Results go back
as the connector produced them: `content`, `structuredContent`, `isError`.

## Deviations from the platform, and why

- **Connectors are server-wide, not per viewer.** There is no account
  service and no OAuth flow, so the `authorize` lane, the re-auth popup and
  `selection_required` never occur. `needs_reauth` is still produced when a
  configured server answers 401/403.
- **No user-activation check on consent.** The platform posts `callTool`
  with `includeUserActivation` so the shell can insist on a gesture; the
  `RpcHost` seam carries no such option, and `src/shell/consent.ts` makes
  the iframe inert instead. A page can therefore ask on load; the answer is
  still the viewer's.
- **`host:` servers are always `server_not_connected`**, and `listTools`
  omits them: a service never runs a device server, and this shell has no
  host bridge.
- **Malformed manifest entries are dropped, not refused.** The platform
  refuses an entry with no tools at publish; `src/server/admin.ts` is
  spine-owned and stores the declaration verbatim, so `readManifest` drops
  what it cannot use and the page runs for the rest.
- **A watch's replay of another caller's result carries `cache`.** The
  contract stamps the marker only on a result "served from the call cache";
  a watcher fed by someone else's execution receives the stored copy, so it
  is marked, while the watch's own execution is delivered unmarked.
- **`blocked_by_policy` and `approval_required` are never produced** — there
  is no org policy here. `rate_limited` is real: the server's per-viewer cap.
- **The upstream `fetch` ignores proxy variables.** The SDK uses Node's
  global `fetch`; behind a proxy, hand `createClientPool` a `fetch` built on
  an `undici` proxy agent. The fake directory needs no network.
- **The `listTools` wire shape is inferred** (`docs/surface-area.md` §12
  flags it): the broker answers `[{server, authStatus, tools}]`, and the
  frame reads either that or `{servers: [...]}`. Conformance mode against
  the platform's own `mcp` module is the check.

## How to test

```
npm run build
npx vitest run test/mcp            # protocol, frame, broker, client, server
npx vitest run test/permissions    # the scoped mcp:<server> names
npx playwright test e2e/mcp.spec.ts e2e/kitchen-sink.spec.ts
```

`test/mcp/frame.test.ts` drives the namespace through an `RpcHost` double;
`test/mcp/broker.test.ts` drives the broker through a fake backend, a fake
clock and a fake document (the refetch loop and the hidden-page pause);
`test/mcp/client.test.ts` runs the pool against the SDK's own `McpServer`
on a local port; `test/mcp/server.test.ts` runs the routes over real sockets
with the fake directory.

`e2e/mcp.spec.ts` loads `fixtures/mcp.html` in the real shell: `listTools`,
the consent dialog and its copy, cache hits and misses by the fake's call
counter, `invalidate`, every refusal, cancellation, a watch's replay and
re-delivery, and `permissions.state("mcp:<server>")` before and after.
