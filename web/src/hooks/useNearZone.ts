import { useEffect } from "react"
import { api } from "@/lib/api"
import { nearZoneKey } from "@/lib/derived"
import { useGrapevine } from "@/lib/store"

// Straight-line fallback when the isochrone API is unreachable: minutes at a
// city-driving effective speed. Deliberately conservative: better to show a
// touch too much than to hide something 12 minutes away.
const FALLBACK_KMH = 30

/**
 * Keeps store.nearZone in step with the "Near me" filter: whenever the radius
 * or the origin (user position, else city center) changes, fetch the
 * traffic-aware isochrone and publish it under its request key. selectVisible
 * ignores zones whose key doesn't match the current filters, so a slow
 * response can never filter against the wrong radius. Mounted once in App.
 */
export function useNearZone(): void {
  const nearMinutes = useGrapevine((s) => s.filters.nearMinutes)
  const userPos = useGrapevine((s) => s.userPos)
  const center = useGrapevine((s) => s.settings?.center)

  useEffect(() => {
    const setNearZone = useGrapevine.getState().setNearZone
    if (nearMinutes === null) {
      setNearZone(null)
      return
    }
    const origin = userPos ?? center
    if (!origin) return
    const key = nearZoneKey(nearMinutes, origin)
    if (useGrapevine.getState().nearZone?.key === key) return
    let alive = true
    api
      .isochrone(nearMinutes, origin)
      .then((r) => {
        if (!alive) return
        if (r.polygons.length) setNearZone({ key, polygons: r.polygons })
        else setNearZone(fallback(key, origin, nearMinutes))
      })
      .catch(() => {
        if (alive) setNearZone(fallback(key, origin, nearMinutes))
      })
    return () => {
      alive = false
    }
  }, [nearMinutes, userPos, center])
}

function fallback(key: string, center: [number, number], minutes: number) {
  return { key, circle: { center, km: (minutes / 60) * FALLBACK_KMH } }
}
