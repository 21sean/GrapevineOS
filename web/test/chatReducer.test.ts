import { describe, expect, it } from "vitest"
import {
  emptyAssistant,
  reduceFrame,
  type AssistantItem,
} from "@/lib/chatReducer"
import type { AgentFrame } from "@/lib/types"

/** Apply a frame sequence the way the hook does, patch by patch. */
function replay(frames: AgentFrame[]): AssistantItem {
  let item = emptyAssistant()
  for (const f of frames) item = { ...item, ...(reduceFrame(item, f) ?? {}) }
  return item
}

describe("the chat reducer", () => {
  it("accumulates deltas and clears the status once text streams", () => {
    const item = replay([
      { type: "status", label: "Thinking…" },
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
    ])
    expect(item.text).toBe("Hello")
    expect(item.status).toBeUndefined()
  })

  it("drops everything streamed when the persona rail replaces the answer", () => {
    const item = replay([
      { type: "delta", text: "I am Qw" },
      {
        type: "guardrail",
        rail: "output",
        blocked: true,
        pattern: "self-id-llm",
      },
      { type: "replace", text: "I'm Grapevine." },
    ])
    expect(item.text).toBe("I'm Grapevine.")
    expect(item.rails).toEqual([
      { rail: "output", blocked: true, score: undefined },
    ])
  })

  it("pairs a tool's done frame with its most recent open run", () => {
    const item = replay([
      {
        type: "tool",
        name: "search_events",
        label: "Searching events",
        state: "start",
      },
      {
        type: "tool",
        name: "search_events",
        label: "Searching events",
        state: "start",
      },
      {
        type: "tool",
        name: "search_events",
        label: "Searching events",
        state: "done",
        detail: "3 results",
      },
    ])
    expect(item.tools).toEqual([
      { label: "Searching events", done: false },
      { label: "Searching events", done: true, detail: "3 results" },
    ])
  })

  it("keeps notices, usage and the rail verdicts", () => {
    const item = replay([
      { type: "notice", code: "no-tools", message: "digest only" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
      { type: "guardrail", rail: "input", blocked: false, score: 0.1 },
    ])
    expect(item.notices).toEqual([{ code: "no-tools", message: "digest only" }])
    expect(item.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(item.rails?.[0]).toMatchObject({
      rail: "input",
      blocked: false,
      score: 0.1,
    })
  })

  it("ends streaming on done and on error", () => {
    expect(
      replay([
        { type: "delta", text: "x" },
        { type: "done", threadId: "t" },
      ]).streaming
    ).toBe(false)
    const failed = replay([{ type: "error", message: "boom" }])
    expect(failed.streaming).toBe(false)
    expect(failed.error).toBe("boom")
  })

  it("leaves actions to the hook", () => {
    expect(
      reduceFrame(emptyAssistant(), {
        type: "action",
        action: { kind: "highlight", eventIds: ["e"] },
      })
    ).toBeNull()
  })
})
