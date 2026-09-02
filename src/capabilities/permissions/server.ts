/**
 * `permissions` has no backend.
 *
 * Every answer is a shell-side decision: what this view declared comes from
 * the boot record the server already built (`src/server/boot.ts`), and what
 * the viewer answered lives in the shell origin's `localStorage` under
 * `consent:<artifactId>:<cap>` — the same key the `sample` slice reads, so a
 * decision made through `permissions.request()` is the decision `sample`
 * honours. Nothing is stored per account on the server, so there is no route
 * to register and, deliberately, no frame-origin surface: a page could
 * otherwise read another artifact's consent state by asking for it.
 *
 * If consent ever needs to follow a viewer across browsers, this is where a
 * `GET/PUT /api/frame/permissions/<artifactId>` pair would live, written with
 * the shell cookie and read back into the broker.
 */
import type { ServerApps, ServerContext } from "../../server/types.ts";

export function routes(_apps: ServerApps, _ctx: ServerContext): void {
  // no routes: see the note above
}
