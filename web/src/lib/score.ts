import {
  CATEGORY_META,
  FARMERS_MARKET_TAG,
  type CityEvent,
  type Filters,
  type Interests,
  type SortKey,
} from "./types"
import { hasEnded, isLive, minutesUntilStart } from "./time"
import { nextOccurrence } from "./recurrence"

function interestTerms(e: CityEvent): string[] {
  return [...e.tags.map((t) => t.toLowerCase()), e.category]
}

/** True for the weekly neighborhood farmers markets (tagged at ingest). */
export function isFarmersMarket(e: CityEvent): boolean {
  return e.tags.some((t) => t.toLowerCase() === FARMERS_MARKET_TAG)
}

/**
 * Personal relevance score. Buzz rating is the backbone; live events and
 * rare one-offs float up; promoted junk sinks; interests tilt the rest.
 */
export function scoreEvent(
  e: CityEvent,
  interests: Interests,
  now: Date,
  tz?: string,
): number {
  const terms = interestTerms(e)
  if (terms.some((t) => interests.avoids.includes(t))) return -Infinity

  let s = e.rating * 2
  if (e.promoted) s -= 4
  if (e.rarity === "rare") s += 1.5
  if (e.rarity === "notable") s += 0.5
  if (isLive(e, now, tz)) s += 2
  else {
    const mins = minutesUntilStart(e, now, tz)
    if (mins > 0 && mins <= 180) s += 1
  }
  const loved = terms.filter((t) => interests.loves.includes(t)).length
  s += Math.min(loved * 2, 4)
  if (e.free) s += 0.3
  return s
}

/** Badge count for collapsed filter disclosures, so active filters aren't invisible. */
export function activeFilterCount(f: Filters): number {
  return f.categories.length + (f.minRating > 0 ? 1 : 0)
}

export function matchesFilters(
  e: CityEvent,
  f: Filters,
  interests: Interests,
  now: Date,
  tz?: string,
): boolean {
  if (hasEnded(e, now, tz)) return false
  if (f.hidePromoted && e.promoted) return false
  if (f.liveOnly && !isLive(e, now, tz)) return false
  if (f.rareOnly && e.rarity !== "rare") return false
  if (f.farmers === "only" && !isFarmersMarket(e)) return false
  if (f.farmers === "hide" && isFarmersMarket(e)) return false
  if (f.minRating > 0 && e.rating < f.minRating) return false
  if (f.categories.length && !f.categories.includes(e.category)) return false
  if (interestTerms(e).some((t) => interests.avoids.includes(t))) return false
  return true
}

/** Case-insensitive search over title, venue, tags, description, and category. */
export function matchesSearch(e: CityEvent, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [
    e.title,
    e.venue,
    e.address ?? "",
    e.description,
    CATEGORY_META[e.category].label,
    ...e.tags,
  ].some((t) => t.toLowerCase().includes(q))
}

/**
 * Dollars for price sorting: free → 0, "$25–44" → 25, "From $39" → 39.
 * Null when the string carries no number ("Varies", "Donation") — those
 * events sink to the bottom under either price direction.
 */
export function priceValue(e: CityEvent): number | null {
  if (e.free || /\bfree\b/i.test(e.price)) return 0
  const nums = e.price.match(/\d[\d,]*(?:\.\d+)?/g)
  if (!nums) return null
  return Math.min(...nums.map((n) => parseFloat(n.replace(/,/g, ""))))
}

/**
 * Reorder an already score-ranked list by the chosen key. Sorts are stable,
 * so ties (and unpriced events) keep their relevance order.
 */
export function sortEvents(
  events: CityEvent[],
  sort: SortKey,
  now: Date,
  tz?: string,
): CityEvent[] {
  if (sort === "relevance") return events
  const sorted = [...events]
  if (sort === "date") {
    // next occurrence, not anchor start — recurring events sort by when
    // they actually happen next
    sorted.sort(
      (a, b) =>
        new Date(nextOccurrence(a, now, tz).start).getTime() -
        new Date(nextOccurrence(b, now, tz).start).getTime(),
    )
  } else if (sort === "alpha") {
    sorted.sort((a, b) => a.title.localeCompare(b.title))
  } else {
    const dir = sort === "price-asc" ? 1 : -1
    sorted.sort((a, b) => {
      const pa = priceValue(a)
      const pb = priceValue(b)
      if (pa === null || pb === null) {
        return pa === pb ? 0 : pa === null ? 1 : -1
      }
      return (pa - pb) * dir
    })
  }
  return sorted
}

export function visibleEvents(
  events: CityEvent[],
  f: Filters,
  interests: Interests,
  now: Date,
  tz?: string,
  hidden?: ReadonlySet<string>,
): CityEvent[] {
  return events
    .filter((e) => !hidden?.has(e.id) && matchesFilters(e, f, interests, now, tz))
    .sort((a, b) => scoreEvent(b, interests, now, tz) - scoreEvent(a, interests, now, tz))
}

/** Events the carousel should tour: live first, else starting soon — by score. */
export function carouselEvents(
  events: CityEvent[],
  f: Filters,
  interests: Interests,
  now: Date,
  tz?: string,
  hidden?: ReadonlySet<string>,
): CityEvent[] {
  const visible = visibleEvents(events, f, interests, now, tz, hidden)
  const live = visible.filter((e) => isLive(e, now, tz))
  if (live.length >= 2) return live.slice(0, 7)
  const soon = visible.filter(
    (e) => !isLive(e, now, tz) && minutesUntilStart(e, now, tz) <= 24 * 60,
  )
  return [...live, ...soon].slice(0, 7)
}
