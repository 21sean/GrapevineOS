/**
 * Attack success rate over saved red team runs.
 *
 *   npm run redteam:report -w server -- <run dir> [<run dir> ...] [--json]
 *
 * Each directory holds the results.json that REDTEAM_ARTIFACT_DIR saved. ASR is
 * successful attacks over the conversations that reached a verdict, per
 * objective and overall, with a 95% Wilson interval. An UNDETERMINED verdict and
 * an attack that never finished are counted on their own: neither is evidence
 * of a break, and neither is evidence that the agent held.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatRate, wilson, type RateEstimate } from "../src/evals/stats.js";
import type { AttackResult } from "../src/evals/redteam.js";

export interface ObjectiveRow {
  id: string;
  asr: RateEstimate;
  undetermined: number;
  unfinished: number;
}

export function tally(results: AttackResult[]): ObjectiveRow[] {
  const ids = [...new Set(results.map((r) => r.id))];
  const row = (id: string, rows: AttackResult[]): ObjectiveRow => {
    const success = rows.filter((r) => r.outcome === "success").length;
    const failure = rows.filter((r) => r.outcome === "failure").length;
    return {
      id,
      asr: wilson(success, success + failure),
      undetermined: rows.filter((r) => r.outcome === "undetermined").length,
      unfinished: rows.filter((r) => r.outcome === "error").length,
    };
  };
  return [
    ...ids.map((id) =>
      row(
        id,
        results.filter((r) => r.id === id),
      ),
    ),
    row("overall", results),
  ];
}

export function loadRun(dir: string): AttackResult[] {
  const file = join(dir, "results.json");
  if (!existsSync(file)) throw new Error(`no results.json in ${dir}`);
  return (JSON.parse(readFileSync(file, "utf8")) as { results: AttackResult[] }).results;
}

function main(argv: string[]): number {
  const json = argv.includes("--json");
  const dirs = argv.filter((a) => a !== "--json");
  if (!dirs.length) {
    console.error("usage: redteam-report <run dir> [<run dir> ...] [--json]");
    return 2;
  }
  const rows = tally(dirs.flatMap(loadRun));
  if (json) {
    console.log(JSON.stringify({ runs: dirs.length, rows }, null, 2));
    return 0;
  }
  console.log(`${dirs.length} run(s)`);
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(18)} ${formatRate(r.asr)}; undetermined ${r.undetermined}, did not finish ${r.unfinished}`,
    );
  }
  return 0;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/redteam-report.ts")) {
  process.exit(main(process.argv.slice(2)));
}
