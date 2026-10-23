import type { AgentFrame } from "../src/types.js";
import { describe, expect, it, vi } from "vitest";
const gate = vi.hoisted(() => ({ generateTyped: vi.fn() }));
vi.mock("../src/llm/gateway.js", () => ({ ...gate, LlmGateError: Error }));
import { buildAgentGraph, turnInput } from "../src/agent/graph.js";
import type { AgentCtx } from "../src/agent/context.js";

const ctx: AgentCtx = {
  upcoming: [],
  byId: new Map(),
  now: new Date("2026-10-22T12:00:00Z"),
  settings: {
    city: "Testville",
    center: [0, 0],
    tz: "UTC",
    model: "test",
    ollamaUrl: "",
    chatProvider: "ollama",
    extractProvider: "ollama",
    guardMode: "off",
    guardThreshold: 0.8,
  },
};
function graph() {
  return buildAgentGraph({
    ctx,
    chat: {},
    baseUrl: "http://127.0.0.1:11434",
    model: "test",
    toolsOk: false,
    city: "Testville",
    userText: "",
    ephemeral: true,
    telemetry: { surface: "chat" },
  });
}

describe("validated chat boundary", () => {
  it("emits only the completed validated answer", async () => {
    gate.generateTyped.mockResolvedValueOnce({
      kind: "insufficient_evidence",
      answer: "No matching events found.",
      citations: [],
      tool_calls: [],
    });
    const stream = await graph().stream(turnInput(), {
      streamMode: "custom",
      configurable: { thread_id: "validated" },
    });
    const frames: AgentFrame[] = [];
    for await (const frame of stream) frames.push(frame);
    expect(frames.filter((f) => f.type === "delta")).toEqual([
      { type: "delta", text: "No matching events found." },
    ]);
    expect(gate.generateTyped.mock.calls.at(-1)?.[0].context.allowed_tools).toEqual([]);
  });
  it("emits no model text when the gate fails", async () => {
    gate.generateTyped.mockRejectedValueOnce(new Error("validation exhausted"));
    const frames: AgentFrame[] = [];
    await expect(async () => {
      const stream = await graph().stream(turnInput(), {
        streamMode: "custom",
        configurable: { thread_id: "failed" },
      });
      for await (const frame of stream) frames.push(frame);
    }).rejects.toThrow("validation exhausted");
    expect(frames).toEqual([]);
  });
});
