import assert from "node:assert/strict";
import test from "node:test";
import { catalogFacts, importedProfile, refreshed, SOURCE_ID } from "./profile-import.mjs";

const CATALOG = {
  lab: {
    name: "Lab",
    models: {
      "lab-large-1": {
        id: "lab-large-1",
        name: "Lab Large 1",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        tool_call: true,
        structured_output: true,
        temperature: false,
        knowledge: "2026-06",
        release_date: "2026-11-09",
        open_weights: false,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1000000, output: 128000 },
        cost: { input: 8, output: 40 },
      },
      bare: { id: "bare", name: "Bare" },
    },
  },
};
const args = { provider: "lab", model: "lab-large-1", family: "lab-large-1", today: "2026-11-18" };
const value = (profile, name) => profile.facts.find((fact) => fact.name === name)?.value;

test("an import holds sourced facts and nothing a gate could run on", () => {
  const profile = importedProfile(CATALOG, args);
  assert.equal(profile.status, "imported");
  assert.deepEqual(profile.served, []);
  assert.equal(profile.request, undefined);
  assert.equal(profile.gates, undefined);
  assert.equal(profile.publisher, "Lab");
  assert.deepEqual(profile.sources, [
    {
      id: SOURCE_ID,
      name: "models.dev",
      url: "https://models.dev/api.json",
      retrieved: "2026-11-18",
    },
  ]);
  assert.ok(profile.facts.every((fact) => fact.source === SOURCE_ID));
  assert.equal(value(profile, "catalog_id"), "lab/lab-large-1");
  assert.equal(value(profile, "accepts_temperature"), false);
  assert.equal(value(profile, "context_tokens"), 1000000);
  assert.deepEqual(value(profile, "reasoning_levels"), ["low", "high"]);
  assert.deepEqual(value(profile, "input_modalities"), ["text", "image"]);
});

test("prices are left out: they belong to a host, not to the model", () => {
  const names = catalogFacts("lab", CATALOG.lab.models["lab-large-1"]).map((fact) => fact.name);
  assert.ok(!names.some((name) => /cost|price|usd/.test(name)));
});

test("a field the catalog does not state is not recorded", () => {
  assert.deepEqual(
    catalogFacts("lab", CATALOG.lab.models.bare).map((fact) => fact.name),
    ["catalog_id"],
  );
});

test("an unknown provider, model or family name stops the import", () => {
  assert.throws(() => importedProfile(CATALOG, { ...args, provider: "nope" }), /no provider/);
  assert.throws(() => importedProfile(CATALOG, { ...args, model: "nope" }), /no model/);
  assert.throws(() => importedProfile(CATALOG, { ...args, family: "has space" }), /--family/);
});

test("a refresh replaces catalog facts and keeps what a person wrote", () => {
  const card = {
    id: "card",
    name: "Model card",
    url: "https://example.com",
    retrieved: "2026-10-01",
  };
  const existing = {
    family: "lab-large-1",
    name: "Lab Large 1",
    publisher: "Lab",
    status: "reviewed",
    served: [{ runtime: "ollama", model: "lab-large:1" }],
    request: { temperature: 0 },
    gates: { judge_score_min: 0.75 },
    sources: [{ id: SOURCE_ID, name: "models.dev", url: "x", retrieved: "2026-01-01" }, card],
    facts: [
      { name: "context_tokens", value: 5, source: SOURCE_ID },
      { name: "output_tokens", value: 4096, source: "card" },
      { name: "sampling", value: "temperature 0.7", source: "card" },
    ],
    departures: [{ setting: "Sampling" }],
  };
  const next = refreshed(existing, importedProfile(CATALOG, args));
  assert.equal(next.status, "reviewed");
  assert.deepEqual(next.served, existing.served);
  assert.deepEqual(next.request, existing.request);
  assert.deepEqual(next.gates, existing.gates);
  assert.deepEqual(next.departures, existing.departures);
  assert.equal(next.sources.find((s) => s.id === SOURCE_ID).retrieved, "2026-11-18");
  assert.deepEqual(
    next.sources.find((s) => s.id === "card"),
    card,
  );
  assert.equal(value(next, "context_tokens"), 1000000);
  // The card's figure stands where a person recorded one.
  assert.equal(value(next, "output_tokens"), 4096);
  assert.equal(next.facts.filter((fact) => fact.name === "output_tokens").length, 1);
  assert.equal(value(next, "sampling"), "temperature 0.7");
});

test("a refresh refuses a file that holds another family", () => {
  assert.throws(
    () => refreshed({ family: "other", sources: [], facts: [] }, importedProfile(CATALOG, args)),
    /another family/,
  );
});
