import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import type { CityEvent, VenueDetails } from "@/lib/types"

/**
 * Venue detail is stable (hours, photos, accessibility), so this cache is
 * keyed by venue rather than by event: two gigs at the same bar share one
 * lookup. That matters more than usual here because the Places API is in
 * public preview with a 1,000-record monthly quota. The server caches too,
 * but not spending the round trip at all is better.
 */
const cache = new Map<string, VenueDetails | null>()
const inflight = new Map<string, Promise<VenueDetails | null>>()

export interface VenueState {
  data: VenueDetails | null
  loading: boolean
}

/** Mapbox Places detail for an event's venue, or null when there is none. */
export function useVenue(event: CityEvent | null | undefined): VenueState {
  const key = event?.venue.trim().toLowerCase() ?? null
  // Which key we've finished resolving. State is derived from the cache during
  // render, so the effect never has to set it synchronously.
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    if (!event || !key || cache.has(key)) return

    let alive = true
    // Dedupe concurrent opens of the same venue into one request.
    let req = inflight.get(key)
    if (!req) {
      req = api
        .venue(event.id)
        .then((r) => {
          cache.set(key, r.venue)
          return r.venue
        })
        .finally(() => inflight.delete(key))
      inflight.set(key, req)
    }

    req
      .then(() => alive && setDone(key))
      // No venue card is the right failure mode: the panel is useful without
      // it, and a transport failure isn't cached, so it retries on next open.
      .catch(() => alive && setDone(key))

    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!key) return { data: null, loading: false }
  if (cache.has(key)) return { data: cache.get(key)!, loading: false }
  return { data: null, loading: done !== key }
}
