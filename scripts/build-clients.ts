/**
 * Build the three client artefacts with esbuild:
 *
 *   dist/frame/preamble.js   IIFE, inlined into every served page
 *   dist/runtime/<name>.js   one ESM module per capability, imported by the
 *                            preamble from `/_runtime/<name>.js`
 *   dist/shell/shell.js      IIFE, loaded by the shell page
 *
 * The server reads these at request time, so anything that starts a server —
 * `npm run dev`, the vitest suite, the Playwright suite — needs them on disk
 * first. `scripts/build.ts` is the command-line entry; the test suites call
 * `buildClients` from their own setup so a bare `vitest`/`playwright test`
 * never serves a 500 for a missing bundle.
 */
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { CAPABILITIES } from "../src/protocol/capabilities.ts";

export interface BuildClientsOptions {
  /** Where the bundles land. Defaults to `DIST_DIR`, then `dist`. */
  dist?: string;
  /** Remove the output directory first, so a stale bundle cannot survive. */
  clean?: boolean;
  /** Minify and drop source maps. Defaults to `NODE_ENV=production`. */
  production?: boolean;
  /** esbuild's log level. `silent` keeps a test run's output to the tests. */
  logLevel?: "info" | "silent";
}

export async function buildClients(options: BuildClientsOptions = {}): Promise<string> {
  const dist = options.dist ?? process.env.DIST_DIR ?? "dist";
  const production = options.production ?? process.env.NODE_ENV === "production";
  const logLevel = options.logLevel ?? "info";

  if (options.clean) await rm(dist, { recursive: true, force: true });

  const common = {
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser" as const,
    sourcemap: !production,
    minify: production,
    logLevel,
  };

  // The preamble is inlined into every served page, so it carries no source
  // map comment (there would be nothing to fetch it from).
  await build({
    ...common,
    entryPoints: ["src/frame/preamble.ts"],
    outfile: `${dist}/frame/preamble.js`,
    format: "iife",
    sourcemap: false,
  });

  await build({
    ...common,
    entryPoints: CAPABILITIES.map((name) => `src/capabilities/${name}/frame.ts`),
    outdir: `${dist}/runtime`,
    outbase: "src/capabilities",
    entryNames: "[dir]",
    format: "esm",
    splitting: false,
  });

  await build({
    ...common,
    entryPoints: ["src/shell/index.ts"],
    outfile: `${dist}/shell/shell.js`,
    format: "iife",
  });

  return dist;
}
