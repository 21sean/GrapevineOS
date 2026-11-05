/**
 * Attack success rate over saved red team runs.
 *
 *   npm run redteam:report -w server -- <run dir> [<run dir> ...] [--json] [--injection]
 *
 * Each directory holds the results.json that REDTEAM_ARTIFACT_DIR saved. ASR is
 * successful attacks over the conversations that reached a verdict, per
 * objective and overall, with a 95% Wilson interval. An UNDETERMINED verdict and
 * an attack that never finished are counted on their own: neither is evidence
 * of a break, and neither is evidence that the agent held.
 *
 * --injection reads injection.json instead: ASR and utility for the indirect
 * prompt injection suite, reported apart because it measures a different thing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatRate, wilson, type RateEstimate } from "../src/evals/stats.js";
import type { InjectionRow } from "../src/evals/injection.js";
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

export interface InjectionTally {
  /** The target tool was called with the attacker's arguments. */
  called: RateEstimate;
  /** The write reached the effect layer with no person confirming it. */
  effected: RateEstimate;
  utilityUnderAttack: RateEstimate;
  baselineUtility: RateEstimate;
  gateFailures: number;
  unfinished: number;
  by: Record<string, { called: RateEstimate; effected: RateEstimate; utility: RateEstimate }>;
}

export function tallyInjection(rows: InjectionRow[]): InjectionTally {
  const rate = (from: InjectionRow[], pick: (r: InjectionRow) => boolean) =>
    wilson(from.filter(pick).length, from.length);
  const finished = rows.filter((r) => !r.error);
  const attacks = finished.filter((r) => r.goal);
  const clean = finished.filter((r) => !r.goal);
  const slice = (from: InjectionRow[]) => ({
    called: rate(from, (r) => r.called),
    effected: rate(from, (r) => r.effected),
    utility: rate(from, (r) => r.utility),
  });
  const by: InjectionTally["by"] = {};
  for (const [label, key] of [
    ["goal", (r: InjectionRow) => r.goal],
    ["vector", (r: InjectionRow) => r.vector],
    ["template", (r: InjectionRow) => r.template],
  ] as const) {
    for (const value of new Set(attacks.map(key))) {
      by[`${label} ${value}`] = slice(attacks.filter((r) => key(r) === value));
    }
  }
  return {
    called: rate(attacks, (r) => r.called),
    effected: rate(attacks, (r) => r.effected),
    utilityUnderAttack: rate(attacks, (r) => r.utility),
    baselineUtility: rate(clean, (r) => r.utility),
    gateFailures: finished.filter((r) => r.gateFailed).length,
    unfinished: rows.length - finished.length,
    by,
  };
}

function reportInjection(dirs: string[], json: boolean): number {
  const rows = dirs.flatMap((dir) => {
    const file = join(dir, "injection.json");
    if (!existsSync(file)) throw new Error(`no injection.json in ${dir}`);
    return (JSON.parse(readFileSync(file, "utf8")) as { rows: InjectionRow[] }).rows;
  });
  const t = tallyInjection(rows);
  if (json) {
    console.log(JSON.stringify(t, null, 2));
    return 0;
  }
  console.log(`ASR, target tool called:   ${formatRate(t.called)}`);
  console.log(`ASR, write took effect:    ${formatRate(t.effected)}`);
  console.log(`utility under attack:      ${formatRate(t.utilityUnderAttack)}`);
  console.log(`utility with no injection: ${formatRate(t.baselineUtility)}`);
  console.log(`gate failures ${t.gateFailures}, did not finish ${t.unfinished}`);
  for (const [name, v] of Object.entries(t.by)) {
    console.log(
      `${name.padEnd(28)} called ${formatRate(v.called)}; effected ${v.effected.successes}; utility ${v.utility.successes} of ${v.utility.total}`,
    );
  }
  return 0;
}

function main(argv: string[]): number {
  const json = argv.includes("--json");
  const dirs = argv.filter((a) => !a.startsWith("--"));
  if (!dirs.length) {
    console.error("usage: redteam-report <run dir> [<run dir> ...] [--json] [--injection]");
    return 2;
  }
  if (argv.includes("--injection")) return reportInjection(dirs, json);
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
