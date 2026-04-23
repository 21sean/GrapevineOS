import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import type { CityEvent } from "@/lib/types"

export interface Eta {
  minutes: number | null
  km: number | null
}

const cache = new Map<string, Eta>()

/** Traffic-aware drive time to an event, from the user (or city center). */
export function useEta(event: CityEvent | null | undefined): Eta | null {
  const userPos = useGrapevine((s) => s.userPos)
  const [eta, setEta] = useState<Eta | null>(null)

  const key = event ? `${event.id}|${userPos?.join(",") ?? "center"}` : null

  useEffect(() => {
    if (!event || !key) {
      setEta(null)
      return
    }
    const hit = cache.get(key)
    if (hit) {
      setEta(hit)
      return
    }
    let alive = true
    setEta(null)
    api
      .eta([event.lng, event.lat], userPos ?? undefined)
      .then((r) => {
        cache.set(key, r)
        if (alive) setEta(r)
      })
      .catch(() => {
        if (alive) setEta({ minutes: null, km: null })
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return eta
}
