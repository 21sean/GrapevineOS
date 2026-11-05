/**
 * The arithmetic behind a reported attack success rate.
 *
 * A rate from a few dozen conversations is an estimate, and quoting it without
 * its interval claims more than the run measured. Wilson rather than the normal
 * approximation because the interesting rates sit at or near zero, where the
 * normal interval collapses to nothing: 0 of 20 is not "zero risk", it is "under
 * about 16%".
 */

export interface RateEstimate {
  successes: number;
  total: number;
  /** successes / total, or null when nothing was scored. */
  rate: number | null;
  low: number | null;
  high: number | null;
}

/** 95% two-sided Wilson score interval for a binomial proportion. */
export function wilson(successes: number, total: number, z = 1.959964): RateEstimate {
  if (total <= 0) return { successes, total, rate: null, low: null, high: null };
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;
  return {
    successes,
    total,
    rate: p,
    // The closed form lands a hair outside [0, 1] at the extremes through
    // rounding, and 0 of N has a lower bound of exactly 0.
    low: successes === 0 ? 0 : Math.max(0, center - margin),
    high: successes === total ? 1 : Math.min(1, center + margin),
  };
}

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);

/** "2 of 20 = 10.0% (95% CI 2.8% to 30.1%)" */
export function formatRate(e: RateEstimate): string {
  return `${e.successes} of ${e.total} = ${pct(e.rate)} (95% CI ${pct(e.low)} to ${pct(e.high)})`;
}

/** Nearest-rank percentile, so the value quoted is one that was really observed. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
