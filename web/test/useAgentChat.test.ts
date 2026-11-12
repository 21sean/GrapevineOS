// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentFrame } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  api: { agentChat: vi.fn(), chatThread: vi.fn() },
}))
vi.mock("@/lib/supabase", () => ({ supabase: null }))
import { api } from "@/lib/api"
import { useAgentChat } from "@/hooks/useAgentChat"

let root: Root
let container: HTMLDivElement
let chat: ReturnType<typeof useAgentChat>
let renders: number
let calls: {
  onFrame: (frame: AgentFrame) => void
  signal?: AbortSignal
  resolve: () => void
}[]
let frames: Map<number, FrameRequestCallback>
let nextFrame: number

function Probe() {
  const value = useAgentChat()
  useLayoutEffect(() => {
    chat = value
    renders++
  })
  return null
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
  calls = []
  vi.mocked(api.agentChat).mockImplementation(
    (_body, onFrame, signal) =>
      new Promise<void>((resolve) => calls.push({ onFrame, signal, resolve }))
  )
  renders = 0
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(createElement(Probe)))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function paint() {
  act(() => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id)
      callback(0)
    }
  })
}
const reply = () => chat.items.at(-1)

describe("chat stream scheduling", () => {
  it("paints a burst once without losing tokens or delaying completion", () => {
    act(() => chat.send("Plan tonight"))
    const before = renders
    for (let i = 0; i < 100; i++)
      act(() => calls[0].onFrame({ type: "delta", text: "x" }))
    expect(renders).toBe(before)
    expect(frames.size).toBe(1)
    paint()
    expect(renders).toBe(before + 1)
    expect(reply()).toMatchObject({ text: "x".repeat(100), streaming: true })
    act(() => {
      calls[0].onFrame({ type: "delta", text: "!" })
      calls[0].onFrame({ type: "done" })
    })
    expect(reply()).toMatchObject({
      text: "x".repeat(100) + "!",
      streaming: false,
    })
    expect(frames.size).toBe(0)
  })

  it("never restores buffered text after a guardrail replacement", () => {
    act(() => chat.send("A request"))
    act(() => {
      calls[0].onFrame({ type: "delta", text: "discard this" })
      calls[0].onFrame({ type: "replace", text: "Safe replacement" })
    })
    paint()
    expect(reply()).toMatchObject({ text: "Safe replacement" })
  })

  it("flushes text before proposals and stops immediately even if abort is ignored", () => {
    act(() => chat.send("A plan"))
    act(() => {
      calls[0].onFrame({ type: "delta", text: "Here is a plan" })
      calls[0].onFrame({
        type: "action",
        action: { kind: "proposeCalendar", eventIds: ["one"] },
      })
    })
    expect(reply()).toMatchObject({
      text: "Here is a plan",
      proposals: [{ eventIds: ["one"] }],
    })
    act(() => {
      calls[0].onFrame({ type: "delta", text: "." })
      chat.stop()
      calls[0].onFrame({ type: "delta", text: "late" })
    })
    paint()
    expect(calls[0].signal?.aborted).toBe(true)
    expect(reply()).toMatchObject({ text: "Here is a plan.", streaming: false })
  })

  it("keeps old turns out of the next send and reset", () => {
    act(() => chat.send("First"))
    act(() => calls[0].onFrame({ type: "delta", text: "First answer" }))
    act(() => chat.send("Second"))
    act(() => calls[0].onFrame({ type: "delta", text: "stale" }))
    paint()
    expect(chat.items[1]).toMatchObject({
      text: "First answer",
      streaming: false,
    })
    expect(reply()).toMatchObject({ text: "" })
    act(() => {
      calls[1].onFrame({ type: "delta", text: "pending" })
      chat.reset()
    })
    paint()
    expect(chat.items).toEqual([])
  })

  it("discards pending tokens when loading history and aborts on unmount", async () => {
    act(() => chat.send("First"))
    act(() => calls[0].onFrame({ type: "delta", text: "pending" }))
    vi.mocked(api.chatThread).mockResolvedValue({
      id: "history-id",
      messages: [],
    })
    await act(async () => chat.loadThread("history-id"))
    paint()
    expect(chat.items).toEqual([])
    act(() => chat.send("Second"))
    act(() => calls[1].onFrame({ type: "delta", text: "pending" }))
    act(() => root.unmount())
    expect(frames.size).toBe(0)
    expect(calls[1].signal?.aborted).toBe(true)
  })
})
