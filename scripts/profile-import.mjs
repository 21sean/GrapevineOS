/**
 * Seed or refresh a model profile from models.dev, the open catalog the server's
 * model picker already reads.
 *
 *   node scripts/profile-import.mjs --provider anthropic --model claude-fable-5-2 --family claude-fable-5.2
 *   node scripts/profile-import.mjs --provider huggingface --model Qwen/Qwen3.8-27B --family qwen3.8
 *
 * A new family gets an imported profile: sourced facts and nothing else. The eval
 * gates refuse it until someone measures the family here and writes the reviewed
 * parts. An existing profile keeps everything a person wrote; only the facts that
 * came from models.dev, and the date they were read, are replaced.
 *
 * --from <file> reads a saved copy of the catalog instead of the network.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { root } from "./local-tools.mjs";

export const CATALOG_URL = "https://models.dev/api.json";
export const SOURCE_ID = "models-dev";
const FAMILY = /^[a-zA-Z0-9_.:-]+$/;

/** One fact per catalog field that changes how a family has to be asked or judged. */
export function catalogFacts(providerId, model) {
  const levels = (model.reasoning_options ?? []).flatMap((option) => option.values ?? []);
  const facts = [
    ["catalog_id", `${providerId}/${model.id}`],
    ["release_date", model.release_date],
    ["knowledge_cutoff", model.knowledge],
    ["open_weights", model.open_weights],
    ["context_tokens", model.limit?.context],
    ["output_tokens", model.limit?.output],
    // False means the API refuses a temperature, so a run cannot be pinned to 0.
    ["accepts_temperature", model.temperature],
    ["reasoning", model.reasoning],
    ["reasoning_levels", levels.length ? levels : undefined],
    ["tool_calls", model.tool_call],
    ["structured_output", model.structured_output],
    ["input_modalities", model.modalities?.input],
  ];
  return facts
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => ({ name, value, source: SOURCE_ID }));
}

export function importedProfile(catalog, { provider, model, family, publisher, today }) {
  if (!FAMILY.test(family ?? "")) throw new Error("--family must be letters, digits and . _ : -");
  const entry = catalog[provider];
  if (!entry) throw new Error(`models.dev has no provider ${provider}`);
  const found = entry.models?.[model];
  if (!found) throw new Error(`models.dev has no model ${model} under ${provider}`);
  return {
    family,
    name: found.name,
    publisher: publisher ?? entry.name,
    status: "imported",
    served: [],
    sources: [{ id: SOURCE_ID, name: "models.dev", url: CATALOG_URL, retrieved: today }],
    facts: catalogFacts(provider, found),
  };
}

/** Keep what a person wrote. Replace what the catalog said, and when it was read. */
export function refreshed(existing, imported) {
  if (existing.family !== imported.family) throw new Error("the file holds another family");
  const source = imported.sources[0];
  const kept = existing.facts.filter((fact) => fact.source !== SOURCE_ID);
  const taken = new Set(kept.map((fact) => fact.name));
  return {
    ...existing,
    sources: [...existing.sources.filter((s) => s.id !== SOURCE_ID), source],
    // A fact a person recorded from another source wins over the catalog's.
    facts: [...imported.facts.filter((fact) => !taken.has(fact.name)), ...kept],
  };
}

export function profilePath(family) {
  return path.join(root, "llm/evals/profiles", `${family}.json`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      family: { type: "string" },
      publisher: { type: "string" },
      from: { type: "string" },
    },
  });
  if (!values.provider || !values.model || !values.family) {
    console.error(
      "usage: profile-import --provider <id> --model <id> --family <id> [--publisher <name>] [--from <file>]",
    );
    process.exit(2);
  }
  let catalog;
  if (values.from) {
    catalog = JSON.parse(readFileSync(values.from, "utf8"));
  } else {
    const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
    catalog = await response.json();
  }
  const imported = importedProfile(catalog, {
    ...values,
    today: new Date().toISOString().slice(0, 10),
  });
  // Loaded here so the functions above need nothing but Node.
  const { format } = await import("prettier");
  const file = profilePath(values.family);
  const existed = existsSync(file);
  const profile = existed ? refreshed(JSON.parse(readFileSync(file, "utf8")), imported) : imported;
  writeFileSync(file, await format(JSON.stringify(profile), { parser: "json", printWidth: 100 }));
  console.log(
    `${existed ? "refreshed" : "created"} ${path.relative(root, file)} (${profile.status})`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
