/**
 * Every suite, in the order the panel and the CLI both show them: the cheap
 * deterministic ones first, then the ones that need the local classifier, then
 * the LLM-judged ones last. A run gives useful answers early even if it is
 * interrupted, and the expensive judged suites never delay the cheap signal.
 *
 * The three-tier ordering matters more now than it did: `offline` suites are
 * milliseconds, `model` suites are seconds, and `judge` suites are minutes of
 * local GPU. Putting them in cost order is what makes "run everything" a
 * reasonable default instead of something people learn to avoid.
 *
 * One registry, two consumers — Admin → Monitoring and `npm run evals`. That is the
 * point of the file. A dashboard whose numbers come from a different code path
 * than the CI gate is a dashboard that eventually disagrees with the gate, and
 * the first time they disagree nobody can tell which one is lying.
 */
import type { EvalSuite } from "./harness.js";
import { dedupeSuite } from "./suites/dedupe.js";
import { calibrationSuite } from "./suites/guardrails-calibration.js";
import { guardrailsJudgeSuite } from "./suites/guardrails-judge.js";
import { redteamSuite } from "./suites/guardrails-redteam.js";
import { guardrailsSuite } from "./suites/guardrails.js";
import { hoursSuite } from "./suites/hours.js";
import { jsonldSuite } from "./suites/jsonld.js";
import { personaSuite } from "./suites/personas.js";
import { recurrenceSuite } from "./suites/recurrence.js";

export const SUITES: EvalSuite[] = [
  personaSuite,
  dedupeSuite,
  recurrenceSuite,
  jsonldSuite,
  hoursSuite,
  guardrailsSuite,
  calibrationSuite,
  guardrailsJudgeSuite,
  redteamSuite,
];

export function suiteById(id: string): EvalSuite | undefined {
  return SUITES.find((s) => s.id === id);
}
