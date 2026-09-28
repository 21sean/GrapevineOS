/**
 * OSM-format opening hours, parsed. The Mapbox Places API hands back the raw
 * OSM string ("Mo-Th 11:00-22:00; Fr-Sa 11:00-02:00; Su off"), so both
 * runtimes share one parser: the server caches the string, and the web client
 * evaluates "Open now" against its own clock, so the answer can never go stale
 * inside the server's cache window.
 *
 * This covers the subset real venues actually use: weekday ranges and lists,
 * several spans a day, spans running past midnight, "off", and "24/7".
 * Anything more exotic (public holidays, month ranges, "sunset") parses to
 * null and callers fall back to showing the raw string verbatim.
 *
 * Keep this file self-contained (no imports): it is compiled by two
 * TypeScript projects with different module resolutions.
 */

/** One opening span. `to` may exceed 1440 when the span runs past midnight. */
export interface Interval {
  from: number; // minutes from local midnight
  to: number;
}

/** Seven entries, Monday first, matching OSM's weekday order. */
export type OpeningHours = Interval[][];

const DAY_TOKENS = ["mo", "tu", "we", "th", "fr", "sa", "su"];

// A leading weekday selector ("Mo-Fr", "Sa,Su", "Mo-We,Fr") then the rest of
// the rule. An empty selector means the rule applies to every day.
const RULE = /^((?:(?:mo|tu|we|th|fr|sa|su)(?:\s*-\s*(?:mo|tu|we|th|fr|sa|su))?\s*,?\s*)*)(.*)$/i;

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  // 24:00 is legal OSM for "midnight at the end of the day".
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/** "Mo-Fr" / "Sa,Su" / "" (every day) to day indices. */
function expandDays(selector: string): number[] {
  const text = selector.trim();
  if (!text) return [0, 1, 2, 3, 4, 5, 6];
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const chunk = part.trim();
    if (!chunk) continue;
    const range = chunk
      .split("-")
      .map((s) => DAY_TOKENS.indexOf(s.trim().slice(0, 2).toLowerCase()));
    if (range.some((i) => i < 0)) return [];
    if (range.length === 1) {
      out.add(range[0]);
    } else if (range.length === 2) {
      // Ranges wrap: "Fr-Mo" is Fri, Sat, Sun, Mon.
      for (let i = range[0]; ; i = (i + 1) % 7) {
        out.add(i);
        if (i === range[1]) break;
      }
    } else {
      return [];
    }
  }
  return [...out];
}

/** "09:00-17:00,18:00-22:00" to intervals; null on anything unsupported. */
function parseSpans(text: string): Interval[] | null {
  const spans: Interval[] = [];
  for (const part of text.split(",")) {
    const chunk = part.trim();
    if (!chunk) continue;
    const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(chunk);
    if (!m) return null;
    const from = toMinutes(m[1]);
    const to = toMinutes(m[2]);
    if (from === null || to === null) return null;
    // A span that ends at or before it starts runs past midnight ("20:00-02:00").
    spans.push({ from, to: to <= from ? to + 1440 : to });
  }
  return spans.length ? spans : null;
}

/** Parse an OSM `opening_hours` string. Null when the syntax is out of scope. */
export function parseOpeningHours(spec: string): OpeningHours | null {
  const text = (spec ?? "").trim();
  if (!text) return null;

  const week: OpeningHours = [[], [], [], [], [], [], []];
  if (/^24\s*\/\s*7$/.test(text)) {
    for (const day of week) day.push({ from: 0, to: 1440 });
    return week;
  }

  let parsedAnything = false;
  for (const raw of text.split(";")) {
    const rule = raw.trim();
    if (!rule) continue;
    const m = RULE.exec(rule);
    if (!m) return null;
    const days = expandDays(m[1]);
    if (!days.length) return null;
    const rest = m[2].trim();
    if (/^(off|closed)$/i.test(rest)) {
      for (const d of days) week[d] = [];
      parsedAnything = true;
      continue;
    }
    const spans = parseSpans(rest);
    if (!spans) return null;
    for (const d of days) week[d].push(...spans);
    parsedAnything = true;
  }
  return parsedAnything ? week : null;
}

/** "7:30 PM" / "9 AM": minutes from midnight to a compact wall-clock label. */
export function clockLabel(mins: number): string {
  const h24 = Math.floor(mins / 60) % 24;
  const min = mins % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const suffix = h24 < 12 ? "AM" : "PM";
  return min ? `${h12}:${String(min).padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
}

/** Local weekday (0 = Monday) and minutes since midnight, in `tz`. */
export function localWeekMinutes(tz: string, now: Date): { day: number; mins: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const day = DAY_TOKENS.indexOf(get("weekday").slice(0, 2).toLowerCase());
    const hour = Number(get("hour"));
    const minute = Number(get("minute"));
    if (day < 0 || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { day, mins: hour * 60 + minute };
  } catch {
    return null; // unknown timezone
  }
}

export interface OpenState {
  open: boolean;
  /** When it closes (if open) or next opens (if closed). Absent if unknown. */
  at?: string;
  /** True when the next opening is not today ("Opens Monday", not "Opens 9 AM"). */
  laterInWeek?: boolean;
}

/**
 * Is the venue open at `now`? Spans that run past midnight are matched against
 * the previous day's rule, so 1 AM on a Saturday still reads as Friday night's
 * "20:00-02:00" being open.
 */
export function openState(spec: string, tz: string, now: Date): OpenState | null {
  const week = parseOpeningHours(spec);
  if (!week) return null;
  const local = localWeekMinutes(tz, now);
  if (!local) return null;
  const { day, mins } = local;

  for (const iv of week[day]) {
    if (mins >= iv.from && mins < iv.to) return { open: true, at: clockLabel(iv.to % 1440) };
  }
  // Yesterday's late span may still be running.
  for (const iv of week[(day + 6) % 7]) {
    if (iv.to > 1440 && mins + 1440 >= iv.from && mins + 1440 < iv.to) {
      return { open: true, at: clockLabel(iv.to % 1440) };
    }
  }

  // Closed: report the next opening within the week ahead.
  for (let ahead = 0; ahead < 8; ahead++) {
    const upcoming = week[(day + ahead) % 7]
      .filter((iv) => ahead > 0 || iv.from > mins)
      .sort((a, b) => a.from - b.from);
    if (upcoming.length) {
      return { open: false, at: clockLabel(upcoming[0].from % 1440), laterInWeek: ahead > 0 };
    }
  }
  return { open: false };
}
