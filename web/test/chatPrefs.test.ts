// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest"

/** What a browser that saved the Claude Code composer overrides comes back to. */
async function rehydrate() {
  vi.resetModules()
  const { useGrapevine } = await import("@/lib/store")
  await useGrapevine.persist.rehydrate()
  return useGrapevine.getState() as unknown as Record<string, unknown>
}

beforeEach(() => localStorage.clear())

it("drops the model and effort overrides and keeps the draft", async () => {
  localStorage.setItem(
    "grapevine-prefs",
    JSON.stringify({
      state: {
        chatModel: "claude-opus-5",
        chatEffort: "high",
        chatDraft: "half a line",
      },
      version: 6,
    })
  )
  const state = await rehydrate()
  expect(state.chatDraft).toBe("half a line")
  expect(state).not.toHaveProperty("chatModel")
  expect(state).not.toHaveProperty("chatEffort")
})

it("still carries an older draft over from its own key", async () => {
  localStorage.setItem(
    "grapevine-prefs",
    JSON.stringify({ state: {}, version: 5 })
  )
  localStorage.setItem(
    "grapevine.chatPrefs.v1",
    JSON.stringify({ model: "claude-opus-5", effort: "high", draft: "older" })
  )
  const state = await rehydrate()
  expect(state.chatDraft).toBe("older")
  expect(state).not.toHaveProperty("chatModel")
  expect(state).not.toHaveProperty("chatEffort")
  expect(localStorage.getItem("grapevine.chatPrefs.v1")).toBeNull()
})
