import { useMemo, useState } from "react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { asEtiquette, ETIQUETTE_META, type GcalEvent } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  byStart,
  chipTime,
  hasEnded,
  monthGrid,
  onDay,
  parseGcal,
  sameDay,
} from "./date-utils"

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MAX_CHIPS = 3

/**
 * Classic 6×7 month grid. Events render as tinted chips (all-day first);
 * overflow collapses into a "+N more" popover. Clicking a chip edits it,
 * clicking anywhere else in a cell starts a new event on that day.
 */
export function MonthView({
  anchor,
  events,
  now,
  onPickEvent,
  onPickDay,
}: {
  anchor: Date
  events: GcalEvent[]
  now: Date
  onPickEvent: (e: GcalEvent) => void
  onPickDay: (day: Date) => void
}) {
  const cells = useMemo(() => monthGrid(anchor), [anchor])
  const byDay = useMemo(
    () => cells.map((day) => events.filter((e) => onDay(e, day)).sort(byStart)),
    [cells, events],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-7 border-b border-border">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="px-2 py-1.5 text-center font-mono text-[11px] text-muted-foreground"
          >
            {d}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-7">
        {cells.map((day, i) => (
          <DayCell
            key={i}
            day={day}
            inMonth={day.getMonth() === anchor.getMonth()}
            events={byDay[i]}
            now={now}
            onPickEvent={onPickEvent}
            onPickDay={onPickDay}
          />
        ))}
      </div>
    </div>
  )
}

function DayCell({
  day,
  inMonth,
  events,
  now,
  onPickEvent,
  onPickDay,
}: {
  day: Date
  inMonth: boolean
  events: GcalEvent[]
  now: Date
  onPickEvent: (e: GcalEvent) => void
  onPickDay: (day: Date) => void
}) {
  const [moreOpen, setMoreOpen] = useState(false)
  const today = sameDay(day, now)
  const shown = events.slice(0, MAX_CHIPS)
  const hidden = events.length - shown.length

  return (
    <div
      role="button"
      tabIndex={-1}
      onClick={() => onPickDay(day)}
      className={cn(
        "flex min-h-0 cursor-default flex-col gap-1 overflow-hidden border-r border-b border-border/60 p-1 transition-colors last:border-r-0 hover:bg-accent/40",
        !inMonth && "bg-background/40",
      )}
    >
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs",
          today
            ? "bg-primary font-semibold text-primary-foreground"
            : inMonth
              ? "text-foreground"
              : "text-muted-foreground/60",
        )}
      >
        {day.getDate()}
      </span>
      {shown.map((e) => (
        <EventChip key={e.id} event={e} now={now} onPick={onPickEvent} />
      ))}
      {hidden > 0 && (
        <Popover open={moreOpen} onOpenChange={setMoreOpen}>
          <PopoverTrigger
            onClick={(ev) => ev.stopPropagation()}
            className="rounded px-1.5 text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            +{hidden} more
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="flex w-64 flex-col gap-1 p-2"
            onClick={(ev) => ev.stopPropagation()}
          >
            <span className="px-1 pb-1 font-mono text-[11px] text-muted-foreground uppercase">
              {new Intl.DateTimeFormat("en-US", {
                weekday: "long",
                month: "short",
                day: "numeric",
              }).format(day)}
            </span>
            {events.map((e) => (
              <EventChip
                key={e.id}
                event={e}
                now={now}
                onPick={(ev) => {
                  setMoreOpen(false)
                  onPickEvent(ev)
                }}
              />
            ))}
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

function EventChip({
  event,
  now,
  onPick,
}: {
  event: GcalEvent
  now: Date
  onPick: (e: GcalEvent) => void
}) {
  const meta = ETIQUETTE_META[asEtiquette(event.color)]
  const ended = hasEnded(event, now)
  return (
    <button
      type="button"
      onClick={(ev) => {
        ev.stopPropagation()
        onPick(event)
      }}
      className={cn(
        "w-full shrink-0 truncate rounded border px-1.5 py-0.5 text-left text-xs transition-opacity hover:opacity-80",
        meta.chip,
        ended && "line-through opacity-55",
      )}
    >
      {!event.allDay && (
        <span className="opacity-75">{chipTime(parseGcal(event.start))} </span>
      )}
      <span className="font-medium">{event.title}</span>
    </button>
  )
}
