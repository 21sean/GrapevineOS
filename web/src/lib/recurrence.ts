import type { CityEvent } from "./types"

/**
 * Client-side recurrence for events whose `recurrence` column holds an RFC 5545
 * RRULE (e.g. "FREQ=WEEKLY;BYDAY=SA"). The server normalizes and stores the
 * rule; here we expand it so the map/list can show a recurring event's *next*
 * occurrence instead of a stale anchor. The anchor (start/end) is the first
 * occurrence and its duration; the rule steps it forward.
 *
 * Scope: DAILY and WEEKLY (incl. multi-day BYDAY, INTERVAL, COUNT, UNTIL) are
 * handled precisely — that covers the weekly-market / run-club feature. MONTHLY
 * and YEARLY get a simple single-track expansion. Occurrence instants advance
 * in whole days, so wall-clock time is exact except within a DST-change week;
 * calendar exports rely on the client's own RRULE expansion and are unaffected.
 */

export interface ParsedRRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"
  interval: number
  byday: number[] // JS weekday, 0=Sun … 6=Sat
  bymonthday: number[]
  count?: number
  until?: number // epoch ms, inclusive upper bound
}

const DAY_MS = 86_400_000
const MAX_STEPS = 3000 // safety cap on occurrence expansion

const DAY_INDEX: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
}
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

// Parsing is memoized by rule string: the same handful of RRULEs is asked for
// on every clock tick, filter pass, and card render, so each distinct rule is
// parsed exactly once per session.
const ruleCache = new Map<string, ParsedRRule | null>()

export function parseRRule(input?: string | null): ParsedRRule | null {
  if (!input) return null
  let rule = ruleCache.get(input)
  if (rule === undefined) {
    if (ruleCache.size >= 1000) ruleCache.clear() // backstop; rules are few
    rule = parseRRuleFresh(input)
    ruleCache.set(input, rule)
  }
  return rule
}

function parseRRuleFresh(input: string): ParsedRRule | null {
  const parts = new Map<string, string>()
  for (const chunk of input.replace(/^RRULE:/i, "").split(";")) {
    const eq = chunk.indexOf("=")
    if (eq < 0) continue
    parts.set(
      chunk.slice(0, eq).trim().toUpperCase(),
      chunk.slice(eq + 1).trim().toUpperCase(),
    )
  }

  const freq = parts.get("FREQ")
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    return null
  }

  const interval = Math.max(1, parseInt(parts.get("INTERVAL") ?? "1", 10) || 1)
  const byday = [
    ...new Set(
      (parts.get("BYDAY") ?? "")
        .split(",")
        .map((d) => d.trim().replace(/^[+-]?\d+/, ""))
        .filter((d) => d in DAY_INDEX)
        .map((d) => DAY_INDEX[d]),
    ),
  ].sort((a, b) => a - b)
  const bymonthday = [
    ...new Set(
      (parts.get("BYMONTHDAY") ?? "")
        .split(",")
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 31),
    ),
  ].sort((a, b) => a - b)

  const countRaw = parseInt(parts.get("COUNT") ?? "", 10)
  const count = Number.isFinite(countRaw) && countRaw > 0 ? countRaw : undefined
  const until = parseUntil(parts.get("UNTIL"))

  return { freq, interval, byday, bymonthday, count, until }
}

/** RRULE UNTIL is "YYYYMMDD" or "YYYYMMDDTHHMMSSZ" (UTC). */
function parseUntil(v?: string): number | undefined {
  if (!v) return undefined
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(v)
  if (!m) return undefined
  const [, y, mo, d, hh = "23", mi = "59", ss = "59"] = m
  return Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss)
}

/** Weekday (0=Sun) of an instant, in `tz` if given, else the runtime zone. */
function weekdayIn(ms: number, tz?: string): number {
  if (!tz) return new Date(ms).getDay()
  const label = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(
    new Date(ms),
  )
  const idx = WD_SHORT.indexOf(label)
  return idx >= 0 ? idx : new Date(ms).getDay()
}

/**
 * Occurrence start instants (ms) in chronological order, honoring COUNT and
 * UNTIL. Unbounded rules stop at MAX_STEPS; the caller stops as soon as it
 * finds the current-or-next occurrence, so that cap is only a backstop.
 */
