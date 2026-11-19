import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { reviewedGates } from "../src/evals/profile.js";
import type { LlmRuntime } from "../src/llm/runtime.js";

const MANIFESTS: Record<LlmRuntime, string> = {
  ollama: "models.json",
  vllm: "models.vllm.json",
  triton: "models.triton.json",
};

async function judgeName(runtime: LlmRuntime): Promise<string> {
  const file = new URL(`../../llm/evals/${MANIFESTS[runtime]}`, import.meta.url);
  return (JSON.parse(await readFile(file, "utf8")) as { judge: { name: string } }).judge.name;
}

it.each(["ollama", "vllm", "triton"] as const)(
  "reads the judge thresholds for the model %s pins",
  async (runtime) => {
    const gates = await reviewedGates(runtime, await judgeName(runtime));
    expect(gates.judge_score_min).toBe(0.75);
    expect(gates.faithfulness_floor).toBe(0.75);
    expect(gates.faithfulness_drop).toBe(0.15);
    expect(gates.first_pass_rate_min).toBe(0.95);
  },
);

it("stops for a model no reviewed profile governs", async () => {
  await expect(reviewedGates("ollama", "gemma4:31b")).rejects.toThrow(
    "No reviewed profile for gemma4:31b on ollama",
  );
  // A profile governs a model on the runtimes it names, and nowhere else.
  await expect(reviewedGates("ollama", await judgeName("vllm"))).rejects.toThrow(
    "No reviewed profile",
  );
});
