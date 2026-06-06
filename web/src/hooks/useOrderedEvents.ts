import { useMemo } from "react"
import { visibleEvents } from "@/lib/score"
import { useGrapevine } from "@/lib/store"

/**
 * The filtered event list as both surfaces (desktop rail, mobile dock) show
 * it: pinned events float to the top, keeping buzz order among themselves.
 */
export function useOrderedEvents() {
  const events = useGrapevine((s) => s.events)
  const filters = useGrapevine((s) => s.filters)
  const interests = useGrapevine((s) => s.interests)
  const now = useGrapevine((s) => s.now)
  const pinnedIds = useGrapevine((s) => s.pinnedIds)
  const tz = useGrapevine((s) => s.settings?.tz)

  const visible = useMemo(
    () => visibleEvents(events, filters, interests, now, tz),
    [events, filters, interests, now, tz],
  )

  const ordered = useMemo(() => {
    if (pinnedIds.length === 0) return visible
    const pinned = new Set(pinnedIds)
    return [
      ...visible.filter((e) => pinned.has(e.id)),
      ...visible.filter((e) => !pinned.has(e.id)),
    ]
  }, [visible, pinnedIds])

  return { visible, ordered }
}
