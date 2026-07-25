import { tagAffinity } from "../../../shared/affinity"
import { haversineKm, pointInPolygons } from "./geo"
import {
  carouselEvents,
  isMuted,
  matchesSearch,
  scoreEvent,
  sortEvents,
  visibleEvents,
  type Muted,
} from "./score"
import { nextOccurrence } from "./recurrence"
import { isLive, lightPresetForTime, localDay, type LightPreset } from "./time"
import type { GrapevineState } from "./store"
import type { CityEvent } from "./types"

/**
 * Store-level derived data, memoized once for all subscribers.
 *
 * Each selector recomputes only when the state slices it reads change, and
 * when a recompute produces an equivalent result it returns the *previous
 * reference* — so the 30s clock tick, which almost never changes what's
 * actually visible, costs one cheap pass here and zero re-renders downstream.
 * Components subscribe with these directly: useGrapevine(selectVisible).
 */

type State = GrapevineState

function memoSelector<T>(
  deps: (s: State) => unknown[],
  compute: (s: State) => T,
  keepPrev?: (prev: T, next: T) => boolean,
): (s: State) => T {
  let lastDeps: unknown[] | undefined
  let value!: T
  return (s) => {
    const d = deps(s)
    if (lastDeps && d.every((x, i) => Object.is(x, lastDeps![i]))) return value
    const next = compute(s)
    value = lastDeps !== undefined && keepPrev?.(value, next) ? value : next
    lastDeps = d
    return value
  }
}

const sameList = (a: readonly CityEvent[], b: readonly CityEvent[]) =>
  a.length === b.length && a.every((e, i) => e === b[i])

const sameIdSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (a.size !== b.size) return false
  for (const id of b) if (!a.has(id)) return false
  return true
}

const selectHidden = memoSelector(
  (s) => [s.hiddenIds],
  (s) => new Set(s.hiddenIds),
)

/** Muted venues/sources as lowercase sets, ready for isMuted. */
const selectMuted = memoSelector(
  (s) => [s.mutedVenues, s.mutedSources],
  (s): Muted => ({
    venues: new Set(s.mutedVenues.map((v) => v.trim().toLowerCase())),
    sources: new Set(s.mutedSources.map((v) => v.trim().toLowerCase())),
  }),
)

/**
 * "Near me" membership test for the resolved zone, or undefined while the
 * filter is off / the isochrone is still loading (undefined filters nothing).
 * The zone key must match the current filter+origin, so a stale polygon from
 * a previous radius never masquerades as the new one.
 */
const selectNearTest = memoSelector(
  (s) => [s.filters.nearMinutes, s.nearZone, s.userPos, s.settings?.center],
  (s): ((e: CityEvent) => boolean) | undefined => {
    if (s.filters.nearMinutes === null || !s.nearZone) return undefined
    const origin = s.userPos ?? s.settings?.center
    if (!origin) return undefined
    if (s.nearZone.key !== nearZoneKey(s.filters.nearMinutes, origin)) return undefined
    const { polygons, circle } = s.nearZone
    if (polygons?.length) return (e) => pointInPolygons([e.lng, e.lat], polygons)
    if (circle) return (e) => haversineKm([e.lng, e.lat], circle.center) <= circle.km
    return undefined
  },
)

/** Cache identity for one (radius, origin) pair — shared with useNearZone. */
export function nearZoneKey(minutes: number, origin: [number, number]): string {
  const r = (n: number) => Math.round(n * 1000) / 1000
  return `${minutes}|${r(origin[0])},${r(origin[1])}`
}

const sameAffinity = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) => {
  if (a.size !== b.size) return false
  for (const [k, v] of b) if (a.get(k) !== v) return false
  return true
}

/**
 * The learned half of the feedback loop (shared/affinity.ts — the server's
 * weekly digest learns from the exact same math): reactions → per-tag weights
 * over the events' own vocabulary (not the fixed 26-topic list). Two "went —
 * great" jazz nights make every jazz event score higher from then on.
 */
export const selectTagAffinity = memoSelector(
  (s) => [s.events, s.reactions],
  (s) => {
    const byId = new Map(s.events.map((e) => [e.id, e]))
    return tagAffinity(byId, Object.entries(s.reactions)) as ReadonlyMap<string, number>
  },
  sameAffinity,
)

/** Filtered + relevance-ranked events: the map's markers, the list's base. */
export const selectVisible = memoSelector(
  (s) => [
    s.events,
    s.filters,
    s.interests,
    s.now,
    s.settings?.tz,
    s.hiddenIds,
    s.reactions,
    s.mutedVenues,
    s.mutedSources,
    s.nearZone,
    s.userPos,
  ],
  (s) =>
    visibleEvents(
      s.events,
      s.filters,
      s.interests,
      s.now,
      s.settings?.tz,
      selectHidden(s),
      { reactions: s.reactions, tagAffinity: selectTagAffinity(s) },
      selectMuted(s),
      selectNearTest(s),
    ),
  sameList,
)

