# `permissions`

`state(name?)` and `request(names?)` — what this view may do, and the one
surface that asks the viewer for the rest. Contract: `surface-area.md` §5.2
and §4 (id prefix `p`, 130 s reply budget, 900 s after `__frame_cap_ack`),
plus the scoped-name notes in `reference/contract/0.2.32/mcp.d.ts`.

## What is implemented

**Page-facing API** (`frame.ts`)

| Call | Resolves |
|---|---|
| `state()` | `Record<name, "granted" \| "denied" \| "prompt" \| "unavailable">` |
| `state(name)` | that name's state |
| `request(names)` | `Record<name, state>` for exactly the names asked, in order |
| `request()` | the same, for every capability this view could decide |

Both methods go through `ctx.pipe().wrap`, so they reject and never throw.
Validation is the documented pair of limits: a name is a non-empty string of
at most **512** characters, `request` takes at most **32** names (duplicates
are folded, order kept). A limit failure rejects `bad_request` without a
round trip. Anything the shell sends that is not one of the four states reads
as `"unavailable"`, so a page can never see a fifth word.

**Wire** (`__frame_cap`, cap `permissions`, ids `p1`, `p2`, …)

```jsonc
{"__frame_cap":true,"cap":"permissions","id":"p1","method":"state","args":[]}
{"__frame_cap":true,"cap":"permissions","id":"p2","method":"state","args":["sample"]}
{"__frame_cap":true,"cap":"permissions","id":"p3","method":"request","args":[["sample"]]}
{"__frame_cap":true,"cap":"permissions","id":"p4","method":"request","args":[]}
```

A call that never comes back is `upstream_error` "no reply from shell" at
130 s; a `__frame_cap_ack` (sent before every dialog) moves that to 900 s.

**Shell rules** (`broker.ts`) — the frame decides nothing:

- not declared for this view → `"unavailable"`. That covers a capability this
  build does not serve at all (`mcp`, `comments`), every scoped name
  (`mcp:<server>`, `mcp:host:<name>`, whose base is `mcp`), and anything
  misspelled — a permissions read never reveals the roster;
- declared **and** consent-gated (`sample`, the only "decide" capability v0
  serves) → the viewer's stored answer under `consent:<artifactId>:<cap>`:
  `"granted"`, `"denied"`, otherwise `"prompt"`;
- everything else declared → `"granted"`. `artifact` and `self` answer for
  each other; the map lists the capability once, canonically.

`state()` never prompts. `request()` sends `ctx.ack(call.id)` before the first
dialog, shows `ctx.consent` (which makes the iframe `inert`, so the page
cannot clickjack the answer), stores the verdict under the same key, and
resolves the resulting states. Two calls racing for one capability share one
dialog. Names that are already `"granted"`, already `"denied"`, or
`"unavailable"` are answered without a dialog at all.

**Mount shape** (`frame.ts`) — the namespace mounts either way, because
`use()` is not the permission gate:

- at least one capability other than `permissions`/`user` declared → the
  brokered shape above;
- otherwise → the local "unavailable" shape: `state()` → `{}`, `state(name)`
  → `"unavailable"`, `request(names)` → every name `"unavailable"`,
  `request()` → `{}`. No channel to the shell is opened at all.

**Server** (`server.ts`) registers nothing, on purpose: every answer is a
shell-side decision over the boot record plus the shell origin's
`localStorage`. A frame-origin route would be a way to read another
artifact's consent state, and there is no per-account storage to serve.

## Deviations from the platform, and why

1. **`permissions` must be declared.** On claude.ai the capability is implicit
   — the shell adds `permissions: {}` whenever the runtime is enabled. Here
   the preamble imports a module only for names present in
   `__frame_init.capabilities`, and `src/server/boot.ts` only forwards
   declared names, so a page that does not declare `permissions` resolves
   `use("permissions")` to `null`. Declaring `{"permissions": {}}` next to
   the rest gets the documented behaviour. The integration pass considered
   synthesising `permissions` whenever any other capability is declared and
   refused: it would contradict this slice's own e2e ("a page that never
   declared permissions resolves it null"), which is the spine's stated
   "design for absence" rule.
