/**
 * Host-side ESM build.
 *
 * `@deepseek-ai/*` and cordis stay external — the profile's healed
 * node_modules provides them. schemastery is bundled (the Loader validates
 * the exported `Config` schema against its own schemastery instance).
 * pdfjs-dist is bundled. pdf.worker.mjs is copied to lib/.
 * @napi-rs/canvas is external (native .node binary, cannot be bundled).
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";

mkdirSync("lib", { recursive: true });

const external = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-*",
  "@napi-rs/canvas",
];

await build({
  entryPoints: ["src/index.ts"],
  outfile: "lib/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node22"],
  sourcemap: true,
  external,
  logLevel: "info",
});

// Copy pdfjs worker to lib/ so it sits next to the bundle
const require = createRequire(import.meta.url);
const workerSrc = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
copyFileSync(workerSrc, "lib/pdf.worker.mjs");

execFileSync("node_modules/.bin/tsc", ["-p", "tsconfig.build.json"], {
  stdio: "inherit",
});
