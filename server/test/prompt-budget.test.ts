import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { promptSections, type AgentCtx } from "../src/agent/context.js";
import { toolsFor } from "../src/agent/contracts.js";
import {
  GATE_SCHEMA_CHARS,
  PROMPT_BUDGET_CHARS,
  fitToBudget,
  modelPrompt,
} from "../src/agent/graph.js";
import { benchCatalog } from "../scripts/bench-fixture.js";
import { FIXTURE_NOW, fixtureCtx } from "../src/evals/fixtures.js";

/**
 * The prompt at the size a real catalog makes it. The stored catalog had 354 upcoming
 * events at the time this was written, with a median of about 800 characters of JSON,
 * and the fixture's 15 events never showed the overflow this guards against.
 */
const REAL_CATALOG_EVENTS = 354;

function bigCtx(): AgentCtx {
  return fixtureCtx({ events: benchCatalog(REAL_CATALOG_EVENTS, FIXTURE_NOW) });
}

function systemMessages(ctx: AgentCtx) {
  const s = promptSections(ctx, {}, true);
  return [s.instructions, s.visitor, s.clock].map((t) => new SystemMessage(t));
}

describe("the prompt on a realistic catalog", () => {
  it("fits the context with room for the answer, on a first turn", () => {
    const ctx = bigCtx();
    expect(ctx.upcoming.length).toBeGreaterThan(300);
    const { prompt } = modelPrompt(ctx, toolsFor("graph"), [
      ...systemMessages(ctx),
      new HumanMessage("What is on tonight?"),
    ]);
    const chars = prompt.reduce((sum, m) => sum + m.content.length, 0);
    expect(chars).toBeLessThanOrEqual(PROMPT_BUDGET_CHARS);
    // Well inside it, because the next assertion is what the budget is for.
    expect(chars).toBeLessThan(PROMPT_BUDGET_CHARS * 0.9);
  });

  it("keeps the instructions and the question however long the conversation got", () => {
    const ctx = bigCtx();
    const long = "A long reply about parking and doors and the weather. ".repeat(150);
    const history = Array.from({ length: 30 }, (_, i) =>
      i % 2 ? new AIMessage(`${long} ${i}`) : new HumanMessage(`Question ${i}`),
    );
    const { prompt } = modelPrompt(ctx, toolsFor("graph"), [
      ...systemMessages(ctx),
      ...history,
      new HumanMessage("And what about tomorrow?"),
    ]);
    const chars = prompt.reduce((sum, m) => sum + m.content.length, 0);
    expect(chars).toBeLessThanOrEqual(PROMPT_BUDGET_CHARS);
    expect(prompt.at(-1)?.content).toBe("And what about tomorrow?");
    expect(prompt.filter((m) => m.role === "system")).toHaveLength(4);
    expect(prompt.some((m) => m.content.includes("Identity, non-negotiable"))).toBe(true);
    expect(prompt.some((m) => m.content.includes("authoritative"))).toBe(true);
    // The newest of the history survives and the oldest went first.
    expect(prompt.some((m) => m.content.endsWith(" 29"))).toBe(true);
    expect(prompt.some((m) => m.content === "Question 0")).toBe(false);
  });

  it("does not let a huge tool result push the prompt over", () => {
    const ctx = bigCtx();
    const page = new ToolMessage({
      name: "read_page",
      tool_call_id: "c1",
      content: "x".repeat(100_000),
    });
    const { prompt } = modelPrompt(ctx, toolsFor("graph"), [
      ...systemMessages(ctx),
      new HumanMessage("Read that page"),
      new AIMessage({ content: "", tool_calls: [{ name: "read_page", args: {}, id: "c1" }] }),
      page,
    ]);
    expect(prompt.reduce((sum, m) => sum + m.content.length, 0)).toBeLessThanOrEqual(
      PROMPT_BUDGET_CHARS,
    );
  });

  it("says when the list is not the whole catalog, and how to reach the rest", () => {
    const { instructions } = promptSections(bigCtx(), {}, true);
    expect(instructions).toMatch(/the soonest \d+ of \d+, and search_events reaches the rest/);
    const small = promptSections(fixtureCtx(), {}, true).instructions;
    expect(small).toContain("this is the complete live set");
  });

  it("no longer puts event text from strangers in front of the model on every turn", () => {
    const ctx = fixtureCtx({
      events: benchCatalog(15, FIXTURE_NOW).map((e, i) =>
        i === 0 ? { ...e, description: "CANARY in a listing description" } : e,
      ),
    });
    const { prompt } = modelPrompt(ctx, toolsFor("graph"), [
      ...systemMessages(ctx),
      new HumanMessage("Hi"),
    ]);
    expect(JSON.stringify(prompt)).not.toContain("CANARY");
  });
});

