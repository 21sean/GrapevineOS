import type { CityEvent } from "./types"

export function isLive(e: CityEvent, now: Date): boolean {
  return new Date(e.start) <= now && now <= new Date(e.end)
}

export function hasEnded(e: CityEvent, now: Date): boolean {
  return new Date(e.end) < now
}

export function minutesUntilStart(e: CityEvent, now: Date): number {
  return Math.round((new Date(e.start).getTime() - now.getTime()) / 60000)
}

function fmt(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(
    new Date(iso),
  )
}

export function fmtTime(iso: string, tz: string): string {
  return fmt(iso, tz, { hour: "numeric", minute: "2-digit" })
}

function sameDay(a: Date, b: Date, tz: string): boolean {
  const key = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short" }).format(d)
  return key(a) === key(b)
}

export function dayLabel(iso: string, tz: string, now: Date): string {
  const d = new Date(iso)
  if (sameDay(d, now, tz)) return "Today"
  const tomorrow = new Date(now.getTime() + 86400000)
  if (sameDay(d, tomorrow, tz)) return "Tomorrow"
  return fmt(iso, tz, { weekday: "short", month: "short", day: "numeric" })
}

/** "6:00 – 8:00 PM" for today, "Fri Jul 3 · 6:00 PM" otherwise. */
export function timeRange(e: CityEvent, tz: string, now: Date): string {
  const range = `${fmtTime(e.start, tz)} – ${fmtTime(e.end, tz)}`
  const day = dayLabel(e.start, tz, now)
  return day === "Today" ? range : `${day} · ${fmtTime(e.start, tz)}`
}

/** Short status for badges/cards. */
export function statusLabel(e: CityEvent, tz: string, now: Date): string {
  if (isLive(e, now)) return "Live now"
  if (hasEnded(e, now)) return "Ended"
  const mins = minutesUntilStart(e, now)
  if (mins <= 90) return `Starts in ${mins} min`
  return `${dayLabel(e.start, tz, now)} · ${fmtTime(e.start, tz)}`
}
