/**
 * `downloads` has no backend, by design.
 *
 * The file the page offers never leaves the browser: the frame hands the
 * bytes to the shell over `postMessage`, the shell asks the viewer, and the
 * shell's own document turns the accepted bytes into a browser download
 * through an object URL. claude.ai's broker has no endpoint for this either
 * (surface-area.md §12, the `downloads` row: "none — shell-side dialog, then
 * a browser download").
 *
 * Uploading the bytes to a server just to hand them back would add a copy of
 * the viewer's data at rest, a token to guard it and a route that would serve
 * one artifact's bytes on the frame origin — all of it for nothing. So this
 * file registers no routes and claims no websocket lane, and the slice is
 * two files plus this note.
 */
import type { ServerApps, ServerContext } from "../../server/types.ts";

export function routes(_apps: ServerApps, _ctx: ServerContext): void {
  // Intentionally empty: see the note above.
}
