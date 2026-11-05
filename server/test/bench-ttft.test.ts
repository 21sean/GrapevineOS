import { describe, expect, it } from "vitest";
import { benchCatalog, withNonce } from "../scripts/bench-fixture.js";
import { percentiles, summarize } from "../scripts/bench-ttft.js";

const sample = (over = {}) => ({
  question: "q",
  toolFirst: false,
  visibleTtftMs: 100,
  visibleTpotMs: 10,
  e2eMs: 1000,
  modelTtftMs: 80,
  modelAnswerTtftMs: 95,
  modelTpotMs: 9,
  outputTokens: 50,
  promptTokens: 1000,
  cachedTokens: 800,
  retracted: false,
  error: null,
  ...over,
});

describe("the bench summary", () => {
  it("ignores missing values rather than reading them as zero", () => {
    expect(percentiles([null, 5, null, 7]).n).toBe(2);
    expect(percentiles([null]).p99).toBeNull();
  });

  it("works out output rate and prefix-cache hit rate from the runtime's counts", () => {
    const s = summarize([sample(), sample({ cachedTokens: 600 })]);
    expect(s.output_tokens_per_s.p50).toBe(50);
    expect(s.cache_hit_rate).toBeCloseTo(0.7);
    expect(s.retractions).toBe(0);
  });

  it("does not let a failed turn into the latency numbers, and counts it", () => {
    const s = summarize([sample(), sample({ error: "boom", visibleTtftMs: 99999 })]);
    expect(s.errors).toBe(1);
    expect(s.visible_ttft_ms.p99).toBe(100);
    expect(summarize([sample({ cachedTokens: null })]).cache_hit_rate).toBeNull();
  });
});

describe("the bench catalogs", () => {
  const now = new Date("2026-11-04T12:00:00-08:00");

  it("starts the fixture week now, so the app does not drop it as past", () => {
    const events = benchCatalog(15, now);
    expect(events).toHaveLength(15);
    const upcoming = events.filter((e) => Date.parse(e.end) >= now.getTime());
    expect(upcoming.length).toBeGreaterThan(10);
  });

  it("scales to the digest limit with unique ids and is the same on every call", () => {
    const events = benchCatalog(120, now);
    expect(events).toHaveLength(120);
    expect(new Set(events.map((e) => e.id)).size).toBe(120);
    expect(JSON.stringify(benchCatalog(120, now))).toBe(JSON.stringify(events));
  });

  it("changes only the soonest listing when forcing a cache miss", () => {
    const events = benchCatalog(30, now);
    const changed = withNonce(events, 7);
    const differs = changed.filter((e, i) => e.title !== events[i].title);
    expect(differs).toHaveLength(1);
    expect(differs[0].title).toContain("update 7");
  });
});
