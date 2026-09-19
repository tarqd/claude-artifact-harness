# Connector auth: mirroring the platform

How a page reaches a connector that authenticates its viewer, rather than one
the operator configured a bearer token for. The goal is the platform's own
shape — the `authorize` lane, the re-auth popup, per-viewer credentials — not
a harness-specific invention, so that `npm run e2e:conformance` keeps passing
against the platform's own `mcp` module.

Reference points: `docs/surface-area.md` §5.8 (the `mcp` wire level),
`docs/analysis/shell.md` §"mcp" (the platform's start-auth popup and the
`authorize` lane's 30 s budget), `reference/contract/0.2.32/mcp.d.ts` (the
error vocabulary, and what the shell is expected to pre-empt), and
`src/capabilities/mcp/README.md` §"Deviations from the platform" — this
document is the plan to delete four entries from that list.

## Where we are

The `mcp` slice is complete and merged (`26aae13`). Its directory is
**server-wide**: the operator declares `MCP_SERVERS` with static headers and
every viewer shares them. `ConnectorDirectory.resolve(viewerId, displayName)`
already has the right signature; nothing below it reads `viewerId`.

That model works today for a connector that takes a static credential.
Atlassian's Rovo MCP server (`https://mcp.atlassian.com/v2/mcp`) is one: it
accepts `Authorization: Basic base64(email:api_token)` or a service-account
`Bearer` key, if an org admin has enabled API-token auth. So "Jira in an
artifact" is reachable now, with three known costs: some Rovo tools are
unavailable on that path, the page must pass `cloudId` explicitly, and
**every viewer of the artifact acts as the credential's owner**.

That last cost is the reason for this work. It is also why issue #12 /
PR #43 is a prerequisite and not a nicety.

## What "mirroring the platform" means

Four deviations in the slice README become the scope:

1. *"Connectors are server-wide, not per viewer … the `authorize` lane, the
   re-auth popup and `selection_required` never occur."*
2. *"No user-activation check on consent"* — an OAuth popup needs a real
   gesture or the browser blocks it, so this stops being cosmetic.
3. *"`blocked_by_policy` and `approval_required` are never produced"* — out of
   scope; there is still no org policy here.
4. *"`host:` servers are always `server_not_connected`"* — unchanged. A
   service never runs a device server.

The page-facing contract does **not** change. `needs_reauth`,
`selection_required` and `ServerAuthStatus` are already in `mcp.d.ts` and
already implemented in `frame.ts`. Every change below is shell-side,
server-side, or configuration. A page written against the current slice keeps
working; it simply starts seeing `needs_reauth` resolve itself.

## Decision: whose tokens?

