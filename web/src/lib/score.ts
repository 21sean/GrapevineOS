import type { CityEvent, Filters, Interests } from "./types"
import { hasEnded, isLive, minutesUntilStart } from "./time"

function interestTerms(e: CityEvent): string[] {
  return [...e.tags.map((t) => t.toLowerCase()), e.category]
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
  if (f.minRating > 0 && e.rating < f.minRating) return false
  if (f.categories.length && !f.categories.includes(e.category)) return false
  if (interestTerms(e).some((t) => interests.avoids.includes(t))) return false
  return true
}

export function visibleEvents(
  events: CityEvent[],
  f: Filters,
  interests: Interests,
  now: Date,
  tz?: string,
): CityEvent[] {
  return events
    .filter((e) => matchesFilters(e, f, interests, now, tz))
    .sort((a, b) => scoreEvent(b, interests, now, tz) - scoreEvent(a, interests, now, tz))
}

/** Events the carousel should tour: live first, else starting soon — by score. */
export function carouselEvents(
  events: CityEvent[],
  f: Filters,
  interests: Interests,
  now: Date,
  tz?: string,
): CityEvent[] {
  const visible = visibleEvents(events, f, interests, now, tz)
  const live = visible.filter((e) => isLive(e, now, tz))
  if (live.length >= 2) return live.slice(0, 7)
  const soon = visible.filter(
    (e) => !isLive(e, now, tz) && minutesUntilStart(e, now, tz) <= 24 * 60,
  )
  return [...live, ...soon].slice(0, 7)
}
