import { readdir, readFile } from "node:fs/promises";
import type { z } from "zod";
import { model_profileSchema } from "../llm/generated.js";
import type { LlmRuntime } from "../llm/runtime.js";

const dir = new URL("../../../llm/evals/profiles/", import.meta.url);

export type ModelProfile = z.infer<typeof model_profileSchema>;
export type ProfileGates = NonNullable<ModelProfile["gates"]>;

/**
 * The thresholds a judged run has to clear, from the reviewed profile of the model
 * family that generated and judged it. They were measured on that family, so a
 * model with no reviewed profile has none, and the run stops.
 *
 * The Python gate reads the same files (llm/grapevine_llm/profiles.py) and checks
 * the rules a schema cannot: one profile per model, and agreement with the manifest.
 */
export async function reviewedGates(runtime: LlmRuntime, model: string): Promise<ProfileGates> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  for (const name of files) {
    const profile = model_profileSchema.parse(
      JSON.parse(await readFile(new URL(name, dir), "utf8")),
    );
    if (!profile.served.some((s) => s.runtime === runtime && s.model === model)) continue;
    if (profile.status === "reviewed" && profile.gates) return profile.gates;
    break;
  }
  throw new Error(`No reviewed profile for ${model} on ${runtime}`);
}
