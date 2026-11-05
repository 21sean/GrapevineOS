import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { buildDigest } from "../src/agent/context.js";
import { toolsFor } from "../src/agent/contracts.js";
import { modelPrompt } from "../src/agent/graph.js";
import { FIXTURE_EVENTS, fixtureCtx } from "../src/evals/fixtures.js";

/**
 * Ordinary questions got "I'm Grapevine, San Diego's events concierge" in place of an
 * answer once tool results went into the transcript, because a tool result sits there as
 * a user message and was the last thing the model read. The model's half of this runs in
 * the live gate, `server/scripts/llm-quality.ts`, since no unit test can see what it says.
 */
const ctx = () => fixtureCtx();

const toolRound = (id: string) => [
  new AIMessage({
    content: "",
    tool_calls: [{ id, name: "get_event", args: { id: "gaslamp-bottle-service" } }],
  }),
  new ToolMessage({ content: "{}", tool_call_id: id, name: "get_event" }),
];

const lastPrompt = (messages: Parameters<typeof modelPrompt>[2]) => {
  const { prompt } = modelPrompt(ctx(), toolsFor("graph"), messages);
  return prompt[prompt.length - 1];
};

describe("what the model reads last", () => {
  it("is the person's question after a tool result", () => {
    const last = lastPrompt([
      new SystemMessage("You are the concierge."),
      new HumanMessage("How much is the VIP Bottle Night?"),
      ...toolRound("a"),
    ]);
    expect(last.role).toBe("user");
    expect(last.content).toContain("How much is the VIP Bottle Night?");
  });

  it("is the latest question in a longer thread", () => {
    const last = lastPrompt([
      new HumanMessage("What's on tonight?"),
      new AIMessage("Shoreline Jazz."),
      new HumanMessage("And the VIP night?"),
      ...toolRound("a"),
    ]);
    expect(last.content).toContain("And the VIP night?");
    expect(last.content).not.toContain("What's on tonight?");
  });

  it("is not added when no tool has run, so the question is not there twice", () => {
    const messages = [new HumanMessage("What's on tonight?")];
    const { prompt } = modelPrompt(ctx(), toolsFor("graph"), messages);
    expect(prompt.filter((m) => m.content.includes("What's on tonight?"))).toHaveLength(1);
  });
});

describe("the event list in every prompt", () => {
  it("cuts a long venue field, and keeps a real one whole", () => {
    const target = FIXTURE_EVENTS[0];
    const long = "Fifth Avenue in the Gaslamp " + "x".repeat(200);
    const events = FIXTURE_EVENTS.map((e) => (e.id === target.id ? { ...e, venue: long } : e));
    const digest = buildDigest(fixtureCtx({ events }));
    expect(digest).toContain("Fifth Avenue in the Gaslamp");
    expect(digest).not.toContain("x".repeat(81));
    expect(buildDigest(ctx())).toContain(FIXTURE_EVENTS[1].venue);
  });
});
