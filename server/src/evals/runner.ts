/**
 * The runner: turns suites into a result, with the failure modes an eval
 * harness has to survive itself.
 *
 *  - A case that throws anything at all is a failed case, not a failed run.
 *    A harness that dies on the first unexpected exception reports nothing
 *    about the twenty cases after it.
 *  - Every case gets a wall-clock budget. This bounds awaiting, which is what
 *    a hung model or a socket that never answers actually does; JavaScript has
 *    no preemption, so a genuinely spinning loop still wins, and that is
 *    written down rather than pretended away.
 *  - Runs are serialized process-wide. Two concurrent runs would contend for
 *    the same CPU and report each other's latency as a regression.
 *  - Nothing that comes back out carries a stack trace or a credential
 *    (harness.ts, safeDetail).
 *
 * Suites run in registry order and cases run in declaration order: a run is
 * reproducible, and two runs of the same code are comparable line by line.
 */
import { createHash, randomUUID } from "node:crypto";
import type { EvalCaseResult, EvalFrame, EvalRun, EvalSuiteResult } from "../types.js";
import { EvalAssertion, EvalSkip, safeDetail, type EvalCase, type EvalSuite } from "./harness.js";
import { SUITES } from "./registry.js";

const DEFAULT_CASE_TIMEOUT_MS = 15_000;

let inFlight = false;

export function runInProgress(): boolean {
  return inFlight;
}

export class EvalRunBusy extends Error {
  constructor() {
    super("an eval run is already in progress");
    this.name = "EvalRunBusy";
  }
}

/**
 * Fingerprint of the questions being asked. Two runs are only comparable when
 * this matches: a lower score with a different hash means the suite was
 * rewritten, which is not a regression and must not be reported as one.
 */
export function caseSetHash(suites: { id: string; caseIds: string[] }[]): string {
  const shape = suites
    .map((s) => `${s.id}:${[...s.caseIds].sort().join(",")}`)
    .sort()
    .join("|");
  return createHash("sha256").update(shape).digest("hex").slice(0, 12);
}

/** Rejects after `ms`, but never leaves a timer holding the process open. */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const bell = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EvalAssertion(`timed out after ${ms}ms (${label})`)), ms);
    timer.unref?.();
  });
  return Promise.race([work, bell]).finally(() => clearTimeout(timer));
}

async function runCase(c: EvalCase, timeoutMs: number): Promise<EvalCaseResult> {
  const started = Date.now();
  const base = { id: c.id, name: c.name, ...(c.note && { note: c.note }) };
  try {
    // Promise.resolve() so a case that throws synchronously is caught here
    // rather than escaping the timeout wrapper.
    const detail = await withTimeout(Promise.resolve().then(c.run), timeoutMs, c.id);
    return { ...base, status: "pass", detail: safeDetail(detail), ms: Date.now() - started };
  } catch (err) {
    const ms = Date.now() - started;
    if (err instanceof EvalSkip) {
      return { ...base, status: "skipped", detail: safeDetail(err.message), ms };
    }
    if (err instanceof EvalAssertion) {
      return { ...base, status: "fail", detail: safeDetail(err.message), ms };
    }
    // Anything else is a bug in the code under test or in the case itself.
    // The message only. A stack trace is noise in a panel and a disclosure
    // risk in a screenshot.
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ...base, status: "fail", detail: safeDetail(`threw ${message}`), ms };
  }
}

function summarize(
  suite: EvalSuite,
  cases: EvalCaseResult[],
  ms: number,
  skipReason?: string,
): EvalSuiteResult {
  const passed = cases.filter((c) => c.status === "pass").length;
  const failed = cases.filter((c) => c.status === "fail").length;
  const skipped = cases.filter((c) => c.status === "skipped").length;
  const judged = passed + failed;
  const score = judged ? passed / judged : 0;
  const status: EvalSuiteResult["status"] = skipReason
    ? "skipped"
    : judged === 0
      ? "skipped"
      : score >= suite.threshold
        ? "pass"
        : "fail";
  return {
    id: suite.id,
    title: suite.title,
    what: suite.what,
    kind: suite.kind,
    status,
    score,
    threshold: suite.threshold,
    passed,
    failed,
    skipped,
    ms,
    ...(skipReason && { skipReason }),
    cases,
  };
}

export interface RunOptions {
  /** Suite ids to run; omit for all of them. Unknown ids are ignored. */
  only?: string[];
  onFrame?: (frame: EvalFrame) => void;
  /** Abort between cases; a closed HTTP connection should not keep working. */
  signal?: AbortSignal;
}

export async function runEvals(opts: RunOptions = {}): Promise<EvalRun> {
  if (inFlight) throw new EvalRunBusy();
  inFlight = true;
  const emit = (frame: EvalFrame) => opts.onFrame?.(frame);
  const startedAt = new Date();
  const t0 = Date.now();

  const chosen = opts.only?.length ? SUITES.filter((s) => opts.only!.includes(s.id)) : SUITES;

  try {
    const results: EvalSuiteResult[] = [];
    const shape: { id: string; caseIds: string[] }[] = [];

    for (const suite of chosen) {
      if (opts.signal?.aborted) break;
      const suiteStart = Date.now();

      // Building the case list can itself throw: a broken fixture must
      // report as one skipped suite, not take the whole run down.
      let cases: EvalCase[];
      try {
        cases = await suite.cases();
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        const result = summarize(
          suite,
          [],
          Date.now() - suiteStart,
          safeDetail(`cases failed to build: ${why}`),
        );
        results.push(result);
        emit({ type: "suite-done", result });
        continue;
      }
      shape.push({ id: suite.id, caseIds: cases.map((c) => c.id) });

      const unavailable = suite.available
        ? await suite.available().catch((err) => safeDetail(String(err)))
        : null;
      if (unavailable) {
        const result = summarize(suite, [], Date.now() - suiteStart, unavailable);
        results.push(result);
        emit({ type: "suite-done", result });
        continue;
      }

      emit({ type: "suite-start", id: suite.id, title: suite.title, total: cases.length });
      const caseResults: EvalCaseResult[] = [];
      for (const c of cases) {
        if (opts.signal?.aborted) break;
        const result = await runCase(c, suite.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS);
        caseResults.push(result);
        emit({ type: "case", suite: suite.id, result });
      }
      const result = summarize(suite, caseResults, Date.now() - suiteStart);
      results.push(result);
      emit({ type: "suite-done", result });
    }

    const passed = results.reduce((n, s) => n + s.passed, 0);
    const failed = results.reduce((n, s) => n + s.failed, 0);
    const skipped = results.reduce((n, s) => n + s.skipped, 0);
    const run: EvalRun = {
      id: randomUUID(),
      startedAt: startedAt.toISOString(),
      ms: Date.now() - t0,
      // A skipped suite never makes the run green: an unrun check is unknown,
      // and "unknown" must not be allowed to look like "fine".
      status:
        failed > 0 ? "fail" : results.some((s) => s.status === "skipped") ? "skipped" : "pass",
      passed,
      failed,
      skipped,
      suites: results,
      caseSetHash: caseSetHash(shape),
    };
    emit({ type: "done", run });
    return run;
  } finally {
    inFlight = false;
  }
}
