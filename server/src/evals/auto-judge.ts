/**
 * The judge, on a timer: conversations get graded without anyone clicking
 * the gavel. Every sweep looks at the monitor view, picks threads that have
 * gone quiet and have no verdict newer than their last message, and judges
 * ONE of them — the judge is a 27B model on the same GPU that serves chat,
 * so the sweep deliberately trickles instead of batching. A busy day catches
 * up over the following hours; the panel's numbers stop being "whenever
 * someone last remembered".
 *
 * Knobs (server/.env):
 *   EVAL_SWEEP_MINUTES       cadence, default 10, 0 disables the sweep
 *   EVAL_SWEEP_IDLE_MINUTES  how long a thread must be quiet first, default 30
 *
 * Skips, never errors: judge not installed, Ollama down, a thread with no
 * assistant replies — each just leaves the thread for a later sweep.
 */
import { recordConversationScores } from "../langfuse.js";
import { startLoop } from "../lifecycle.js";
import { logger } from "../log.js";
import { store } from "../store.js";
import { evaluateConversation } from "./conversation-judge.js";
import { judgeUnavailable } from "./judge.js";
import { runInProgress } from "./runner.js";

const log = logger("auto-judge");

function sweepMinutes(): number {
  const raw = Number(process.env.EVAL_SWEEP_MINUTES ?? 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10;
}

function idleMinutes(): number {
  const raw = Number(process.env.EVAL_SWEEP_IDLE_MINUTES ?? 30);
  return Number.isFinite(raw) && raw >= 1 ? raw : 30;
}

let sweeping = false;

/** One pass: judge at most one idle, unjudged thread. Returns what it did. */
export async function sweepOnce(): Promise<string> {
  if (sweeping) return "skip: previous sweep still judging";
  // The eval board and the sweep share one local judge; a suite run wins.
  if (runInProgress()) return "skip: an eval run is in progress";
  const unavailable = await judgeUnavailable();
  if (unavailable) return `skip: ${unavailable}`;

  const idleCutoff = Date.now() - idleMinutes() * 60_000;
  const rows = await store.conversationMonitor(50);
  const candidate = rows
    .filter((r) => {
      const updated = Date.parse(r.updatedAt);
      if (!Number.isFinite(updated) || updated > idleCutoff) return false;
      if (!r.turns || r.turns < 2) return false;
      return !r.eval || Date.parse(r.eval.at) < updated;
    })
    // Never judged before judged-but-stale; then oldest quiet thread first.
    .sort((a, b) => {
      if (!a.eval !== !b.eval) return a.eval ? 1 : -1;
      return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
    })[0];
  if (!candidate) return "nothing to judge";

  sweeping = true;
  try {
    const messages = await store.adminChatMessages(candidate.id);
    if (!messages?.some((m) => m.role === "assistant"))
      return `skip: ${candidate.id} has no replies`;
    const judged = await evaluateConversation(messages);
    const saved = await store.recordConversationEval(candidate.id, judged);
    void recordConversationScores(saved);
    return `judged ${candidate.id}: ${judged.verdict} at ${Math.round(judged.overall * 100)}% in ${(judged.ms / 1000).toFixed(1)}s`;
  } finally {
    sweeping = false;
  }
}

export function startEvalSweep(): void {
  const minutes = sweepMinutes();
  if (minutes > 0) log.info(`every ${minutes}m, judging threads idle ${idleMinutes()}m+`);
  // No immediate pass: booting the server should never race the guardrail
  // warmup and model load for the GPU.
  startLoop({
    name: "eval sweep",
    enabled: minutes > 0,
    disabledReason: "EVAL_SWEEP_MINUTES=0",
    intervalMs: minutes * 60_000,
    run: async () => {
      const outcome = await sweepOnce();
      if (outcome.startsWith("judged")) log.info(outcome);
    },
  });
}
