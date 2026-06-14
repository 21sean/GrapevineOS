import { useMemo } from "react"
import { matchesSearch, sortEvents, visibleEvents } from "@/lib/score"
import { useGrapevine } from "@/lib/store"

/**
 * The event list as both surfaces (desktop rail, mobile dock) show it:
 * buzz-filtered, narrowed by the search box, ordered by the chosen sort key
 * (relevance by default), with pinned events floating to the top and keeping
 * that order among themselves.
 */
export function useOrderedEvents() {
  const events = useGrapevine((s) => s.events)
  const filters = useGrapevine((s) => s.filters)
  const interests = useGrapevine((s) => s.interests)
  const now = useGrapevine((s) => s.now)
  const pinnedIds = useGrapevine((s) => s.pinnedIds)
  const hiddenIds = useGrapevine((s) => s.hiddenIds)
  const searchQuery = useGrapevine((s) => s.searchQuery)
  const sortBy = useGrapevine((s) => s.sortBy)
  const tz = useGrapevine((s) => s.settings?.tz)

  const visible = useMemo(() => {
    const base = visibleEvents(events, filters, interests, now, tz, new Set(hiddenIds))
    const q = searchQuery.trim()
    return q ? base.filter((e) => matchesSearch(e, q)) : base
  }, [events, filters, interests, now, tz, hiddenIds, searchQuery])

  const ordered = useMemo(() => {
    const sorted = sortEvents(visible, sortBy, now, tz)
    if (pinnedIds.length === 0) return sorted
    const pinned = new Set(pinnedIds)
    return [
      ...sorted.filter((e) => pinned.has(e.id)),
      ...sorted.filter((e) => !pinned.has(e.id)),
    ]
  }, [visible, sortBy, now, tz, pinnedIds])

  return { visible, ordered }
}
