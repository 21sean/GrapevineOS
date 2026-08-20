import { dayInTz } from "../../../shared/time"
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
 * What the user asked the basemap lighting to be: follow the clock (default),
 * or pin it light/dark regardless of the hour.
 */
export type MapTheme = "auto" | "light" | "dark"

/** The preset each manual override pins the basemap to. */
export const MAP_THEME_PRESET = { light: "day", dark: "night" } as const

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
  if (tz) return dayInTz(iso, tz)
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso))
}

/** "2026-07-11" → local Date (noon dodges the UTC↔local backslide for date-only strings). */
export function parseDay(day: string): Date {
  return new Date(`${day}T12:00:00`)
}

/** Date → zero-padded local "2026-07-11". */
export function toDay(d: Date): string {
  const p = (x: number) => String(x).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Day-string arithmetic: "2026-07-11" + 1 → "2026-07-12". */
export function addDays(day: string, n: number): string {
  const d = parseDay(day)
  d.setDate(d.getDate() + n)
  return toDay(d)
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

/**
 * Coarse relative age for logs and history lists. "long" reads as prose
 * ("just now", "12m ago", "yesterday", "3d ago"), "short" as a bare stamp
 * ("now", "12m", "3h", "3d"); past a week both fall back to "Jun 12".
 */
export function relativeTime(
  iso: string,
  now: Date,
  style: "long" | "short" = "long",
): string {
  const long = style === "long"
  const mins = Math.round((now.getTime() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return long ? "just now" : "now"
  if (mins < 60) return long ? `${mins}m ago` : `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return long ? `${hours}h ago` : `${hours}h`
  const days = Math.round(hours / 24)
  if (long && days === 1) return "yesterday"
  if (days < 7) return long ? `${days}d ago` : `${days}d`
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(iso))
}

export function dayLabel(iso: string, tz: string, now: Date): string {
  // Compare local day STRINGS and step "tomorrow" with day arithmetic — a
  // literal +24h misses (or double-counts) the 23/25-hour days around DST.
  const eventDay = dayInTz(iso, tz)
  const today = dayInTz(now, tz)
  if (eventDay === today) return "Today"
  if (eventDay === addDays(today, 1)) return "Tomorrow"
  return fmt(iso, tz, { weekday: "short", month: "short", day: "numeric" })
}

/** "6:00 – 8:00 PM" for today, "Fri Jul 3 · 6:00 PM" otherwise. */
export function timeRange(e: CityEvent, tz: string, now: Date): string {
  const occ = nextOccurrence(e, now, tz)
  const range = `${fmtTime(occ.start, tz)} – ${fmtTime(occ.end, tz)}`
  const day = dayLabel(occ.start, tz, now)
  return day === "Today" ? range : `${day} · ${fmtTime(occ.start, tz)}`
}

/**
 * The calendar line Apple Maps hangs under a venue that hosts one of your
 * events: "Movie: The Odyssey at 8:35PM". Meridiem hugs the minutes the way
 * Apple prints it; events past today pick up their day first.
 */
export function bookedAnnotation(e: CityEvent, now: Date, tz: string): string {
  const occ = nextOccurrence(e, now, tz)
  const time = fmtTime(occ.start, tz).replace(/\s/g, "")
  const day = dayLabel(occ.start, tz, now)
  if (day === "Today") return `${e.title} at ${time}`
  if (day === "Tomorrow") return `${e.title} tomorrow at ${time}`
  return `${e.title} on ${day} at ${time}`
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
