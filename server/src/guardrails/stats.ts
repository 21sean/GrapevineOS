/**
 * Turning recorded scans into the two numbers the threshold question actually
 * needs: has the distribution moved, and what would a different threshold do.
 *
 * Both are computed here rather than in the browser, because both are easy to
 * get subtly wrong and a dashboard that computes its own statistics is a
 * dashboard nobody can check against anything.
 */
import type {
  GuardrailBucket,
  GuardrailDay,
  GuardrailRail,
  GuardrailRailStats,
  GuardrailSweep,
  GuardrailSweepPoint,
  GuardrailWindow,
} from "../types.js";
import { GUARDRAIL_RAILS } from "../types.js";
import type { LabelledScan } from "../store.js";

// ---------------------------------------------------------------------------
// The RPC's jsonb, checked on the way in
// ---------------------------------------------------------------------------

/** `[count, blockedCount]` per bucket, low score to high. */
type RawHist = [number, number][];

interface RawWindow {
  n: number;
  blocked: number;
  wouldBlock: number;
  scored: number;
  meanMs: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  hist: RawHist;
}

export interface RawStats {
  windowDays: number;
  buckets: number;
  total: number;
  oldest: string | null;
  rails: Partial<Record<GuardrailRail, Partial<Record<"recent" | "baseline", RawWindow>>>>;
  daily: GuardrailDay[];
}

const EMPTY_WINDOW: GuardrailWindow = {
  n: 0,
  blocked: 0,
  wouldBlock: 0,
  scored: 0,
  meanMs: 0,
  p50: null,
  p90: null,
  p95: null,
  p99: null,
  max: null,
  buckets: [],
};

