/**
 * The LLM judge behind the graded suites: DeepEval metrics scored by the
 * local Ollama model, so a judged eval costs GPU time and nothing else.
 *
 * Why a judge at all, when the guardrails suite already asserts on regexes:
 * the deterministic rails can only catch the failures somebody already wrote
 * a pattern for. "I am Qwen" is in the list because it happened once in
 * production. The interesting question (did the assistant break character in
 * a way nobody has thought of yet?) is not expressible as a regex, and that
 * is the question a judge is for. The two are complementary and neither
 * replaces the other, which is why both suites exist.
 *
 * Everything here degrades to a skip rather than a failure. A judge that is
 * not installed is not a regression, and a suite that goes red because Ollama
 * was restarting teaches people to ignore red.
 */
// Must precede the deepeval import; see the module for why.
import "./deepeval-env.js";
import { OllamaModel } from "deepeval/models";
import { listInstalled, ollamaBase } from "../ollama.js";
import { store } from "../store.js";

/**
 * Judging is a small, structured classification, so the judge does not need
 * to be the chat model. It does need to be reliable at JSON, which is why the
 * default is a mainstream instruct model rather than whatever is smallest.
 */
const FALLBACK_JUDGE = "qwen3:8b";

export function judgeModelName(configured?: string): string {
  return process.env.EVAL_JUDGE_MODEL || configured || FALLBACK_JUDGE;
}

/** Resolved once per run so every metric in a suite shares one judge. */
export interface Judge {
  model: OllamaModel;
  name: string;
  baseUrl: string;
}

let cached: Judge | null = null;

export async function judge(): Promise<Judge> {
  if (cached) return cached;
  const baseUrl = await ollamaBase();
  const configured = await store
    .settings()
    .then((s) => s.model)
    .catch(() => "");
  const name = judgeModelName(configured);
  cached = {
    name,
    baseUrl,
    model: new OllamaModel({
      model: name,
      baseURL: baseUrl,
      // Judging is a classification, not a creative act. A judge that gives a
      // different verdict on the same transcript twice makes every score it
      // produces unfalsifiable.
      temperature: 0,
    }),
  };
  return cached;
}

/**
 * Non-null reason the judged suites cannot run right now.
 *
 * Checks that the daemon answers AND that the specific model is pulled: a
 * running Ollama with the wrong model produces a confident 404 halfway
 * through a suite, which reads as a failing eval rather than a missing one.
 */
export async function judgeUnavailable(): Promise<string | null> {
  let base: string;
  try {
    base = await ollamaBase();
  } catch (err) {
    return `could not resolve the Ollama URL: ${String(err).slice(0, 120)}`;
  }

  const up = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(3_000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!up) return `Ollama isn't answering at ${base}, where the judge model runs`;

  const { name } = await judge();
  const installed = await listInstalled().catch(() => []);
  if (!installed.length) return `no models installed on ${base}`;
  // Ollama tags are exact, but people configure "qwen3" for "qwen3:8b" all the
  // time; accept the family match rather than failing on a colon.
  const has = installed.some((m) => m.name === name || m.name.startsWith(`${name}:`));
  if (!has) {
    return `judge model ${name} is not installed (ollama pull ${name}, or set EVAL_JUDGE_MODEL)`;
  }
  return null;
}

/**
 * Shared metric options. `showIndicator` off is not cosmetic: DeepEval's
 * default renders spinners and progress bars on stdout, and these suites run
 * inside a process whose stdout is an NDJSON stream to a browser panel.
 */
export const METRIC_DEFAULTS = {
  showIndicator: false,
  verboseMode: false,
  includeReason: true,
} as const;
