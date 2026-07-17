/**
 * Timezone helpers shared by the server and the web client. City-local day
 * math must be identical on both sides — the dedupe key, date filters, and
 * digest grouping all compare these strings.
 *
 * Keep this file self-contained (no imports): it is compiled by two
 * TypeScript projects with different module resolutions.
 */

const dayFmtCache = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(tz: string): Intl.DateTimeFormat {
  let f = dayFmtCache.get(tz);
  if (!f) {
    // en-CA renders YYYY-MM-DD, which sorts and compares as a plain string.
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFmtCache.set(tz, f);
  }
  return f;
}

/** "2026-07-11" in the given timezone — string-comparable. */
export function dayInTz(iso: string | Date, tz: string): string {
  return dayFormatter(tz).format(typeof iso === "string" ? new Date(iso) : iso);
}