An OAuth refresh token attached to a viewer makes the `av` cookie a bearer for
that viewer's Jira account. Today `av` is minted for anyone who loads
`/a/<id>`, is not `Secure`, carries no `__Host-` prefix (issue #13), and sits
behind no login. Per-viewer OAuth is only meaningful once a viewer is a
*person*, and the `user` slice deliberately has self-service names and
`email()` → `null`.

**v1 is owner-scoped.** Tokens are stored only for a viewer whose level is
`owner`; `listTools` omits OAuth servers for everyone else and `callTool`
answers `server_not_connected`. This delivers the real interactive flow,
per-person tokens, refresh and revocation without inventing an account
service. The storage layer, the directory seam and the authorize lane are all
built keyed by `viewerId`, so v2 — real viewer login, per-viewer connectors —
is a gate change and a login story, not a rewrite.

## Prerequisites

These are already written and sitting unreviewed. The authorize lane should
not land before them:

- **PR #44 / issue #13** — `PUBLIC_SHELL_URL` and the TLS story. DCR persists
  a `client_id` bound to `redirect_uri = <shellOrigin>/connector/<server>/auth_done`;
  `shellOrigin()` builds `http://` unconditionally today, and Atlassian can
  enforce domain and redirect allowlists. Hard blocker for anything but
  loopback.
- **PR #43 / issue #12** — an existing viewer session on the mcp lanes. Also
  the mitigation for the static-credential path in the meantime.
- **PR #41 / issue #10** — the `__frame_nav` activation gate. Same bug class
  as the popup: a page must never be able to conjure an authorization window.

## Plan

### Phase 1 — per-viewer credentials underneath

**1a. Encrypted token store.** `McpTokenStore` keyed `(viewerId, serverName)`,
holding tokens, the PKCE verifier mid-flight, the DCR client registration
(per server, not per viewer) and RFC 9728 discovery state. AES-256-GCM under a
key derived from `config.secret` — unlike `db`, this does not go to disk as
plain JSON. Precedent for the shape: `src/capabilities/user/store.ts`.

**1b. `OAuthClientProvider`.** SDK 1.30 has the whole interface
(`node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.d.ts`): DCR,
PKCE, protected-resource discovery, refresh, `saveDiscoveryState`. Implement
it against 1a. `redirectToAuthorization` cannot redirect anything from Node —
it records the URL for the authorize lane to hand to the shell.

**1c. Re-key the client pool.** `client.ts` holds `entries: Entry[]`, one
`Client` and one `tools/list` TTL cache per configured server, shared by every
viewer. Under OAuth both are per `(viewer, server)` — scopes differ per
person. Needs an LRU with idle eviction (memory) and a per-key refresh lock:
OAuth 2.1 rotates refresh tokens, so two calls that both hit 401 will both try
to spend the same one and one of them will lose the session.

**1d. Config grammar.** `{name, url, auth: "oauth", scope?}` alongside today's
`headers`. `parseServersConfig` refuses a server that declares both.

### Phase 2 — the authorize lane

**2a. Wire.** A new `authorize` method on the `mcp` lane, 30 s budget via
`capBudgets.mcp.authorize`, matching `docs/analysis/shell.md` §"mcp". The
frame half is small; the broker half opens the flow and resolves when the
popup reports back.

**2b. Shell-origin routes.** `GET /connector/:server/start-auth` (gated,
302 to the authorization URL, verifier stashed against a signed `state`) and
`GET /connector/:server/auth_done` (code → token exchange → store →
`postMessage` to the opener → close). Neither exists on the frame origin; no
token ever reaches page code.

**2c. The gesture.** The popup opens from a click in the shell's own UI — a
"Connect {server}" affordance rendered through `createConsent` — never from a
page-initiated call. `ConsentDialogHost` currently resolves a boolean; this
needs a variant that returns "the viewer asked to connect".

### Phase 3 — pre-emption at load

`mcp.d.ts` is explicit that the shell "usually pre-empts this at load with its
own reconnect prompt, so don't build an always-on reconnect banner". So at
artifact load the shell resolves the manifest's declared servers against the
viewer's connectors and prompts once for any that are missing or lapsed,
before the page's first call. Dismissal is remembered per loaded version; a
live version update re-arms one prompt.

### Phase 4 — `selection_required`

Per the contract: more than one callable connector with the same display name,
viewer has not chosen. The motivating real case is Atlassian multi-site — one
"Jira" connector, several cloudIds. Prompt at most once per loaded version,
re-armed by a version update; a dismissal leaves the error standing, and the
page falls back exactly as it does for `server_not_connected`.

### Phase 5 — fidelity and coverage

`listTools` must fold the upstream vocabulary the platform folds
(`authenticated`, `not_required` → `connected`; `auth_required`,
`token_invalid`, `refresh_failed`, `managed_auth_failed` → `needs_reauth`;
anything else → `unknown`) from real upstream state rather than the fake's.
The fake directory grows an OAuth connector so the lane is testable with no
network. `npm run e2e:conformance` must stay green throughout: nothing here
may change what the platform's own module speaks.

## Out of scope

Org policy (`blocked_by_policy`, `approval_required`), a host bridge for
`host:` servers, and real viewer login. The last is what turns v1 into v2 and
deserves its own design.
