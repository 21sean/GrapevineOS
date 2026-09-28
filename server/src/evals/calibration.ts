/**
 * Scoring the input rail against the labelled corpus.
 *
 * This is the offline half of the threshold question. The telemetry sweep
 * (guardrails/stats.ts) prices a threshold against real traffic but needs
 * somebody to have labelled that traffic first; this one has labels from the
 * start and can therefore answer "is 0.8 a defensible number" on a brand-new
 * checkout, before a single message has been sent.
 *
 * Both are needed and they measure different things. The corpus says how well
 * the classifier separates attacks from ordinary questions in principle; the
 * telemetry says what a threshold costs on the traffic this app actually gets.
 * A number that looks good on one and bad on the other is the interesting
 * case, and pooling them would hide it.
 */
import type { AttackFamily, CorpusEntry } from "./corpus.js";
import { FAMILY_NOTES } from "./corpus.js";

export interface Scored {
  entry: CorpusEntry;
  score: number;
}

export interface ConfusionAt {
  threshold: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  /** Benign entries wrongly blocked, as a share of all benign entries. */
  falsePositiveRate: number;
}

export function confusionAt(scored: Scored[], threshold: number): ConfusionAt {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const { entry, score } of scored) {
    const flagged = score >= threshold;
    if (entry.attack && flagged) tp++;
    else if (!entry.attack && flagged) fp++;
    else if (!entry.attack && !flagged) tn++;
    else fn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    threshold,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision,
    recall,
    f1,
    falsePositiveRate: fp + tn > 0 ? fp / (fp + tn) : 0,
  };
}

/**
 * Area under the ROC curve, computed from rank statistics (the Mann-Whitney
 * U identity) rather than by integrating a curve: it is exact, it needs no
 * threshold grid, and it handles ties correctly by giving them half credit.
 *
 * AUC is the right headline number for a classifier being tuned, because it
 * is threshold-independent. If AUC falls, no threshold will save you; if AUC
 * holds and the block rate moves, the threshold is what changed.
 */
export function auc(scored: Scored[]): number | null {
  const pos = scored.filter((s) => s.entry.attack).map((s) => s.score);
  const neg = scored.filter((s) => !s.entry.attack).map((s) => s.score);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) {
    for (const n of neg) {
      if (p > n) wins += 1;
      else if (p === n) wins += 0.5;
    }
  }
  return wins / (pos.length * neg.length);
}

/** The candidate thresholds worth evaluating: every observed score, plus 0.5. */
function candidates(scored: Scored[]): number[] {
  const set = new Set<number>([0.5]);
  for (const { score } of scored) {
    // Just above each observed score, so a candidate never sits exactly on a
    // value and inherit its tie behaviour by accident.
    set.add(Math.min(1, Math.round((score + 1e-4) * 10_000) / 10_000));
  }
  return [...set].filter((t) => t > 0 && t <= 1).sort((a, b) => a - b);
}

/** The threshold with the best F1, and the one with no false positives at all. */
export function bestThresholds(scored: Scored[]): {
  /**
   * Raw best F1. Reported for transparency and NOT used as a recommendation:
   * when the score distribution is bimodal, raw F1 is maximized by a
   * threshold near zero that blocks almost everything, which is arithmetically
   * correct and operationally insane.
   */
  bestF1: ConfusionAt | null;
  /** Lowest threshold that blocks no benign entry: the safe floor. */
  cleanest: ConfusionAt | null;
} {
  let bestF1: ConfusionAt | null = null;
  let cleanest: ConfusionAt | null = null;
  for (const t of candidates(scored)) {
    const c = confusionAt(scored, t);
    if (!bestF1 || c.f1 > bestF1.f1) bestF1 = c;
    // The lowest such threshold catches the most attacks while still costing
    // no false positives, which is the trade this app actually wants.
    if (c.falsePositives === 0 && !cleanest) cleanest = c;
  }
  return { bestF1, cleanest };
}

export interface FamilyResult {
  family: AttackFamily;
  /** Entries this rail is meant to catch. */
  inScope: number;
  inScopeDetected: number;
  /** Entries expected to reach the model; reported, never scored against. */
  outOfScope: number;
  outOfScopeDetected: number;
  /** Recall over the in-scope entries only. */
  recall: number;
  why: string;
  minScore: number;
  maxScore: number;
}

/**
 * Per-family recall at a given threshold, in scope and out kept apart.
 *
 * Never pooled: the families are not equally detectable, and an aggregate
 * would let a rail that has stopped catching indirect injections hide behind
 * one that still catches blunt overrides.
 */
export function byFamily(scored: Scored[], threshold: number): FamilyResult[] {
  const attacks = scored.filter((s) => s.entry.attack);
  const families = [...new Set(attacks.map((s) => s.entry.family))] as AttackFamily[];
  return families.map((family) => {
    const rows = attacks.filter((s) => s.entry.family === family);
    const inScope = rows.filter((s) => s.entry.scope === "in");
    const out = rows.filter((s) => s.entry.scope === "out");
    const detected = inScope.filter((s) => s.score >= threshold).length;
    return {
      family,
      inScope: inScope.length,
      inScopeDetected: detected,
      outOfScope: out.length,
      outOfScopeDetected: out.filter((s) => s.score >= threshold).length,
      recall: inScope.length ? detected / inScope.length : 1,
      why: FAMILY_NOTES[family] ?? "",
      minScore: Math.min(...rows.map((s) => s.score)),
      maxScore: Math.max(...rows.map((s) => s.score)),
    };
  });
}

/**
 * The subset calibration is scored on: everything this rail is responsible
 * for. Out-of-scope attacks are excluded rather than counted as misses; see
 * SCOPE_RULE in corpus.ts for why that is a measurement decision and not a
 * generous one.
 */
export function inScope(scored: Scored[]): Scored[] {
  return scored.filter((s) => s.entry.scope === "in");
}

/**
 * The widest run of scores containing no entry at all, above the highest
 * benign score. A wide gap means the exact threshold barely matters (every
 * value inside it produces identical behaviour), which is the single most
 * useful thing to know before spending time tuning one.
 */
export function deadBand(scored: Scored[]): { lo: number; hi: number; width: number } | null {
  const sorted = [...scored].sort((a, b) => a.score - b.score);
  let best: { lo: number; hi: number; width: number } | null = null;
  for (let i = 1; i < sorted.length; i++) {
    const width = sorted[i].score - sorted[i - 1].score;
    if (!best || width > best.width) {
      best = { lo: sorted[i - 1].score, hi: sorted[i].score, width };
    }
  }
  return best;
}

export const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
