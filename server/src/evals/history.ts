/**
 * Run history, on disk, bounded.
 *
 * A single run answers "is it green". History answers the question that
 * actually matters: "which case went red, and when". That is the difference
 * between a dashboard and a test run, so it is worth the file.
 *
 * Deliberately not a database table. This is operator telemetry for a local
 * pipeline, it never needs to be queried by another process, and putting it in
 * Postgres would mean a migration and a network round trip before the panel
 * could show a number. A capped JSONL file next to the server is the right
 * size for the job, and it is trivially deletable.
 *
 * Every failure mode here is non-fatal by design: a run that produced results
 * must not be lost because the disk was read-only or a previous line was
 * truncated mid-write.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalRun } from "../types.js";
import { logger } from "../log.js";

const log = logger("history");

/** server/.evals/history.jsonl, resolved from this module, not from cwd. */
const FILE = fileURLToPath(new URL("../../.evals/history.jsonl", import.meta.url));

/** Enough to see a trend without the file ever becoming something to manage. */
const KEEP = 25;

let warned = false;

function warnOnce(what: string, err: unknown): void {
  if (warned) return;
  warned = true;
  log.warn({ err: String(err).slice(0, 200) }, `${what}: history disabled for this boot`);
}

/** Newest first. Never throws: no history is a normal state, not an error. */
export function history(): EvalRun[] {
  let raw: string;
  try {
    raw = readFileSync(FILE, "utf8");
  } catch {
    return []; // no file yet on a fresh checkout
  }
  const runs: EvalRun[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      runs.push(JSON.parse(line) as EvalRun);
    } catch {
      // A line truncated by a kill mid-write. Skip it and keep the rest.
    }
  }
  return runs.reverse();
}

export function lastRun(): EvalRun | null {
  return history()[0] ?? null;
}

/** Case ids that failed, as "suite/case" so two suites cannot collide. */
function failedIds(run: EvalRun): Set<string> {
  const out = new Set<string>();
  for (const suite of run.suites) {
    for (const c of suite.cases) {
      if (c.status === "fail") out.add(`${suite.id}/${c.id}`);
    }
  }
  return out;
}

function passedIds(run: EvalRun): Set<string> {
  const out = new Set<string>();
  for (const suite of run.suites) {
    for (const c of suite.cases) {
      if (c.status === "pass") out.add(`${suite.id}/${c.id}`);
    }
  }
  return out;
}

/**
 * Records the run and stamps it with what changed since the last run that
 * asked the SAME questions. Comparing against a run with a different
 * caseSetHash would report every added case as a regression, which is how a
 * regression list becomes noise nobody reads.
 */
export function record(run: EvalRun): EvalRun {
  const past = history();
  const baseline = past.find((r) => r.caseSetHash === run.caseSetHash);
  const stamped: EvalRun = { ...run };
  if (baseline) {
    const wasFailing = failedIds(baseline);
    const wasPassing = passedIds(baseline);
    const nowFailing = failedIds(run);
    const nowPassing = passedIds(run);
    const regressions = [...nowFailing].filter((id) => wasPassing.has(id)).sort();
    const fixes = [...nowPassing].filter((id) => wasFailing.has(id)).sort();
    if (regressions.length) stamped.regressions = regressions;
    if (fixes.length) stamped.fixes = fixes;
  }

  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const kept = [...past].reverse().slice(-(KEEP - 1)); // oldest first, room for one
    writeFileSync(FILE, [...kept, stamped].map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  } catch (err) {
    warnOnce("could not write run history", err);
  }
  return stamped;
}
