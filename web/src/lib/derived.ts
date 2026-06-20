import { carouselEvents, matchesSearch, sortEvents, visibleEvents } from "./score"
import { isLive, lightPresetForTime, type LightPreset } from "./time"
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

/** Filtered + relevance-ranked events: the map's markers, the list's base. */
export const selectVisible = memoSelector(
  (s) => [s.events, s.filters, s.interests, s.now, s.settings?.tz, s.hiddenIds],
  (s) =>
    visibleEvents(s.events, s.filters, s.interests, s.now, s.settings?.tz, selectHidden(s)),
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