/** Visible events narrowed by the search box. */
export const selectSearched = memoSelector(
  (s) => [selectVisible(s), s.searchQuery],
  (s) => {
    const base = selectVisible(s)
    const q = s.searchQuery.trim()
    return q ? base.filter((e) => matchesSearch(e, q)) : base
  },
  sameList,
)

/** The list as rendered: searched, sorted by the chosen key, pins on top. */
export const selectOrdered = memoSelector(
  (s) => [selectSearched(s), s.sortBy, s.pinnedIds, s.now, s.settings?.tz],
  (s) => {
    const sorted = sortEvents(selectSearched(s), s.sortBy, s.now, s.settings?.tz)
    if (sorted.length === 0 || s.pinnedIds.length === 0) return sorted
    const pinned = new Set(s.pinnedIds)
    return [
      ...sorted.filter((e) => pinned.has(e.id)),
      ...sorted.filter((e) => !pinned.has(e.id)),
    ]
  },
  sameList,
)

/** What the carousel tours: live first, else starting soon. */
export const selectTour = memoSelector(
  (s) => [selectVisible(s), s.now, s.settings?.tz],
  (s) => carouselEvents(selectVisible(s), s.now, s.settings?.tz),
  sameList,
)

/**
 * What the map draws: visible plus the agent's picks, which render even when
 * the user's filters would hide them — a recommendation with no pin is a
 * broken answer.
 */
export const selectRendered = memoSelector(
  (s) => [selectVisible(s), s.events, s.agentHighlight?.ids],
  (s) => {
    const visible = selectVisible(s)
    const ids = s.agentHighlight?.ids
    if (!ids?.length) return visible
    const shown = new Set(visible.map((e) => e.id))
    const extras = s.events.filter((e) => ids.includes(e.id) && !shown.has(e.id))
    return extras.length ? [...visible, ...extras] : visible
  },
  sameList,
)

export interface WeekDay {
  day: string // YYYY-MM-DD city-local
  events: CityEvent[]
}

/**
 * "Your week": the next 7 days, top picks per day by the personal score —
 * interests, reactions, and learned tag affinity included; the user's current
 * map filters deliberately NOT (the digest answers "what's worth it", not
 * "what's on screen"). Promoted junk and "not for me" events never make it.
 */
export const selectWeekPicks = memoSelector(
  (s) => [
    s.events,
    s.interests,
    s.reactions,
    s.hiddenIds,
    s.mutedVenues,
    s.mutedSources,
    s.now,
    s.settings?.tz,
  ],
  (s) => {
    const tz = s.settings?.tz
    const hidden = selectHidden(s)
    const muted = selectMuted(s)
    const taste = { reactions: s.reactions, tagAffinity: selectTagAffinity(s) }
    const horizon = s.now.getTime() + 7 * 86_400_000
    const byDay = new Map<string, [number, CityEvent][]>()
    for (const e of s.events) {
      if (hidden.has(e.id) || e.promoted || isMuted(e, muted)) continue
      if (s.reactions[e.id] === "not_for_me") continue
      const occ = nextOccurrence(e, s.now, tz)
      if (Date.parse(occ.end) < s.now.getTime()) continue
      if (Date.parse(occ.start) > horizon) continue
      const score = scoreEvent(e, s.interests, s.now, tz, taste)
      if (score === -Infinity) continue
      const day = localDay(occ.start, tz)
      const list = byDay.get(day) ?? []
      list.push([score, e])
      byDay.set(day, list)
    }
    const days: WeekDay[] = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, list]) => ({
        day,
        events: list
          .sort((a, b) => b[0] - a[0])
          .slice(0, 3)
          .map(([, e]) => e),
      }))
    return days
  },
)

/** Ids of events live right now, across all events (not just visible). */
export const selectLiveIds = memoSelector(
  (s) => [s.events, s.now, s.settings?.tz],
  (s) => new Set(s.events.filter((e) => isLive(e, s.now, s.settings?.tz)).map((e) => e.id)),
  sameIdSet,
)

export const selectLiveCount = (s: State): number => selectLiveIds(s).size

/** Basemap lighting for the wall clock in the city's timezone. */
export const selectLightPreset = (s: State): LightPreset =>
  lightPresetForTime(s.now, s.settings?.tz ?? "America/Los_Angeles")
