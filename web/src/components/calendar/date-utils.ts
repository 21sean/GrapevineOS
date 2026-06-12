import type { GcalEvent } from "@/lib/types"

/**
 * Local-time date math for the Google Calendar popup. Google hands back
 * offset-qualified ISO datetimes (or bare YYYY-MM-DD for all-day events);
 * rendering happens in the viewer's local zone, like every calendar app.
 */

/** "YYYY-MM-DD" (all-day) parses as local midnight, everything else as ISO. */
export function parseGcal(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return new Date(value)
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 42 cells (6 weeks) starting on the Sunday on/before the 1st of the month. */
export function monthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const start = addDays(first, -first.getDay())
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

/** The [inclusive, exclusive) instant span an event occupies. */
export function eventSpan(e: GcalEvent): { from: Date; to: Date } {
  // All-day ends are already exclusive dates (Google convention).
  return { from: parseGcal(e.start), to: parseGcal(e.end) }
}

/** Whether the event touches the given calendar day. */
export function onDay(e: GcalEvent, day: Date): boolean {
  const d0 = startOfDay(day).getTime()
  const d1 = d0 + 86_400_000
  const { from, to } = eventSpan(e)
  // Strict `to > d0` keeps a midnight-ending event off the next day.
  return from.getTime() < d1 && to.getTime() > d0
}

export function hasEnded(e: GcalEvent, now: Date): boolean {
  return eventSpan(e).to.getTime() < now.getTime()
}

/** "10am" / "2:30pm" — the compact prefix on month-view chips. */
export function chipTime(d: Date): string {
  const h = d.getHours() % 12 || 12
  const m = d.getMinutes()
  const ap = d.getHours() < 12 ? "am" : "pm"
  return m ? `${h}:${String(m).padStart(2, "0")}${ap}` : `${h}${ap}`
}

/** "2:30 PM" — agenda rows and the edit dialog's time selects. */
export function fmtTime12(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(d)
}

/** Stable ordering: all-day first, then by start, long events before short. */
export function byStart(a: GcalEvent, b: GcalEvent): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
  const d = parseGcal(a.start).getTime() - parseGcal(b.start).getTime()
  return d !== 0 ? d : parseGcal(b.end).getTime() - parseGcal(a.end).getTime()
}
