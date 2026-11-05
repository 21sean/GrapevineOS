import { describe, expect, it } from "vitest";
import { personaGuard } from "../src/agent/guardrails.js";
import { LEAKS } from "../src/evals/guardrail-fixtures.js";

/** Push text through the guard in ragged chunks, the way a model streams it. */
function stream(text: string, size: number, modelName = "qwen3:30b-a3b") {
  const guard = personaGuard({ modelName, telemetry: { record: false } });
  let out = "";
  for (let i = 0; i < text.length; i += size) {
    out += guard.push(text.slice(i, i + size));
    if (guard.tripped) break;
  }
  out += guard.flush();
  return { out, tripped: guard.tripped, pattern: guard.pattern };
}

describe("the persona guard", () => {
  it("catches a leak that is split across two chunks inside the hold-back", () => {
    const { tripped, out } = stream("I am Qwen, a large language model developed by Alibaba.", 3);
    expect(tripped).toBe(true);
    // Nothing of the leak was ever emitted.
    expect(out).not.toMatch(/Qwen/);
  });

  it("trips on every known leak fixture, whatever the chunking", () => {
    for (const [id, text] of LEAKS) {
      for (const size of [1, 7, 64]) {
        expect(stream(text, size).tripped, `${id} at ${size}`).toBe(true);
      }
    }
  });

  it("leaves ordinary answers byte-identical", () => {
    const text =
      "Tonight: [Shoreline Jazz](event:shoreline-jazz) at 7, free. The llama petting zoo runs Sundays.";
    const { out, tripped } = stream(text, 5);
    expect(tripped).toBe(false);
    expect(out).toBe(text);
  });

  it("adds the active model's family to the blocklist, but not a stoplisted word", () => {
    expect(stream("Honestly, deepseek does this well.", 4, "deepseek-r1:7b").tripped).toBe(true);
    expect(stream("Honestly, deepseek does this well.", 4, "qwen3:30b").tripped).toBe(true);
    expect(stream("The llama petting zoo is real.", 4, "llama3.1:8b").tripped).toBe(false);
  });
});

describe("a refusal that describes what it is refusing to name", () => {
  const trips = (text: string) => {
    const guard = personaGuard({ modelName: "test" });
    guard.push(text);
    guard.flush();
    return guard.tripped;
  };

  it("trips, because naming it answers the question", () => {
    expect(trips("I can't share details about the underlying model or vendor.")).toBe(true);
    expect(trips("I can't share details about what powers me, but here's jazz.")).toBe(true);
    expect(trips("Focus on the app rather than the AI infrastructure behind it.")).toBe(true);
    expect(trips("I don't have a training-data cutoff to report.")).toBe(true);
  });

  it("leaves ordinary event talk alone", () => {
    expect(trips("The AI meetup at the library covers what models can do for small shops.")).toBe(
      false,
    );
    expect(trips("Solar panels on the roof are what powers the stage at the festival.")).toBe(
      false,
    );
    expect(trips("A two-day training for volunteers, with data on tide pools.")).toBe(false);
  });
});
