import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import type { CityEvent } from "@/lib/types"

export interface Eta {
  minutes: number | null
  km: number | null
}

// ETAs are traffic-aware, so cached values go stale: entries older than the
// TTL are refetched (the server keeps its own 10-minute cache behind this).
const ETA_TTL_MS = 5 * 60_000
const cache = new Map<string, { at: number; value: Eta }>()

/** Traffic-aware drive time to an event, from the user (or city center). */
export function useEta(event: CityEvent | null | undefined): Eta | null {
  const userPos = useGrapevine((s) => s.userPos)
  // Keyed so a result for the previous event or position is never shown.
  const [fetched, setFetched] = useState<{ key: string; value: Eta } | null>(
    null
  )

  const key = event ? `${event.id}|${userPos?.join(",") ?? "center"}` : null

  useEffect(() => {
    if (!event || !key) return
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ETA_TTL_MS) return
    let alive = true
    api
      .eta([event.lng, event.lat], userPos ?? undefined)
      .then((r) => {
        cache.set(key, { at: Date.now(), value: r })
        if (alive) setFetched({ key, value: r })
      })
      .catch(() => {
        if (alive) setFetched({ key, value: { minutes: null, km: null } })
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!key) return null
  return cache.get(key)?.value ?? (fetched?.key === key ? fetched.value : null)
}
