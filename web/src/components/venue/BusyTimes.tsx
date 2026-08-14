import { useMemo } from "react"
import { clockLabel } from "@/lib/hours"
import { cn } from "@/lib/utils"

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

/** Inclusive-start, exclusive-end local hour span the event covers. */
export interface HourSpan {
  from: number
  to: number
}

/**
 * How busy this venue usually is, hour by hour, on the day of the event —
 * Mapbox's `telemetry.activity_score` (0-100, from real device activity).
 *
 * The bars covering the event's own hours are lit in the same lantern-gold the
 * map uses for live events, which is the whole point of showing this: not
 * "here is a chart of a bar", but "here is what you are walking into at 8pm".
 */
export function BusyTimes({
  activity,
  day,
  span,
  className,
}: {
  activity: Record<string, number[]>
  /** 0 = Monday, matching shared/hours.ts. */
  day: number
  span?: HourSpan
  className?: string
}) {
  const view = useMemo(() => {
    const hours = activity[DAY_KEYS[day]]
    if (!hours || hours.length !== 24) return null

    const peak = Math.max(...hours)
    if (peak <= 0) return null // venue is in the dataset but has no signal today

    // Trim dead hours off both ends so the bars have room to breathe, but never
    // crop the event itself out of its own chart.
    let first = hours.findIndex((h) => h > 0)
    let last = 23 - [...hours].reverse().findIndex((h) => h > 0)
    if (span) {
      first = Math.min(first, span.from)
      last = Math.max(last, Math.max(span.from, span.to - 1))
    }
    first = Math.max(0, first - 1)
    last = Math.min(23, last + 1)

    const bars = []
    for (let h = first; h <= last; h++) {
      bars.push({
        hour: h,
        value: hours[h],
        lit: !!span && h >= span.from && h < Math.max(span.to, span.from + 1),
      })
    }

    // The headline: how the event's own hours compare with the day's peak.
    const during = bars.filter((b) => b.lit)
    const level = during.length
      ? during.reduce((sum, b) => sum + b.value, 0) / during.length / peak
      : null

    return { bars, peak, level }
  }, [activity, day, span])

  if (!view) return null

  const { bars, peak, level } = view
  const headline =
    level === null
      ? "Usually busiest later in the day"
      : level >= 0.75
        ? "Usually packed at this hour"
        : level >= 0.45
          ? "Usually busy at this hour"
          : level > 0.15
            ? "Usually steady at this hour"
            : "Usually quiet at this hour"

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Busy times
        </span>
        <span className={cn("text-xs", level !== null && level >= 0.45 ? "text-live" : "text-muted-foreground")}>
          {headline}
        </span>
      </div>

      <div
        className="flex h-16 items-end gap-[3px]"
        role="img"
        aria-label={`Typical busyness by hour. ${headline}.`}
      >
        {bars.map((b) => (
          <div
            key={b.hour}
            title={`${clockLabel(b.hour * 60)} · ${Math.round((b.value / peak) * 100)}% of peak`}
            style={{ height: `${Math.max(6, (b.value / peak) * 100)}%` }}
            className={cn(
              "flex-1 rounded-[2px] transition-colors",
              b.lit ? "bg-live" : "bg-muted-foreground/25",
            )}
          />
        ))}
      </div>

      <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{clockLabel(bars[0].hour * 60)}</span>
        <span>{clockLabel(bars[Math.floor(bars.length / 2)].hour * 60)}</span>
        <span>{clockLabel(bars[bars.length - 1].hour * 60)}</span>
      </div>
    </div>
  )
}