function* occurrenceStarts(
  anchorMs: number,
  rule: ParsedRRule,
  tz: string | undefined,
): Generator<number> {
  if (rule.freq === "DAILY") {
    for (let p = 0; p < MAX_STEPS; p++) {
      if (rule.count != null && p >= rule.count) return
      const ms = anchorMs + p * rule.interval * DAY_MS
      if (rule.until != null && ms > rule.until) return
      yield ms
    }
    return
  }

  if (rule.freq === "WEEKLY") {
    const base = weekdayIn(anchorMs, tz)
    const targets = rule.byday.length ? rule.byday : [base]
    // Day-offsets from the anchor for each target weekday, within one week.
    const deltas = [...new Set(targets.map((w) => (((w - base) % 7) + 7) % 7))].sort(
      (a, b) => a - b,
    )
    const perWeek = deltas.length
    for (let p = 0; p < MAX_STEPS; p++) {
      if (rule.count != null && p >= rule.count) return
      const activeWeek = Math.floor(p / perWeek)
      const delta = deltas[p % perWeek] + 7 * rule.interval * activeWeek
      const ms = anchorMs + delta * DAY_MS
      if (rule.until != null && ms > rule.until) return
      yield ms
    }
    return
  }

  // MONTHLY / YEARLY: single-track step from the anchor, preserving day-of-month
  // and time-of-day. Best-effort (defensive — ingest emits DAILY/WEEKLY).
  const monthStep = rule.freq === "YEARLY" ? 12 * rule.interval : rule.interval
  const anchor = new Date(anchorMs)
  for (let p = 0; p < MAX_STEPS; p++) {
    if (rule.count != null && p >= rule.count) return
    const d = new Date(anchor)
    d.setMonth(d.getMonth() + p * monthStep)
    const ms = d.getTime()
    if (rule.until != null && ms > rule.until) return
    yield ms
  }
}

/**
 * nextOccurrence cache. An answer is the first occurrence whose end is still
 * ahead of `now`, so it stays correct for every instant from when it was
 * computed until that occurrence ends (forever for one-offs and finished
 * series). Within that window callers get the *same object* back, which lets
 * selector-based subscribers bail out by reference instead of re-rendering.
 */
interface OccWindow {
  occ: { start: string; end: string }
  validFrom: number
  validTo: number
}
const occCache = new Map<string, OccWindow>()

/**
 * The occurrence a recurring event should present at `now`: the one that is
 * live if any, otherwise the next upcoming one. One-off events (no rule) return
 * their own start/end unchanged. A finished bounded series returns its last
 * occurrence, so hasEnded()/the map filter still retire it.
 */
export function nextOccurrence(
  e: Pick<CityEvent, "start" | "end" | "recurrence">,
  now: Date,
  tz?: string,
): { start: string; end: string } {
  const key = `${e.start}|${e.end}|${e.recurrence ?? ""}|${tz ?? ""}`
  const nowMs = now.getTime()
  const hit = occCache.get(key)
  if (hit && nowMs >= hit.validFrom && nowMs <= hit.validTo) return hit.occ

  const rule = parseRRule(e.recurrence)
  const anchorMs = Date.parse(e.start)
  let win: OccWindow
  if (!rule || Number.isNaN(anchorMs)) {
    win = { occ: { start: e.start, end: e.end }, validFrom: -Infinity, validTo: Infinity }
  } else {
    const duration = Math.max(0, Date.parse(e.end) - anchorMs)
    const at = (ms: number) => ({
      start: new Date(ms).toISOString(),
      end: new Date(ms + duration).toISOString(),
    })
    let last = anchorMs
    let found: number | undefined
    for (const ms of occurrenceStarts(anchorMs, rule, tz)) {
      last = ms
      if (ms + duration >= nowMs) {
        found = ms
        break
      }
    }
    win =
      found !== undefined
        ? { occ: at(found), validFrom: nowMs, validTo: found + duration }
        : // series over — every later `now` lands on the final occurrence
          { occ: at(last), validFrom: nowMs, validTo: Infinity }
  }
  if (occCache.size >= 5000) occCache.clear()
  occCache.set(key, win)
  return win.occ
}

/** Short human label for a rule, e.g. "Weekly on Sat", "Every 2 weeks". */
export function recurrenceSummary(input?: string | null): string | null {
  const rule = parseRRule(input)
  if (!rule) return null
  const { freq, interval } = rule

  if (freq === "WEEKLY") {
    const days = rule.byday.map((d) => WD_SHORT[d]).join(", ")
    if (interval === 1) return days ? `Weekly on ${days}` : "Weekly"
    return days ? `Every ${interval} weeks on ${days}` : `Every ${interval} weeks`
  }
  if (freq === "DAILY") return interval === 1 ? "Daily" : `Every ${interval} days`
  if (freq === "MONTHLY") return interval === 1 ? "Monthly" : `Every ${interval} months`
  return interval === 1 ? "Yearly" : `Every ${interval} years`
}
