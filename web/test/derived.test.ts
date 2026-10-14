import { describe, expect, it } from "vitest"
import { selectRendered } from "@/lib/derived"
import { useGrapevine } from "@/lib/store"
import type { CityEvent } from "@/lib/types"

const now = new Date("2026-10-14T20:00:00Z")
const base: CityEvent = {
  id: "past",
  title: "Past concert",
  description: "",
  category: "music",
  tags: [],
  venue: "San Diego",
  lng: -117.16,
  lat: 32.72,
  start: "2026-10-13T18:00:00Z",
  end: "2026-10-13T20:00:00Z",
  price: "Free",
  free: true,
  source: "test",
  sourceKind: "manual",
  rating: 3,
  promoted: false,
  rarity: "common",
}

describe("map highlights", () => {
  it("does not restore an ended event when the agent highlights it", () => {
    const future = {
      ...base,
      id: "future",
      start: "2026-12-01T18:00:00Z",
      end: "2026-12-01T20:00:00Z",
    }
    const state = {
      ...useGrapevine.getState(),
      now,
      events: [base, future],
      filters: {
        ...useGrapevine.getState().filters,
        categories: ["sports" as const],
      },
      agentHighlight: { ids: ["past", "future"], fit: true, seq: 1 },
    }
    expect(selectRendered(state).map((e) => e.id)).toEqual(["future"])
  })
})
