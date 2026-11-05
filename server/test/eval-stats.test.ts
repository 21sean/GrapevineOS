import { describe, expect, it } from "vitest";
import { formatRate, percentile, wilson } from "../src/evals/stats.js";
import { tally } from "../scripts/redteam-report.js";
import type { AttackResult } from "../src/evals/redteam.js";

const close = (v: number | null, want: number) => expect(v).toBeCloseTo(want, 3);

describe("the Wilson interval", () => {
  // Reference values from the closed form at z = 1.959964.
  it("does not collapse at zero", () => {
    const e = wilson(0, 20);
    expect(e.rate).toBe(0);
    expect(e.low).toBe(0);
    close(e.high, 0.1611);
  });

  it("matches the textbook value in the middle", () => {
    const e = wilson(5, 20);
    close(e.rate, 0.25);
    close(e.low, 0.1119);
    close(e.high, 0.4687);
  });

  it("is symmetric at the top", () => {
    const e = wilson(20, 20);
    expect(e.high).toBe(1);
    close(e.low, 1 - 0.1611);
  });

  it("reports nothing when nothing was scored", () => {
    expect(wilson(0, 0).rate).toBeNull();
    expect(formatRate(wilson(0, 0))).toContain("n/a");
  });
});

describe("percentile", () => {
  it("returns an observed value by nearest rank", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("the red team tally", () => {
  const result = (id: string, outcome: AttackResult["outcome"]): AttackResult => ({
    id,
    strategy: "crescendo",
    objective: id,
    outcome,
    outcome_reason: null,
    executed_turns: 1,
    score: null,
    turns: [],
    error: null,
  });

  it("keeps undetermined and unfinished out of the rate, and out of the pass column", () => {
    const rows = tally([
      result("a", "success"),
      result("a", "failure"),
      result("a", "undetermined"),
      result("b", "error"),
      result("b", "failure"),
    ]);
    const a = rows.find((r) => r.id === "a")!;
    expect([a.asr.successes, a.asr.total, a.undetermined, a.unfinished]).toEqual([1, 2, 1, 0]);
    const overall = rows.find((r) => r.id === "overall")!;
    expect([overall.asr.successes, overall.asr.total]).toEqual([1, 3]);
    expect([overall.undetermined, overall.unfinished]).toEqual([1, 1]);
  });
});
