import { describe, expect, it } from "vitest"
import { DEFAULT_FILTERS, normalizeFilters } from "@/lib/types"

describe("normalizeFilters", () => {
  it("returns the defaults for nothing", () => {
    expect(normalizeFilters(undefined)).toEqual(DEFAULT_FILTERS)
    expect(normalizeFilters({})).toEqual(DEFAULT_FILTERS)
  })

  it("upgrades the legacy farmersOnly boolean and drops bad values", () => {
    const f = normalizeFilters({
      farmersOnly: true,
      dateFrom: "not-a-day",
      nearMinutes: 999,
      minRating: 3,
    })
    expect(f.farmers).toBe("only")
    expect(f.dateFrom).toBeNull()
    expect(f.nearMinutes).toBe(60)
    expect(f.minRating).toBe(3)
  })

  it("keeps a well-formed date window and category lists", () => {
    const f = normalizeFilters({
      dateFrom: "2026-09-05",
      dateTo: "2026-09-07",
      categories: ["music"],
      hideCategories: ["sports"],
    })
    expect(f.dateFrom).toBe("2026-09-05")
    expect(f.dateTo).toBe("2026-09-07")
    expect(f.categories).toEqual(["music"])
    expect(f.hideCategories).toEqual(["sports"])
  })
})
