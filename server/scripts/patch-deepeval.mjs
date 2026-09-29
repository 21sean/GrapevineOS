/**
 * deepeval@0.9.13–0.9.20 ships a stale build artifact: dist/telemetry.js (two dead
 * exports from an old layout) sitting next to the real dist/telemetry/
 * directory. Node resolves `require("../telemetry")` to the FILE, so every
 * metric's `measure()` crashes at startProgress with
 * "inComponentScope is not a function", which takes down GEval and with it
 * every judged suite and conversation eval.
 *
 * Nothing imports the stale file's own exports (checked: only its own export
 * lines reference them), so the smallest correct fix is to turn the file into
 * a re-export of the directory index. Runs on postinstall so an `npm install`
 * cannot quietly bring the bug back; remove once a fixed deepeval ships.
 *
 * With npm workspaces the package is hoisted to the repo root, so both
 * locations are checked.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const candidates = [
  new URL("../node_modules/deepeval/dist/telemetry.js", import.meta.url),
  new URL("../../node_modules/deepeval/dist/telemetry.js", import.meta.url),
];
const file = candidates.find((u) => existsSync(u));
const shim = `// patched by scripts/patch-deepeval.mjs; see that file for why\nmodule.exports = require("./telemetry/index.js");\n`;

if (!file) {
  console.log("patch-deepeval: dist/telemetry.js is gone — upstream fixed it, delete this script");
} else if (readFileSync(file, "utf8").includes("telemetry/index.js")) {
  console.log("patch-deepeval: already patched");
} else {
  writeFileSync(file, shim);
  console.log("patch-deepeval: dist/telemetry.js now re-exports dist/telemetry/index.js");
}
