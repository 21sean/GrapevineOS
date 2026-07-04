import { nextOccurrence } from "./recurrence"
import type { CityEvent } from "./types"

/**
 * All of these read the event's *effective* occurrence: for a one-off that is
 * just its start/end, but for a recurring event it's the current-or-next
 * occurrence (see nextOccurrence), so recurring events stay live/upcoming week
 * after week instead of retiring after their anchor date. `tz` is optional and
 * only sharpens multi-day BYDAY rules; single-day weekly rolls forward the same
 * in any zone.
 */

export function isLive(e: CityEvent, now: Date, tz?: string): boolean {
  const { start, end } = nextOccurrence(e, now, tz)
  return new Date(start) <= now && now <= new Date(end)
}

export function hasEnded(e: CityEvent, now: Date, tz?: string): boolean {
  return new Date(nextOccurrence(e, now, tz).end) < now
}

export function minutesUntilStart(e: CityEvent, now: Date, tz?: string): number {
  const { start } = nextOccurrence(e, now, tz)
  return Math.round((new Date(start).getTime() - now.getTime()) / 60000)
}

/** Mapbox Standard's four time-of-day lighting presets. */
export type LightPreset = "dawn" | "day" | "dusk" | "night"

/**
 * Pick the basemap lighting from the local hour in `tz`, so the map dawns,
 * brightens, and darkens in step with the city on screen (Pacific for San
 * Diego). h23 hour cycle keeps midnight at 0 rather than 24.
 */
export function lightPresetForTime(now: Date, tz: string): LightPreset {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now),
  )
  if (hour >= 5 && hour < 7) return "dawn"
  if (hour >= 7 && hour < 18) return "day"
  if (hour >= 18 && hour < 20) return "dusk"
  return "night"
}

function fmt(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(
    new Date(iso),
  )
}

export function fmtTime(iso: string, tz: string): string {
  return fmt(iso, tz, { hour: "numeric", minute: "2-digit" })
}

/** "2026-07-11" in the city's timezone — string-comparable. */
export function localDay(iso: string, tz?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    ...(tz && { timeZone: tz }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso))
}

/** Day-string arithmetic: "2026-07-11" + 1 → "2026-07-12" (noon dodges TZ backslide). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`)
  d.setDate(d.getDate() + n)
  const p = (x: number) => String(x).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * The Sat–Sun window nearest `today`, leaning forward: midweek it's the
 * upcoming weekend, on Saturday it starts today, on Sunday it's what's left.
 */
export function weekendRange(today: string): { from: string; to: string } {
  const dow = new Date(`${today}T12:00:00`).getDay() // 0 Sun … 6 Sat
  if (dow === 0) return { from: today, to: today }
  const toSat = 6 - dow
  return { from: addDays(today, toSat), to: addDays(today, toSat + 1) }
}

/** "2026-07-11" → "Jul 11" for date-window pills and chips. */
export function fmtDay(day: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
    new Date(`${day}T12:00:00`),
  )
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
  const occ = nextOccurrence(e, now, tz)
  const range = `${fmtTime(occ.start, tz)} – ${fmtTime(occ.end, tz)}`
  const day = dayLabel(occ.start, tz, now)
  return day === "Today" ? range : `${day} · ${fmtTime(occ.start, tz)}`
}

/** Short status for badges/cards. */
export function statusLabel(e: CityEvent, tz: string, now: Date): string {
  const occ = nextOccurrence(e, now, tz)
  if (new Date(occ.start) <= now && now <= new Date(occ.end)) return "Live now"
  if (new Date(occ.end) < now) return "Ended"
  const mins = Math.round((new Date(occ.start).getTime() - now.getTime()) / 60000)
  if (mins <= 90) return `Starts in ${mins} min`
  return `${dayLabel(occ.start, tz, now)} · ${fmtTime(occ.start, tz)}`
}
