import { describe, expect, it } from "vitest"
import { scoreEvent, scoreParts } from "@/lib/score"
import type { CityEvent } from "@/lib/types"

const tz = "America/Los_Angeles"
const now = new Date("2026-07-10T19:00:00Z")

const base: CityEvent = {
  id: "e1",
  title: "Jazz at the Park",
  description: "",
  category: "music",
  tags: ["jazz", "outdoors"],
  venue: "Balboa Park",
  lng: -117.15,
  lat: 32.73,
  start: "2026-07-12T02:00:00Z",
  end: "2026-07-12T04:00:00Z",
  price: "Free",
  free: true,
  source: "sdtoday",
  sourceKind: "newsletter",
  rating: 4,
  promoted: false,
  rarity: "rare",
}

describe("scoreParts", () => {
  it("sums to exactly what the ranking uses", () => {
    const interests = { loves: ["jazz"], avoids: ["outdoors"] }
    const taste = {
      reactions: { e1: "going" as const },
      tagAffinity: new Map([["jazz", 5]]),
    }
    const parts = scoreParts(base, interests, now, tz, taste)
    const sum = parts.reduce((s, p) => s + p.points, 0)
    expect(scoreEvent(base, interests, now, tz, taste)).toBe(sum)
  })

  it("names what moved the event and leaves out what did not", () => {
    const parts = scoreParts(base, { loves: ["jazz"], avoids: [] }, now, tz, {
      reactions: {},
      tagAffinity: new Map([["outdoors", -9]]),
    })
    const byKey = Object.fromEntries(parts.map((p) => [p.key, p]))
    expect(byKey.buzz.points).toBe(8)
    expect(byKey.loves.label).toBe("You love jazz")
    expect(byKey.rarity.label).toBe("Rare find")
    expect(byKey.learned.points).toBe(-3)
    expect(byKey.promoted).toBeUndefined()
    expect(byKey.avoid).toBeUndefined()
    expect(byKey.reaction).toBeUndefined()
  })
})
