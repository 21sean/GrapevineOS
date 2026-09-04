/**
 * The eval gate, on a terminal.
 *
 *   npm run evals                      every suite
 *   npm run evals -- --suite dedupe    one suite (repeatable)
 *   npm run evals -- --list            what exists, without running it
 *   npm run evals -- --json            machine-readable, for CI to keep
 *
 * Exits non-zero when a case fails, so this is usable as a pre-push hook or a
 * CI step. A skipped suite does NOT fail the run — an unavailable model is an
 * environment fact, not a regression — but it is reported loudly and shows in
 * the summary line, so a run that quietly stopped checking something cannot
 * pass for a green one.
 *
 * Same registry as Admin -> Evals. There is one definition of what "passing"
 * means, and both the panel and this script read it.
 */
import "dotenv/config";
import { SUITES } from "../src/evals/registry.js";
import { runEvals } from "../src/evals/runner.js";
import { record } from "../src/evals/history.js";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const values = (name: string) =>
  argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []));

const c = process.stdout.isTTY
  ? {
      dim: "\x1b[2m",
      red: "\x1b[31m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      bold: "\x1b[1m",
      off: "\x1b[0m",
    }
  : { dim: "", red: "", green: "", yellow: "", bold: "", off: "" };

if (flag("list")) {
  for (const s of SUITES) {
    const cases = await Promise.resolve(s.cases()).catch(() => []);
    console.log(
      `${s.id.padEnd(12)} ${String(cases.length).padStart(3)} cases  ${c.dim}${s.what}${c.off}`,
    );
  }
  process.exit(0);
}

const only = values("suite");
const unknown = only.filter((id) => !SUITES.some((s) => s.id === id));
if (unknown.length) {
  console.error(`unknown suite(s): ${unknown.join(", ")}`);
  console.error(`known: ${SUITES.map((s) => s.id).join(", ")}`);
  process.exit(2);
}

const json = flag("json");
const run = await runEvals({
  only,
  onFrame: (frame) => {
    if (json) return;
    if (frame.type === "suite-start") {
      console.log(`\n${c.bold}${frame.title}${c.off} ${c.dim}(${frame.total} cases)${c.off}`);
    }
    if (frame.type === "case") {
      const r = frame.result;
      const mark =
        r.status === "pass"
          ? `${c.green}pass${c.off}`
          : r.status === "skipped"
            ? `${c.yellow}skip${c.off}`
            : `${c.red}FAIL${c.off}`;
      console.log(`  ${mark}  ${r.name}`);
      if (r.status !== "pass" || process.env.EVALS_VERBOSE) {
        console.log(`        ${c.dim}${r.detail}${c.off}`);
      }
    }
    if (frame.type === "suite-done" && frame.result.skipReason) {
      console.log(`  ${c.yellow}skipped${c.off} ${c.dim}${frame.result.skipReason}${c.off}`);
    }
  },
});

const stamped = record(run);

if (json) {
  console.log(JSON.stringify(stamped, null, 2));
} else {
  const bits = [
    `${stamped.passed} passed`,
    stamped.failed ? `${c.red}${stamped.failed} failed${c.off}` : "",
    stamped.skipped ? `${c.yellow}${stamped.skipped} skipped${c.off}` : "",
  ].filter(Boolean);
  console.log(
    `\n${bits.join(", ")} in ${(stamped.ms / 1000).toFixed(1)}s  ${c.dim}case set ${stamped.caseSetHash}${c.off}`,
  );
  for (const s of stamped.suites) {
    if (s.status === "skipped" && s.skipReason)
      console.log(`${c.yellow}skipped${c.off} ${s.title}: ${s.skipReason}`);
  }
  if (stamped.regressions?.length) {
    console.log(`\n${c.red}regressed since the last comparable run:${c.off}`);
    for (const id of stamped.regressions) console.log(`  ${id}`);
  }
  if (stamped.fixes?.length) {
    console.log(`\n${c.green}fixed since the last comparable run:${c.off}`);
    for (const id of stamped.fixes) console.log(`  ${id}`);
  }
}

process.exit(stamped.failed > 0 ? 1 : 0);
