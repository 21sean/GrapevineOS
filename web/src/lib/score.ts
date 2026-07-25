import {
  CATEGORY_META,
  FARMERS_MARKET_TAG,
  type CityEvent,
  type Filters,
  type Interests,
  type Reaction,
  type SortKey,
} from "./types"
import { hasEnded, isLive, localDay, minutesUntilStart } from "./time"
import { nextOccurrence } from "./recurrence"

export function interestTerms(e: CityEvent): string[] {
  return [...e.tags.map((t) => t.toLowerCase()), e.category]
}

/**
 * What the feedback loop has learned: the user's own reactions plus the
 * per-tag affinity derived from them (see selectTagAffinity in derived.ts).
 * Both are optional — a fresh browser scores exactly as before.
 */
export interface Taste {
  reactions?: Readonly<Record<string, Reaction>>
  tagAffinity?: ReadonlyMap<string, number>
}

/** How hard one reaction pulls the event itself. */
const REACTION_SELF_BOOST: Record<Reaction, number> = {
  going: 3, // committed — keep it in sight
  went: 0.5, // past tense; mostly teaches the tags
  not_for_me: -8, // sinks below everything with a pulse
}

/** True for the weekly neighborhood farmers markets (tagged at ingest). */
export function isFarmersMarket(e: CityEvent): boolean {
  return e.tags.some((t) => t.toLowerCase() === FARMERS_MARKET_TAG)
}

/**
 * Personal relevance score. Buzz rating is the backbone; live events and
 * rare one-offs float up; promoted junk sinks; interests tilt the rest.
 * Reactions layer on top: the event's own reaction moves it directly, and
 * learned tag affinity ("went — great" at two jazz shows) tilts lookalikes.
 */
export function scoreEvent(
  e: CityEvent,
  interests: Interests,
  now: Date,
  tz?: string,
  taste?: Taste,
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

  const reaction = taste?.reactions?.[e.id]
  if (reaction) s += REACTION_SELF_BOOST[reaction]
  if (taste?.tagAffinity) {
    // capped like loves, so a pile of reactions can't drown the buzz backbone
    const learned = terms.reduce((sum, t) => sum + (taste.tagAffinity!.get(t) ?? 0), 0)
    s += Math.max(-3, Math.min(3, learned))
  }
  return s
}

/**
 * Badge count for collapsed filter disclosures, so active filters aren't
 * invisible. Counts every non-default filter (see DEFAULT_FILTERS) —
 * hidePromoted defaults to true, so false is the active state there.
 */
export function activeFilterCount(f: Filters): number {
  return (
    f.categories.length +
    f.hideCategories.length +
    (f.minRating > 0 ? 1 : 0) +
    (f.freeOnly ? 1 : 0) +
    (f.liveOnly ? 1 : 0) +
    (f.rareOnly ? 1 : 0) +
    (f.farmers !== "any" ? 1 : 0) +
    (!f.hidePromoted ? 1 : 0) +
    (f.dateFrom || f.dateTo ? 1 : 0) +
    (f.nearMinutes !== null ? 1 : 0)
  )
}

/** Muted venues/sources, lowercased for matching (see selectMuted). */
export interface Muted {
  venues: ReadonlySet<string>
  sources: ReadonlySet<string>
}

export function isMuted(e: CityEvent, muted: Muted): boolean {
  return (
    muted.venues.has(e.venue.trim().toLowerCase()) ||
    muted.sources.has(e.source.trim().toLowerCase())
  )
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
  if (f.freeOnly && !e.free) return false
  if (f.farmers === "only" && !isFarmersMarket(e)) return false
  if (f.farmers === "hide" && isFarmersMarket(e)) return false
  if (f.minRating > 0 && e.rating < f.minRating) return false
  if (f.categories.length && !f.categories.includes(e.category)) return false
  if (f.hideCategories.length && f.hideCategories.includes(e.category)) return false
  if (f.dateFrom || f.dateTo) {
    // window over the next occurrence, city-local — same rule the agent's
    // search_events uses server-side
    const occ = nextOccurrence(e, now, tz)
    if (f.dateFrom && localDay(occ.end, tz) < f.dateFrom) return false
    if (f.dateTo && localDay(occ.start, tz) > f.dateTo) return false
  }
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
    // they actually happen next. Keyed once per event, not per comparison.
    const startMs = new Map(
      events.map((e) => [e, Date.parse(nextOccurrence(e, now, tz).start)] as const),
    )
    sorted.sort((a, b) => startMs.get(a)! - startMs.get(b)!)
  } else if (sort === "alpha") {
    sorted.sort((a, b) => a.title.localeCompare(b.title))
  } else {
    const dir = sort === "price-asc" ? 1 : -1
    const price = new Map(events.map((e) => [e, priceValue(e)] as const))
    sorted.sort((a, b) => {
      const pa = price.get(a) as number | null
      const pb = price.get(b) as number | null
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
  taste?: Taste,
  muted?: Muted,
  // "Near me" membership for the resolved isochrone; undefined = zone not
  // ready yet (or filter off), which deliberately filters nothing — better
  // a beat of "everything" than a flash of empty while the zone loads.
  near?: (e: CityEvent) => boolean,
): CityEvent[] {
  // Score each event once, then sort by the cached number — scoring inside
  // the comparator would re-run isLive/nextOccurrence O(n log n) times.
  const scored: [number, CityEvent][] = []
  for (const e of events) {
    if (hidden?.has(e.id)) continue
    if (muted && isMuted(e, muted)) continue
    if (near && !near(e)) continue
    if (!matchesFilters(e, f, interests, now, tz)) continue
    scored.push([scoreEvent(e, interests, now, tz, taste), e])
  }
  scored.sort((a, b) => b[0] - a[0])
  return scored.map(([, e]) => e)
}

/**
 * Events the carousel should tour: live first, else starting soon — by score.
 * Takes the already filtered+ranked list (see selectVisible in derived.ts).
 */
export function carouselEvents(
  visible: CityEvent[],
  now: Date,
  tz?: string,
): CityEvent[] {
  const live = visible.filter((e) => isLive(e, now, tz))
  if (live.length >= 2) return live.slice(0, 7)
  const soon = visible.filter(
    (e) => !isLive(e, now, tz) && minutesUntilStart(e, now, tz) <= 24 * 60,
  )
  return [...live, ...soon].slice(0, 7)
}
