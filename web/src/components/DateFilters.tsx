import { lazy, Suspense, useState } from "react"
import type { DateRange } from "react-day-picker"
import { CalendarRangeIcon, XIcon } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { useGrapevine } from "@/lib/store"
import { addDays, fmtDay, localDay, weekendRange } from "@/lib/time"
import { cn } from "@/lib/utils"

// react-day-picker only loads when someone opens the picker — same chunk
// discipline as the lazy CalendarDialog in App.tsx.
const Calendar = lazy(() =>
  import("@/components/ui/calendar").then((m) => ({ default: m.Calendar })),
)

/** "2026-07-12"/"2026-07-15" → "Jul 12 – Jul 15" (open ends spelled out). */
export function rangeLabel(from: string | null, to: string | null): string {
  if (from && to) return from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`
  if (from) return `from ${fmtDay(from)}`
  return `through ${fmtDay(to!)}`
}

// noon dodges the UTC↔local backslide for date-only strings
const parseDay = (day: string): Date => new Date(`${day}T12:00:00`)
const toDay = (d: Date): string => {
  const p = (x: number) => String(x).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

interface QuickRange {
  key: string
  label: string
  from: string
  to: string
}

function quickRanges(today: string): QuickRange[] {
  const weekend = weekendRange(today)
  const tomorrow = addDays(today, 1)
  return [
    { key: "today", label: "Today", from: today, to: today },
    { key: "tomorrow", label: "Tomorrow", from: tomorrow, to: tomorrow },
    { key: "weekend", label: "Weekend", ...weekend },
  ]
}

/**
 * One-tap date windows over filters.dateFrom/dateTo — the same window Ask
 * Grapevine sets via set_filters, now reachable by hand: Today / Tomorrow /
 * Weekend chips plus a full range picker. An active chip taps off again; a
 * window that matches no chip (agent- or picker-set) shows on the picker chip
 * with a clear button beside it. Both the desktop rail and the phone dock
 * render this, passing their own chip styling.
 */
export function DateQuickChips({
  chipClass,
  activeClass,
}: {
  chipClass: string
  activeClass: string
}) {
  const dateFrom = useGrapevine((s) => s.filters.dateFrom)
  const dateTo = useGrapevine((s) => s.filters.dateTo)
  const setFilters = useGrapevine((s) => s.setFilters)
  // City-local today; localDay returns the same string all day, so this only
  // re-renders the chips when the date actually flips.
  const today = useGrapevine((s) => localDay(s.now.toISOString(), s.settings?.tz))
  const [open, setOpen] = useState(false)

  const ranges = quickRanges(today)
  const hasWindow = Boolean(dateFrom || dateTo)
  const custom =
    hasWindow && !ranges.some((r) => r.from === dateFrom && r.to === dateTo)
  const clear = () => setFilters({ dateFrom: null, dateTo: null })

  return (
    <>
      {ranges.map((r) => {
        const active = dateFrom === r.from && dateTo === r.to
        return (
          <button
            key={r.key}
            type="button"
            aria-pressed={active}
            onClick={() =>
              active ? clear() : setFilters({ dateFrom: r.from, dateTo: r.to })
            }
            className={cn(chipClass, active && activeClass)}
          >
            {r.label}
          </button>
        )
      })}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-pressed={custom}
            aria-label="Pick a date range"
            className={cn(chipClass, custom && activeClass)}
          >
            <CalendarRangeIcon className="size-3.5" />
            {custom ? rangeLabel(dateFrom, dateTo) : "Dates"}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          {open && (
            <Suspense
              fallback={
                <div className="flex h-72 w-64 items-center justify-center">
                  <Spinner className="size-5" />
                </div>
              }
            >
              <Calendar
                mode="range"
                numberOfMonths={1}
                defaultMonth={parseDay(dateFrom ?? today)}
                disabled={{ before: parseDay(today) }}
                selected={
                  hasWindow
                    ? {
                        from: dateFrom ? parseDay(dateFrom) : undefined,
                        to: dateTo ? parseDay(dateTo) : undefined,
                      }
                    : undefined
                }
                onSelect={(range: DateRange | undefined) =>
                  setFilters({
                    dateFrom: range?.from ? toDay(range.from) : null,
                    dateTo: range?.to ? toDay(range.to) : null,
                  })
                }
              />
            </Suspense>
          )}
        </PopoverContent>
      </Popover>

      {custom && (
        <button
          type="button"
          aria-label="Clear date filter"
          onClick={clear}
          className={cn(chipClass, "px-1.5")}
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </>
  )
}
