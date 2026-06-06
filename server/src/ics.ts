/**
 * Minimal iCalendar (RFC 5545) generation — enough for Apple Calendar,
 * Google, and Outlook to import a Grapevine event or subscribe to a
 * per-user feed.
 *
 * Why a feed for Apple: iCloud Calendar has no public write API — writing
 * directly needs CalDAV plus an app-specific password from the user. So the
 * Apple path is a .ics download per event, or subscribing to the personal
 * feed URL, where adds/removes sync on the calendar app's refresh cadence.
 */
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
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Fold lines longer than 75 octets (RFC 5545 §3.1) — counted in bytes. */
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

function vevent(e: CityEvent, stamp: string): string[] {
  const description = [e.description, e.ticketUrl ? `Tickets: ${e.ticketUrl}` : ""]
    .filter(Boolean)
    .join("\n\n");
  const lines = [
    "BEGIN:VEVENT",
    `UID:${e.id}@grapevine`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${utc(e.start)}`,
    `DTEND:${utc(e.end)}`,
    // A recurring event ships DTSTART as its anchor occurrence plus the rule;
    // the calendar client expands every future occurrence itself.
    ...(e.recurrence ? [`RRULE:${e.recurrence}`] : []),
    `SUMMARY:${esc(e.title)}`,
    `DESCRIPTION:${esc(description)}`,
    `LOCATION:${esc(e.address ? `${e.venue}, ${e.address}` : e.venue)}`,
    `GEO:${e.lat};${e.lng}`,
    `CATEGORIES:${esc(e.category)}`,
  ];
  if (e.ticketUrl) lines.push(`URL:${e.ticketUrl}`);
  lines.push("END:VEVENT");
  return lines;
}

export function icsCalendar(events: CityEvent[], name: string): string {
  const stamp = utc(new Date().toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Grapevine//Grapevine//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`,
    "X-PUBLISHED-TTL:PT30M",
    ...events.flatMap((e) => vevent(e, stamp)),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
