# `network`

The fetch allowlist, in two halves that never talk to each other:

| half | file | what it does |
|---|---|---|
| page-facing | `frame.ts` | `origins(): Promise<string[]>` — echoes `capabilities.network.config.origins` from `__frame_init` |
| enforcement | `server.ts` | `connectSrcOrigins(meta.capabilities, shellOrigin, frameHostSuffix)` — the declaration → the CSP `connect-src` sources |

There is no wire traffic and no backend: surface-area.md §11 lists "claude.ai
reference endpoints: none" for this capability, so `broker.ts` exists only to
refuse anything addressed to `network` with `capability_disabled`.

## What is implemented

**`origins()` (surface-area.md §5.6).** Resolves the declared list, verbatim.
Never rejects, never throws: every malformed shape answers `[]` —

- `network` not declared → the module is not even imported, `use("network")`
  resolves `null` (the spine's preamble does this; the fixture covers it);
- `config` missing, not an object, or `origins` not an array → `[]`;
- `optional: true` → `[]` (the spine's `buildInitCapabilities` already drops
  optional declarations before `__frame_init`, so this is belt and braces);
- non-string entries are dropped, the rest are kept.

The namespace is mounted through `ctx.pipe("network").wrap`, so it is frozen,
null-prototype, and promise-returning like every other capability, and each
call hands back a fresh array — a page that mutates the answer does not edit
the next caller's.

**`connectSrcOrigins` (surface-area.md §10.1).** Turns a declaration into the
`connect-src` sources to add after `'self'`: each entry must parse as an
absolute `https:` origin with no credentials, no path, query or fragment, and
a plain host (no wildcard, no IPv6 literal). Survivors are re-emitted from
`URL.origin` — never passed through — then de-duplicated and capped at
`MAX_ORIGINS` (32). This is what stops `"https://a.example; script-src *"`
from becoming a second CSP directive of the author's choosing. A survivor
whose host is the shell's own host, the bare `frameHostSuffix` itself, or a
sibling artifact's frame host (anything under `frameHostSuffix`), is dropped
too: same-site with the
viewer's cookie, it would let a declared `connect-src` reach `/api/frame/*`
(or another artifact's frame) from inside this frame.

## What deviates from the platform, and why

1. **`origins()` echoes the declaration; the CSP carries the validated
   subset.** §5.6 says `origins()` echoes `config.origins`, so a page that
   declared `http://a.example` is told `["http://a.example"]` and still has
   the fetch refused by the browser. Reporting the validated list instead
   would be friendlier but would stop matching claude.ai, where the answer is
   the config. The page-facing contract wins; the divergence is here in
   writing rather than in a surprise.
2. **…except non-string entries, which `origins()` drops.** The method is
   typed `Promise<string[]>`, and a JSON declaration can hold a number or an
   object; handing one back would break the type the page is promised. So the
   echo is verbatim for every string and silent for the rest — a page that
   declared `["https://a.example", 7]` is told `["https://a.example"]`.
3. **The allowlist follows the view, not the declaration.** An
   `optional: true` declaration opens nothing: the spine's
   `buildInitCapabilities` drops optional declarations before `__frame_init`
   and there is no later grant path, so the page never receives the namespace
   — widening `connect-src` for it would hand the document a reach the view
   was never granted — and since `serve.ts` calls this function, the served
   policy matches the view rather than the declaration.
4. **IPv6 literal origins (`https://[::1]`) are dropped.** They are valid CSP
   sources; the regexp is deliberately narrow. Widen `ORIGIN_RE` if a
   self-host needs one.

## Spine changes requested

None outstanding. The one this slice needed landed in the integration pass:
`src/server/serve.ts` now builds the frame origin's CSP with

```ts
c.header("content-security-policy", frameCsp(ctx.shellOrigin, connectSrcOrigins(meta?.capabilities, ctx.shellOrigin, ctx.config.frameHostSuffix)));
```

so the policy the browser enforces is the validated subset, not the raw
declaration. `serve.ts`'s own unvalidated `networkOrigins()` is gone, and so
is the stopgap this slice carried: a `routes()` that wrapped
`apps.frame.fetch` and re-stamped the header. The slice now mounts nothing at
all.

Why the stopgap could not have been a middleware is worth keeping on record:
`mountCapabilityRoutes` runs after `mountFrameRoutes`
(`src/server/index.ts`), so an `apps.frame.use("*")` registered from here
lands *after* `app.get("/_f/:ver/*")` in Hono's chain for that path; the
document handler returns without calling `next()`, so a slice middleware is
never dispatched for the one response whose CSP the browser enforces — it
only ever sees paths no spine route matched (404s). Measured, not assumed.

A route that returns a `Response` it built itself keeps its own policy, with
no exception needed anywhere: Hono drops the middleware's `c.header()` values
in that case (measured). `assets` relies on this to serve blobs under
`default-src 'none'; sandbox`.

## How to test

```
npm run build
npx vitest run test/network
npx playwright test e2e/network.spec.ts
```

- `test/network/frame.test.ts` — the namespace shape, the echo, `[]` for every
  malformed declaration, a fresh array per call, and that `origins()` settles
  with no shell present (proving there is no wire call).
- `test/network/server.test.ts` — the validator (including the injection and
  downgrade cases), plus the CSP two real Hono apps serve over ephemeral
  ports with a temp `DATA_DIR`: the validated subset, an injected
  `frame-ancestors *` refused, the cap holding at `MAX_ORIGINS`, an
  `optional` declaration opening nothing, another route's own policy left
  alone, and every other directive left byte-for-byte as the spine built it.
- `e2e/network.spec.ts` with `fixtures/network.html` — the real shell, server
  and iframe: the namespace shape from inside the frame, the declaration
  echoed, the CSP on the document, and the enforcement itself. The fixture
  fetches a declared and an undeclared origin (neither host resolves) and
  tells them apart by `securitypolicyviolation`, which is the only signal a
  page gets: both fetches reject with the same opaque `TypeError`, but only
  the refused one reports `connect-src`.