2. **Consent lives in the browser, not the account.** `consent:<artifactId>:<cap>`
   in the shell origin's `localStorage` is what `docs/design.md` specifies for
   `sample`, and this slice deliberately reads and writes the *same* key, so a
   decision made through `permissions.request()` is the decision the `sample`
   broker honours and vice versa. Consequences: it is per browser profile, it
   is cleared with site data, and where storage is unavailable (private mode)
   a decision cannot be persisted — the broker remembers it in memory for the
   life of the view instead, so the viewer is asked once rather than on every
   call, and `state("sample")` is `"prompt"` again after a reload. The
   platform stores this server-side per account.
3. **A refusal is sticky.** Once `"denied"` is stored, `request()` returns
   `"denied"` without prompting again, exactly as
   `Notification.requestPermission()` behaves — a page cannot nag by looping.
   The platform's re-ask policy is not documented; this is the conservative
   reading. A viewer takes it back by clearing site data for the shell origin.
4. **The map lists what this build serves.** `permissions` itself is left out
   of `state()` (it is always present and can never be decided, and listing it
   would only invite `request(["permissions"])`), and a declaration this
   roster does not know — `comments`, say — is reported `"unavailable"`
   rather than `"granted"`, because no module mounts for it and `use()` on it
   resolves `null`.
5. **`sample` and `mcp` read `"prompt"`.** `mcp` is decided per declared
   server under the scoped names `mcp:<server>`, through the same
   `consent.ts` the `mcp` slice's own dialog uses (one dialog per key, one
   at a time, one stored answer, with or without `localStorage`); a server
   the manifest does not declare, or a `host:` one this surface cannot
   reach, is `"unavailable"`. The bare `mcp` is the aggregate over the
   askable servers: `"prompt"` while any is undecided, else `"denied"` if
   any was refused, else `"granted"`, and `request(["mcp"])` asks for every
   server in turn. `stateMap` lists both. A name the prompt cap kept from
   being asked stays `"prompt"`: nothing was decided.
6. **Validation code.** A bad name or an over-long list rejects
   `bad_request` with a plain message, the code the platform's own
   permissions module uses ("state takes no arguments or one capability
   name"); the conformance run against that module pinned it down. Pages
   are told to tolerate any rejection from a permissions read
   (`.catch(() => "unavailable")`), so the shape matters more than the
   spelling.

## Known gaps

- A `sample` call and a `permissions.request(["sample"])` that race can still
  put up two dialogs: each slice keeps its own in-flight map, and only the
  storage key is shared. The verdict is no longer corrupted by that — this
  broker re-reads the key before opening a dialog and again after it closes,
  and an answer already recorded wins over a later one — but the viewer is
  asked twice. A shared consent registry on the shell
  (`ctx.consentOnce(key, request)`) would fix the double dialog for every
  slice at once, and is where the key should also gain the viewer id
  (`consent:<artifactId>:<viewerId>:<cap>`), so a shared browser profile does
  not let one account inherit another's decision.
- No revoke: nothing lets a viewer change an answer from inside the shell UI
  yet, other than clearing site data.
- Storage the browser refuses (private mode, blocked site data) costs the
  decision at reload: the answer is remembered only in memory for the life of
  the view. A dialog cap of five per artifact per minute keeps a page from
  turning any re-prompting path into a stream of modals over the shell.
- `request()` prompts one capability at a time. With today's single consent
  capability that is at most one dialog; a multi-capability ask would want one
  dialog listing them.

## How to test

```
npm run build
npx vitest run test/permissions       # protocol limits, frame wire + budgets, broker rules
npx playwright test e2e/permissions.spec.ts
```

`test/permissions/frame.test.ts` drives the namespace over a fake `RpcHost`
(no browser): envelopes, the local shape, and the 130 s → 900 s ack budget.
`test/permissions/broker.test.ts` drives the broker over a fake
`BrokerContext` and a fake `localStorage`, including through the real shell
dispatcher. `e2e/permissions.spec.ts` loads `fixtures/permissions.html`
through the real server and shell: state before the ask, the dialog over an
inert iframe, state after it and after a reload, the remembered refusal, and
the two views that have nothing to answer for.
