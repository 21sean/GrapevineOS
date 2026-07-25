import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { nextOccurrence } from "@/lib/recurrence"
import { useGrapevine } from "@/lib/store"
import type { CityEvent, GcalEvent } from "@/lib/types"

export interface Conflicts {
  /** Other calendar-saved Grapevine events overlapping this occurrence. */
  saved: { event: CityEvent; start: string; end: string }[]
  /** Busy blocks from the connected Google Calendar (timed events only). */
  google: GcalEvent[]
}

// One Google fetch per (event, occurrence) for a few minutes — reopening the
// same detail sheet shouldn't re-bill the calendar API.
const GCAL_TTL_MS = 3 * 60_000
const gcalCache = new Map<string, { at: number; value: GcalEvent[] }>()

const overlaps = (aStart: string, aEnd: string, bStart: string, bEnd: string) =>
  Date.parse(aStart) < Date.parse(bEnd) && Date.parse(bStart) < Date.parse(aEnd)

/**
 * Schedule conflicts for the event being viewed: other events the user saved
 * to their calendar whose next occurrence overlaps this one, plus — when
 * Google Calendar is connected — anything already on their real calendar in
 * the same window (all-day entries excluded; they aren't busy blocks).
 * Grapevine saves synced to Google are reported once, as the saved event.
 */
export function useConflicts(
  event: CityEvent | null | undefined,
  enabled: boolean,
  now: Date,
  tz: string,
): Conflicts | null {
  const events = useGrapevine((s) => s.events)
  const calendar = useGrapevine((s) => s.calendar)
  const [google, setGoogle] = useState<GcalEvent[] | null>(null)

  const occ = event ? nextOccurrence(event, now, tz) : null
  // Key on the occurrence window, not `now` — the 30s clock tick must not
  // refetch Google while the same occurrence is on screen.
  const gcalKey = event && occ ? `${event.id}|${occ.start}` : null

  useEffect(() => {
    if (!enabled || !gcalKey || !occ || !calendar?.google) {
      setGoogle(null)
      return
    }
    const hit = gcalCache.get(gcalKey)
    if (hit && Date.now() - hit.at < GCAL_TTL_MS) {
      setGoogle(hit.value)
      return
    }
    let alive = true
    setGoogle(null)
    api
      .gcalEvents(occ.start, occ.end)
      .then((r) => {
        gcalCache.set(gcalKey, { at: Date.now(), value: r.events })
        if (alive) setGoogle(r.events)
      })
      .catch(() => {
        if (alive) setGoogle([]) // can't read the calendar — warn on saves only
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, gcalKey, calendar?.google])

  if (!event || !occ || !enabled) return null

  const savedIds = new Set(calendar?.synced ?? [])
  const saved = events
    .filter((e) => e.id !== event.id && savedIds.has(e.id))
    .map((e) => {
      const o = nextOccurrence(e, now, tz)
      return { event: e, start: o.start, end: o.end }
    })
    .filter((c) => overlaps(c.start, c.end, occ.start, occ.end))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))

  // Google copies of Grapevine saves carry grapevineEventId — those are
  // either this event itself or already counted in `saved` above.
  const googleBusy = (google ?? []).filter(
    (g) => !g.allDay && !g.grapevineEventId && overlaps(g.start, g.end, occ.start, occ.end),
  )

  if (!saved.length && !googleBusy.length) return null
  return { saved, google: googleBusy }
}
