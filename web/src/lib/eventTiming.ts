import { isLive, timeRange } from "./time"
import type { CityEvent } from "./types"

interface ClockState {
  now: Date
  settings: { tz?: string } | null
}

/** Store writes unrelated to time must not re-run recurrence/Intl per card. */
export function eventTimingSelectors(event: CityEvent) {
  let lastNow: Date | undefined
  let lastTz: string | undefined
  let value = { live: false, range: "" }
  const read = (state: ClockState) => {
    const tz = state.settings?.tz ?? "UTC"
    if (state.now !== lastNow || tz !== lastTz) {
      value = {
        live: isLive(event, state.now, tz),
        range: timeRange(event, tz, state.now),
      }
      lastNow = state.now
      lastTz = tz
    }
    return value
  }
  return {
    live: (state: ClockState) => read(state).live,
    range: (state: ClockState) => read(state).range,
  }
}
