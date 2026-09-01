/**
 * Build the three client artefacts with esbuild:
 *
 *   dist/frame/preamble.js   IIFE, inlined into every served page
 *   dist/runtime/<name>.js   one ESM module per capability, imported by the
 *                            preamble from `/_runtime/<name>.js`
 *   dist/shell/shell.js      IIFE, loaded by the shell page
 */
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { CAPABILITIES } from "../src/protocol/capabilities.ts";

const dist = "dist";
const production = process.env.NODE_ENV === "production";

await rm(dist, { recursive: true, force: true });

const common = {
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser" as const,
  sourcemap: !production,
  minify: production,
  logLevel: "info" as const,
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

console.log("built dist/frame, dist/runtime, dist/shell");
