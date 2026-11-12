// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
vi.mock("@/lib/api", () => ({ api: {} }))
vi.mock("@/lib/supabase", () => ({ supabase: null }))
vi.mock("@/components/chat/RichText", () => ({
  RichText: vi.fn(() => null),
  EVENT_LINK_RE: /\[([^\]]+)\]\(event:([^)\s]+)\)/g,
}))
import { Message } from "@/components/chat/Message"
import { RichText } from "@/components/chat/RichText"
import { emptyAssistant } from "@/lib/chatReducer"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it("keeps completed replies out of streaming renders while preserving updates", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.createElement("div")
  const root = createRoot(container)
  const completed = {
    ...emptyAssistant(),
    text: "Previous answer",
    streaming: false,
  }
  const setProposalState = vi.fn()
  const onRetry = vi.fn()
  const draw = (text: string) =>
    act(() =>
      root.render(
        createElement(
          "div",
          null,
          createElement(Message, {
            item: completed,
            itemIdx: 1,
            setProposalState,
            onRetry,
          }),
          createElement(Message, {
            item: { ...emptyAssistant(), text },
            itemIdx: 3,
            setProposalState,
            onRetry,
          })
        )
      )
    )
  try {
    draw("One")
    draw("One two")
    draw("One two three")
    const texts = vi.mocked(RichText).mock.calls.map(([props]) => props.text)
    expect(texts).toEqual([
      "Previous answer",
      "One",
      "One two",
      "One two three",
    ])
  } finally {
    act(() => root.unmount())
  }
})