/** Widen a raw window into the wire shape, giving every bucket its edges. */
function toWindow(raw: RawWindow | undefined, buckets: number): GuardrailWindow | null {
  if (!raw) return null;
  const width = 1 / buckets;
  const hist = Array.isArray(raw.hist) ? raw.hist : [];
  return {
    n: raw.n ?? 0,
    blocked: raw.blocked ?? 0,
    wouldBlock: raw.wouldBlock ?? 0,
    scored: raw.scored ?? 0,
    meanMs: raw.meanMs ?? 0,
    p50: raw.p50 ?? null,
    p90: raw.p90 ?? null,
    p95: raw.p95 ?? null,
    p99: raw.p99 ?? null,
    max: raw.max ?? null,
    buckets: hist.map(([n, blocked], i): GuardrailBucket => ({
      lo: i * width,
      hi: (i + 1) * width,
      n: n ?? 0,
      blocked: blocked ?? 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

/**
 * Population stability index between two histograms of the same shape.
 *
 *   PSI = Σ (recent% − baseline%) · ln(recent% / baseline%)
 *
 * The standard measure for "has this distribution moved", chosen over
 * something bespoke precisely because its thresholds are conventional and
 * arguable by people who did not write this code: under 0.1 is noise, 0.1 to
 * 0.25 is worth a look, over 0.25 is a real shift.
 *
 * Empty buckets are floored rather than dropped. A bucket that had traffic
 * last week and none this week is the single most informative bucket in the
 * comparison, and ln(0) would throw it away as an infinity.
 */
export function psi(recent: GuardrailBucket[], baseline: GuardrailBucket[]): number | null {
  if (!recent.length || recent.length !== baseline.length) return null;
  const rTotal = recent.reduce((n, b) => n + b.n, 0);
  const bTotal = baseline.reduce((n, b) => n + b.n, 0);
  // Below this, the "shift" is sampling noise and reporting it as drift trains
  // people to ignore the number.
  if (rTotal < 50 || bTotal < 50) return null;

  const floor = 1 / Math.max(rTotal, bTotal) / 10;
  let total = 0;
  for (let i = 0; i < recent.length; i++) {
    const r = Math.max(floor, recent[i].n / rTotal);
    const b = Math.max(floor, baseline[i].n / bTotal);
    total += (r - b) * Math.log(r / b);
  }
  return total;
}

function driftVerdict(value: number | null): GuardrailRailStats["driftVerdict"] {
  if (value === null) return "unknown";
  if (value < 0.1) return "stable";
  if (value < 0.25) return "moderate";
  return "significant";
}

// ---------------------------------------------------------------------------
// Threshold sweep
// ---------------------------------------------------------------------------

/**
 * A label is attached to a DECISION, not to a piece of ground truth, so the
 * truth has to be recovered from the pair. "Correct" means the call the
 * classifier made was the right one, whichever way it went:
 *
 *   flagged + correct         → really was an injection   (positive)
 *   flagged + false_positive  → really was benign          (negative)
 *   allowed + correct         → really was benign          (negative)
 *   allowed + false_negative  → really was an injection    (positive)
 *
 * Anything else (allowed + false_positive) is a contradiction — somebody
 * mislabelled — and is dropped rather than guessed at.
 */
function groundTruth(row: LabelledScan): boolean | null {
  if (row.label === "correct") return row.flagged;
  if (row.label === "false_positive") return row.flagged ? false : null;
  if (row.label === "false_negative") return row.flagged ? null : true;
  return null;
}

/**
 * What each candidate threshold would do.
 *
 * Two independent things are reported per candidate, and they come from
 * different places on purpose:
 *
 *  - `blockRate` comes from the histogram, so it covers ALL traffic. This is
 *    the number that says "0.6 would block one message in twenty", which is
 *    the cost side of the decision and needs no labels at all.
 *  - the confusion counts come from the labelled rows only. They are the
 *    benefit side, and they are only as good as the labelling — which is why
 *    the count of labelled rows is reported next to them rather than buried.
 *
 * Candidates are the histogram's own bucket edges, so `blockRate` is exact
 * rather than interpolated. Interpolating inside a bucket would invent
 * precision the recorded data does not have.
 */
export function sweep(buckets: GuardrailBucket[], labelled: LabelledScan[]): GuardrailSweep {
  const scored = labelled.filter(
    (r): r is LabelledScan & { score: number } => typeof r.score === "number",
  );
  const truths = scored
    .map((r) => ({ score: r.score, truth: groundTruth(r) }))
    .filter((r): r is { score: number; truth: boolean } => r.truth !== null);

  const total = buckets.reduce((n, b) => n + b.n, 0);
  const points: GuardrailSweepPoint[] = [];

  // Bucket edges, skipping 0 (blocks everything) and 1 (blocks nothing).
  for (let i = 1; i < buckets.length; i++) {
    const threshold = buckets[i].lo;
    const atOrAbove = buckets.slice(i).reduce((n, b) => n + b.n, 0);

    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;
    for (const { score, truth } of truths) {
      const flagged = score >= threshold;
      if (truth && flagged) tp++;
      else if (!truth && flagged) fp++;
      else if (!truth && !flagged) tn++;
      else fn++;
    }

    const precision = tp + fp > 0 ? tp / (tp + fp) : null;
    const recall = tp + fn > 0 ? tp / (tp + fn) : null;
    const f1 =
      precision !== null && recall !== null && precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : null;

    points.push({
      threshold,
      blockRate: total > 0 ? atOrAbove / total : 0,
      truePositives: tp,
      falsePositives: fp,
      trueNegatives: tn,
      falseNegatives: fn,
      precision,
      recall,
      f1,
    });
  }

  const best = points.reduce<GuardrailSweepPoint | null>(
    (acc, p) => (p.f1 !== null && (acc === null || p.f1 > (acc.f1 ?? -1)) ? p : acc),
    null,
  );

  // Say why the answer is weak, rather than presenting a confident-looking
  // best-F1 computed from four rows.
  let note: string | undefined;
  if (!labelled.length) {
    note =
      "No labelled decisions yet. Block rate is measured from all traffic; precision and recall need labels — judge a few from the review queue below.";
  } else if (truths.length < 20) {
    note = `Only ${truths.length} labelled decision${truths.length === 1 ? "" : "s"} — the block-rate column is solid, but treat precision, recall and the suggested threshold as a hint until there are a few dozen.`;
  } else if (truths.length < labelled.length) {
    note = `${labelled.length - truths.length} labelled row${labelled.length - truths.length === 1 ? "" : "s"} excluded: no score (output rail) or a contradictory label.`;
  }

  return {
    points,
    bestF1: best?.threshold ?? null,
    labelled: truths.length,
    ...(note && { note }),
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Shape the RPC payload plus the labelled set into what the panel renders. */
export function railStats(raw: RawStats): GuardrailRailStats[] {
  return GUARDRAIL_RAILS.filter((rail) => raw.rails?.[rail]).map((rail) => {
    const windows = raw.rails[rail]!;
    const recent = toWindow(windows.recent, raw.buckets) ?? EMPTY_WINDOW;
    const baseline = toWindow(windows.baseline, raw.buckets);
    const drift = baseline ? psi(recent.buckets, baseline.buckets) : null;
    return { rail, recent, baseline, drift, driftVerdict: driftVerdict(drift) };
  });
}
