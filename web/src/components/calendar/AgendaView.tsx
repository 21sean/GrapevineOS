import { useMemo } from "react"
import { CalendarIcon, MapPinIcon } from "lucide-react"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { asEtiquette, ETIQUETTE_META, type GcalEvent } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  addDays,
  byStart,
  eventSpan,
  fmtTime12,
  hasEnded,
  onDay,
  sameDay,
  startOfDay,
} from "./date-utils"

export const AGENDA_DAYS = 30

/**
 * The agenda: the next 30 days from the anchor as a flat list, one tinted
 * card per event, days without events skipped.
 */
export function AgendaView({
  anchor,
  events,
  now,
  onPickEvent,
}: {
  anchor: Date
  events: GcalEvent[]
  now: Date
  onPickEvent: (e: GcalEvent) => void
}) {
  const days = useMemo(() => {
    const start = startOfDay(anchor)
    return Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(start, i))
      .map((day) => ({
        day,
        events: events.filter((e) => onDay(e, day)).sort(byStart),
      }))
      .filter((d) => d.events.length > 0)
  }, [anchor, events])

  if (days.length === 0) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarIcon />
          </EmptyMedia>
          <EmptyTitle>Nothing scheduled</EmptyTitle>
          <EmptyDescription>
            Your Google Calendar is clear for the next {AGENDA_DAYS} days. Save
            something from the map, or add an event with “New event”.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex flex-col gap-5 p-4">
      {days.map(({ day, events: dayEvents }) => (
        <section key={day.toISOString()} className="flex flex-col gap-2">
          <h3
            className={cn(
              "font-mono text-[11px] tracking-[0.14em] uppercase",
              sameDay(day, now) ? "text-live" : "text-muted-foreground"
            )}
          >
            {new Intl.DateTimeFormat("en-US", {
              day: "numeric",
              month: "short",
            })
              .format(day)
              .toUpperCase()}
            ,{" "}
            {new Intl.DateTimeFormat("en-US", { weekday: "long" })
              .format(day)
              .toUpperCase()}
            {sameDay(day, now) && " · TODAY"}
          </h3>
          {dayEvents.map((e) => (
            <AgendaCard key={e.id} event={e} now={now} onPick={onPickEvent} />
          ))}
        </section>
      ))}
    </div>
  )
}

function AgendaCard({
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
  const { from, to } = eventSpan(event)
  return (
    <button
      type="button"
      onClick={() => onPick(event)}
      className={cn(
        "flex w-full flex-col gap-1 rounded-lg border px-3.5 py-2.5 text-left transition-opacity hover:opacity-85",
        meta.chip,
        ended && "opacity-55 [&>*]:line-through"
      )}
    >
      <span className="flex items-center gap-2">
        <span className="truncate text-sm font-semibold">{event.title}</span>
        {event.grapevineEventId && (
          <span className="shrink-0 font-mono text-[10px] tracking-wide opacity-70">
            via Grapevine
          </span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-3 font-mono text-xs opacity-80">
        <span className="shrink-0">
          {event.allDay ? "All day" : `${fmtTime12(from)} – ${fmtTime12(to)}`}
        </span>
        {event.location && (
          <span className="flex min-w-0 items-center gap-1">
            <MapPinIcon className="size-3 shrink-0" />
            <span className="truncate">{event.location}</span>
          </span>
        )}
      </span>
      {event.description && (
        <span className="line-clamp-2 text-xs opacity-75">
          {event.description}
        </span>
      )}
    </button>
  )
}
