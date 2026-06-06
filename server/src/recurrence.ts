/**
 * Minimal RFC 5545 recurrence handling for events.
 *
 * An event's `recurrence` column stores a normalized RRULE string with no
 * "RRULE:" prefix, e.g. "FREQ=WEEKLY;BYDAY=SA". NULL means a one-off. The
 * anchor (starts_at/ends_at) is the first/next occurrence and its duration;
 * the rule expands it forward. Calendar clients (Apple/Google) expand the
 * RRULE natively, and the web app rolls the anchor forward for display, so the
 * server only needs to normalize and pass the rule through.
 */

const FREQS = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
// RFC 5545 BYDAY codes, in week order — used to keep BYDAY output stable.
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/**
 * Normalize a raw RRULE (however an LLM or client emits it) into the canonical
 * form we persist, or null if it is not a usable recurrence. Idempotent, so it
 * also serves as validation. Keys come out in a fixed order with FREQ first,
 * which keeps the value a stable series key for dedupe and satisfies the DB's
 * `recurrence ~ '^FREQ='` check.
 */
export function normalizeRRule(input: string | null | undefined): string | null {
  if (!input) return null;
  const body = String(input).trim().replace(/^RRULE:/i, "");
  if (!body) return null;

  const parts = new Map<string, string>();
  for (const chunk of body.split(";")) {
    const eq = chunk.indexOf("=");
    if (eq < 0) continue;
    const key = chunk.slice(0, eq).trim().toUpperCase();
    const value = chunk.slice(eq + 1).trim().toUpperCase();
    if (key && value) parts.set(key, value);
  }

  const freq = parts.get("FREQ");
  if (!freq || !FREQS.has(freq)) return null;

  const out: string[] = [`FREQ=${freq}`];

  const interval = parseInt(parts.get("INTERVAL") ?? "", 10);
  if (Number.isFinite(interval) && interval > 1) out.push(`INTERVAL=${interval}`);

  const byday = [
    ...new Set(
      (parts.get("BYDAY") ?? "")
        .split(",")
        .map((d) => d.trim().replace(/^[+-]?\d+/, "")) // drop ordinal prefixes (e.g. 1MO)
        .filter((d) => DAYS.includes(d)),
    ),
  ].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
  if (byday.length) out.push(`BYDAY=${byday.join(",")}`);

  const byMonthDay = [
    ...new Set(
      (parts.get("BYMONTHDAY") ?? "")
        .split(",")
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 31),
    ),
  ].sort((a, b) => a - b);
  if (byMonthDay.length) out.push(`BYMONTHDAY=${byMonthDay.join(",")}`);

  const count = parseInt(parts.get("COUNT") ?? "", 10);
  if (Number.isFinite(count) && count > 0) out.push(`COUNT=${count}`);

  const until = parts.get("UNTIL");
  if (until && /^\d{8}(T\d{6}Z?)?$/.test(until)) out.push(`UNTIL=${until}`);

  return out.join(";");
}
