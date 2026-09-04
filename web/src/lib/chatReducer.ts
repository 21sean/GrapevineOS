import type { AgentFrame, ChatUsage } from "@/lib/types"

/**
 * The transcript the chat panel renders, and the pure half of how a streamed
 * frame changes it. useAgentChat owns the React state and the frames that
 * reach outside the transcript (actions move the map, open cards, refetch);
 * everything that only touches the assistant item being streamed is here,
 * frames in, patch out, so it can be tested without React.
 */

export interface ToolRun {
  label: string
  done: boolean
  detail?: string
}

export type Proposal =
  | {
      kind: "calendar"
      eventIds: string[]
      note?: string
      state: "pending" | "saved" | "dismissed"
    }
  | {
      kind: "watch"
      query: string
      cadenceHours: number
      note?: string
      state: "pending" | "scheduled" | "dismissed"
    }
  | {
      kind: "interests"
      addLoves: string[]
      addAvoids: string[]
      removeLoves: string[]
      removeAvoids: string[]
      reason: string
      state: "pending" | "applied" | "dismissed"
    }

export interface Notice {
  code: string
  message: string
}

export interface RailVerdict {
  rail: string
  blocked: boolean
  score?: number
}

export type ChatItem =
  | { kind: "user"; text: string }
  | {
      kind: "assistant"
      text: string
      streaming: boolean
      status?: string
      tools: ToolRun[]
      proposals: Proposal[]
      notices: Notice[]
      /** ids the agent pinned on the map this turn (chip-row fallback) */
      highlights: string[]
      /** token/cost telemetry, when the provider reports it (Claude Code) */
      usage?: ChatUsage
      /** rail decisions the server reported this turn (the notice carries the sentence) */
      rails?: RailVerdict[]
      error?: string
    }

export type AssistantItem = Extract<ChatItem, { kind: "assistant" }>

/** A fresh assistant item, about to stream. */
export function emptyAssistant(): AssistantItem {
  return {
    kind: "assistant",
    text: "",
    streaming: true,
    tools: [],
    proposals: [],
    notices: [],
    highlights: [],
  }
}

/**
 * How one frame changes the assistant item being streamed. Returns the patch
 * to merge, or null for frames that are not the transcript's business
 * (actions), which the hook handles.
 */
export function reduceFrame(
  item: AssistantItem,
  frame: AgentFrame
): Partial<AssistantItem> | null {
  switch (frame.type) {
    case "status":
      return { status: frame.label }
    case "delta":
      return { text: item.text + frame.text, status: undefined }
    case "replace":
      // Guardrails swapped the partial reply for a canned one: drop whatever
      // streamed so far.
      return { text: frame.text, status: undefined }
    case "tool": {
      if (frame.state === "start") {
        return {
          tools: [...item.tools, { label: frame.label, done: false }],
          status: undefined,
        }
      }
      // Mark the most recent un-done run with this label finished.
      const tools = [...item.tools]
      for (let i = tools.length - 1; i >= 0; i--) {
        if (tools[i].label === frame.label && !tools[i].done) {
          tools[i] = { ...tools[i], done: true, detail: frame.detail }
          break
        }
      }
      return { tools }
    }
    case "notice":
      return {
        notices: [
          ...item.notices,
          { code: frame.code, message: frame.message },
        ],
      }
    case "guardrail":
      return {
        rails: [
          ...(item.rails ?? []),
          { rail: frame.rail, blocked: frame.blocked, score: frame.score },
        ],
      }
    case "usage":
      return { usage: frame.usage }
    case "error":
      return { error: frame.message, streaming: false, status: undefined }
    case "done":
      return { streaming: false, status: undefined }
    case "action":
      return null
  }
}
