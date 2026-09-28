/**
 * Minimal iCalendar (RFC 5545) generation, enough for Apple Calendar,
 * Google, and Outlook to import a Grapevine event or subscribe to a
 * per-user feed.
 *
 * Why a feed for Apple: iCloud Calendar has no public write API; writing
 * directly needs CalDAV plus an app-specific password from the user. So the
 * Apple path is a .ics download per event, or subscribing to the personal
 * feed URL, where adds/removes sync on the calendar app's refresh cadence.
 *
 * Times are emitted as LOCAL wall clock with a TZID (plus a VTIMEZONE
 * definition), not as UTC instants. That matters for recurring events: an
 * RRULE's BYDAY resolves against DTSTART's timezone, so a Saturday-evening
 * event exported as its UTC instant (Sunday 02:30Z) would expand on the
 * wrong weekday. This mirrors what the Google path sends ({dateTime,
 * timeZone}).
 */
import { calendarEventBody } from "./calendar-body.js";
import type { CityEvent } from "./types.js";

/** RFC 5545 TEXT escaping. */
function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** ISO 8601 (any offset) → UTC basic format: 20260704T193000Z */
function utc(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Local time + VTIMEZONE
// ---------------------------------------------------------------------------

interface Wall {
  y: number;
  mo: number;
  d: number;
  hh: number;
  mi: number;
  ss: number;
}

const wallFmtCache = new Map<string, Intl.DateTimeFormat>();

function wallInTz(ms: number, tz: string): Wall {
  let f = wallFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    wallFmtCache.set(tz, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  const hh = get("hour");
  return {
    y: get("year"),
    mo: get("month"),
    d: get("day"),
    hh: hh === 24 ? 0 : hh,
    mi: get("minute"),
    ss: get("second"),
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** ISO 8601 (any offset) → local basic format in tz: 20260704T193000 */
function local(iso: string, tz: string): string {
  const w = wallInTz(Date.parse(iso), tz);
  return `${w.y}${pad(w.mo)}${pad(w.d)}T${pad(w.hh)}${pad(w.mi)}${pad(w.ss)}`;
}

/** Minutes east of UTC that `tz` observes at `ms`. */
function offsetAt(ms: number, tz: string): number {
  const w = wallInTz(ms, tz);
  return Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.hh, w.mi, w.ss) - ms) / 60_000);
}

/** "+HHMM"/"-HHMM" for TZOFFSETFROM/TO. */
function fmtOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const abs = Math.abs(min);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** First instant in (lo, hi] where the zone's offset differs from offset(lo). */
function findTransition(tz: string, lo: number, hi: number): number {
  const from = offsetAt(lo, tz);
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetAt(mid, tz) === from) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** One STANDARD/DAYLIGHT block, recurring yearly on "the nth <weekday> of <month>". */
function tzBlock(tz: string, transitionMs: number): string[] {
  const from = offsetAt(transitionMs - 61_000, tz);
  const to = offsetAt(transitionMs, tz);
  // RFC 5545: the onset is written as the local wall time in effect BEFORE
  // the change (TZOFFSETFROM).
  const onsetUtcish = new Date(transitionMs + from * 60_000);
  const y = onsetUtcish.getUTCFullYear();
  const mo = onsetUtcish.getUTCMonth() + 1;
  const d = onsetUtcish.getUTCDate();
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const nth = d + 7 > daysInMonth ? -1 : Math.ceil(d / 7);
  const wd = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][onsetUtcish.getUTCDay()];
  const kind = to > from ? "DAYLIGHT" : "STANDARD";
  return [
    `BEGIN:${kind}`,
    `DTSTART:${y}${pad(mo)}${pad(d)}T${pad(onsetUtcish.getUTCHours())}${pad(onsetUtcish.getUTCMinutes())}00`,
    `RRULE:FREQ=YEARLY;BYMONTH=${mo};BYDAY=${nth}${wd}`,
    `TZOFFSETFROM:${fmtOffset(from)}`,
    `TZOFFSETTO:${fmtOffset(to)}`,
    `END:${kind}`,
  ];
}

/**
 * A VTIMEZONE for `tz`, derived from the zone's actual behavior in `year`
 * (via Intl) and generalized with yearly rules: exact for zones with
 * nth-weekday DST rules (all US/EU zones), a close approximation elsewhere.
 */
function vtimezone(tz: string, year: number): string[] {
  const jan = Date.UTC(year, 0, 1);
  const jul = Date.UTC(year, 6, 1);
  const dec = Date.UTC(year, 11, 31);
  const offJan = offsetAt(jan, tz);
  const offJul = offsetAt(jul, tz);
  if (offJan === offJul) {
    // No DST: a single fixed STANDARD block.
    return [
      "BEGIN:VTIMEZONE",
      `TZID:${tz}`,
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      `TZOFFSETFROM:${fmtOffset(offJan)}`,
      `TZOFFSETTO:${fmtOffset(offJan)}`,
      "END:STANDARD",
      "END:VTIMEZONE",
    ];
  }
  return [
    "BEGIN:VTIMEZONE",
    `TZID:${tz}`,
    ...tzBlock(tz, findTransition(tz, jan, jul)),
    ...tzBlock(tz, findTransition(tz, jul, dec)),
    "END:VTIMEZONE",
  ];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Fold lines longer than 75 octets (RFC 5545 §3.1), counted in bytes. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let len = 0;
  for (const ch of line) {
    const bytes = Buffer.byteLength(ch);
    if (len + bytes > 74) {
      out.push(cur);
      cur = " " + ch;
      len = 1 + bytes;
    } else {
      cur += ch;
      len += bytes;
    }
  }
  out.push(cur);
  return out.join("\r\n");
}

function vevent(e: CityEvent, stamp: string, tz: string): string[] {
  const { description, location } = calendarEventBody(e);
  const lines = [
    "BEGIN:VEVENT",
    `UID:${e.id}@grapevine`,
    `DTSTAMP:${stamp}`,
    // Local wall clock + TZID so the client expands any RRULE against the
    // event's own timezone (see module docs).
    `DTSTART;TZID=${tz}:${local(e.start, tz)}`,
    `DTEND;TZID=${tz}:${local(e.end, tz)}`,
    // A recurring event ships DTSTART as its anchor occurrence plus the rule;
    // the calendar client expands every future occurrence itself.
    ...(e.recurrence ? [`RRULE:${e.recurrence}`] : []),
    `SUMMARY:${esc(e.title)}`,
    `DESCRIPTION:${esc(description)}`,
    `LOCATION:${esc(location)}`,
    `GEO:${e.lat};${e.lng}`,
    `CATEGORIES:${esc(e.category)}`,
  ];
  if (e.ticketUrl) lines.push(`URL:${e.ticketUrl}`);
  lines.push("END:VEVENT");
  return lines;
}

export function icsCalendar(events: CityEvent[], name: string, tz: string): string {
  const stamp = utc(new Date().toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Grapevine//Grapevine//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`,
    "X-PUBLISHED-TTL:PT30M",
    ...(events.length ? vtimezone(tz, new Date().getUTCFullYear()) : []),
    ...events.flatMap((e) => vevent(e, stamp, tz)),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
