import { expect, it, vi } from "vitest"
vi.mock("@/lib/time", () => ({
  isLive: vi.fn(() => false),
  timeRange: vi.fn(() => "Evening"),
}))
import { eventTimingSelectors } from "@/lib/eventTiming"
import { isLive, timeRange } from "@/lib/time"
import type { CityEvent } from "@/lib/types"

it("reuses event timing across unrelated writes and refreshes for time or timezone", () => {
  const selectors = eventTimingSelectors({} as CityEvent)
  const state = { now: new Date(), settings: { tz: "UTC" } }
  selectors.live(state)
  selectors.range(state)
  selectors.range({ ...state })
  expect(timeRange).toHaveBeenCalledTimes(1)
  expect(isLive).toHaveBeenCalledTimes(1)
  selectors.range({ ...state, now: new Date(state.now.getTime() + 30_000) })
  selectors.range({ ...state, settings: { tz: "America/Los_Angeles" } })
  expect(timeRange).toHaveBeenCalledTimes(3)
})