describe("what the model may cite", () => {
  it("includes every id it was shown, and an event a tool returned from past the first 120", () => {
    const ctx = bigCtx();
    const far = ctx.upcoming[300].e.id;
    const result = new ToolMessage({
      name: "search_events",
      tool_call_id: "c1",
      content: JSON.stringify({ count: 1, events: [{ id: far }] }),
    });
    const { evidence, prompt } = modelPrompt(ctx, toolsFor("graph"), [
      ...systemMessages(ctx),
      new HumanMessage("Anything in a few weeks?"),
      new AIMessage({ content: "", tool_calls: [{ name: "search_events", args: {}, id: "c1" }] }),
      result,
    ]);
    const ids = evidence.map((e) => e.id);
    expect(ids).toContain(far);
    expect(ids).toContain("tool-120");
    expect(ids).toContain(ctx.upcoming[0].e.id);
    expect(evidence.length).toBeLessThanOrEqual(200);
    expect(new Set(ids).size).toBe(ids.length);
    expect(prompt.at(-1)?.content).toContain("cited as tool-120");
  });
});

describe("the order of the prompt", () => {
  const now = new Date("2026-08-05T18:30:00-07:00");
  const later = new Date("2026-08-05T18:31:00-07:00");

  it("keeps everything before the clock byte-identical from one minute to the next", () => {
    const a = fixtureCtx();
    const first = promptSections({ ...a, now }, {}, true);
    const second = promptSections({ ...a, now: later }, {}, true);
    expect(second.instructions).toBe(first.instructions);
    expect(second.visitor).toBe(first.visitor);
    expect(second.clock).not.toBe(first.clock);
    expect(first.instructions).not.toMatch(/6:30/);
  });

  it("puts the clock after the instructions and before the conversation", () => {
    const ctx = fixtureCtx();
    const { prompt } = modelPrompt(ctx, toolsFor("graph"), [
      ...systemMessages(ctx),
      new HumanMessage("Quokka question"),
    ]);
    const at = (needle: string) => prompt.findIndex((m) => m.content.includes(needle));
    expect(at("Enabled tools")).toBe(0);
    expect(at("Identity, non-negotiable")).toBeLessThan(at("authoritative"));
    expect(at("authoritative")).toBeLessThan(at("Quokka question"));
  });

  it("leaves room for the gate's schema", () => {
    expect(GATE_SCHEMA_CHARS).toBeGreaterThan(0);
    expect(PROMPT_BUDGET_CHARS).toBeGreaterThan(20_000);
  });
});

describe("fitting the budget", () => {
  const m = (role: "system" | "user" | "assistant", size: number, tag = "") => ({
    role,
    content: `${tag}${"x".repeat(size)}`,
  });

  it("leaves a prompt that fits alone", () => {
    const prompt = [m("system", 10), m("user", 10)];
    expect(fitToBudget(prompt, 100)).toBe(prompt);
  });

  it("never drops a system message or the last message, even when nothing else fits", () => {
    const prompt = [m("system", 80), m("user", 50), m("assistant", 50), m("user", 50, "last")];
    const kept = fitToBudget(prompt, 100);
    expect(kept.map((k) => k.role)).toEqual(["system", "user"]);
    expect(kept[1].content.startsWith("last")).toBe(true);
  });
});
