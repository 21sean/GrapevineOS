/**
 * Minimal RFC 5545 recurrence handling for events.
 *
 * An event's `recurrence` column stores a normalized RRULE string with no
 * "RRULE:" prefix, e.g. "FREQ=WEEKLY;BYDAY=SA". NULL means a one-off. The
 * anchor (starts_at/ends_at) is the first/next occurrence and its duration;
 * the rule expands it forward. Calendar clients (Apple/Google) expand the
 * RRULE natively, and the web app rolls the anchor forward for display.
 *
 * `normalizeRRule` is the write-side half. The expansion half below
 * (parseRRule/nextOccurrence/recurrenceSummary) mirrors
 * web/src/lib/recurrence.ts — keep the two in sync. The agent needs it so its
 * event digest and search show a recurring event's *next* occurrence rather
 * than a stale anchor.
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

// ---------------------------------------------------------------------------
// Expansion — mirrors web/src/lib/recurrence.ts; keep in sync.
// DAILY/WEEKLY are precise; MONTHLY/YEARLY get a simple single-track step.
// Occurrences advance in whole days, so wall-clock time is exact except within
// a DST-change week (same accepted limitation as the client).
// ---------------------------------------------------------------------------

export interface ParsedRRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byday: number[]; // JS weekday, 0=Sun … 6=Sat
  bymonthday: number[];
  count?: number;
  until?: number; // epoch ms, inclusive upper bound
}

const DAY_MS = 86_400_000;
const MAX_STEPS = 3000; // safety cap on occurrence expansion

const DAY_INDEX: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function parseRRule(input?: string | null): ParsedRRule | null {
  if (!input) return null;
  const parts = new Map<string, string>();
  for (const chunk of input.replace(/^RRULE:/i, "").split(";")) {
    const eq = chunk.indexOf("=");
    if (eq < 0) continue;
    parts.set(
      chunk.slice(0, eq).trim().toUpperCase(),
      chunk.slice(eq + 1).trim().toUpperCase(),
    );
  }

  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    return null;
  }

  const interval = Math.max(1, parseInt(parts.get("INTERVAL") ?? "1", 10) || 1);
  const byday = [
    ...new Set(
      (parts.get("BYDAY") ?? "")
        .split(",")
        .map((d) => d.trim().replace(/^[+-]?\d+/, ""))
        .filter((d) => d in DAY_INDEX)
        .map((d) => DAY_INDEX[d]),
    ),
  ].sort((a, b) => a - b);
  const bymonthday = [
    ...new Set(
      (parts.get("BYMONTHDAY") ?? "")
        .split(",")
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 31),
    ),
  ].sort((a, b) => a - b);

  const countRaw = parseInt(parts.get("COUNT") ?? "", 10);
  const count = Number.isFinite(countRaw) && countRaw > 0 ? countRaw : undefined;
  const until = parseUntil(parts.get("UNTIL"));

  return { freq, interval, byday, bymonthday, count, until };
}

/** RRULE UNTIL is "YYYYMMDD" or "YYYYMMDDTHHMMSSZ" (UTC). */
function parseUntil(v?: string): number | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(v);
  if (!m) return undefined;
  const [, y, mo, d, hh = "23", mi = "59", ss = "59"] = m;
  return Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
}

/** Weekday (0=Sun) of an instant, in `tz` if given, else the runtime zone. */
function weekdayIn(ms: number, tz?: string): number {
  if (!tz) return new Date(ms).getDay();
  const label = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(
    new Date(ms),
  );
  const idx = WD_SHORT.indexOf(label);
  return idx >= 0 ? idx : new Date(ms).getDay();
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
      if (rule.count != null && p >= rule.count) return;
      const ms = anchorMs + p * rule.interval * DAY_MS;
      if (rule.until != null && ms > rule.until) return;
      yield ms;
    }
    return;
  }

  if (rule.freq === "WEEKLY") {
    const base = weekdayIn(anchorMs, tz);
    const targets = rule.byday.length ? rule.byday : [base];
    // Day-offsets from the anchor for each target weekday, within one week.
    const deltas = [...new Set(targets.map((w) => (((w - base) % 7) + 7) % 7))].sort(
      (a, b) => a - b,
    );
    const perWeek = deltas.length;
    for (let p = 0; p < MAX_STEPS; p++) {
      if (rule.count != null && p >= rule.count) return;
      const activeWeek = Math.floor(p / perWeek);
      const delta = deltas[p % perWeek] + 7 * rule.interval * activeWeek;
      const ms = anchorMs + delta * DAY_MS;
      if (rule.until != null && ms > rule.until) return;
      yield ms;
    }
    return;
  }

  // MONTHLY / YEARLY: single-track step from the anchor, preserving day-of-month
  // and time-of-day. Best-effort (defensive — ingest emits DAILY/WEEKLY).
  const monthStep = rule.freq === "YEARLY" ? 12 * rule.interval : rule.interval;
  const anchor = new Date(anchorMs);
  for (let p = 0; p < MAX_STEPS; p++) {
    if (rule.count != null && p >= rule.count) return;
    const d = new Date(anchor);
    d.setMonth(d.getMonth() + p * monthStep);
    const ms = d.getTime();
    if (rule.until != null && ms > rule.until) return;
    yield ms;
  }
}

/**
 * The occurrence a recurring event should present at `now`: the one that is
 * live if any, otherwise the next upcoming one. One-off events (no rule) return
 * their own start/end unchanged. A finished bounded series returns its last
 * occurrence, so downstream "has ended" checks still retire it.
 */
export function nextOccurrence(
  e: { start: string; end: string; recurrence?: string | null },
  now: Date,
  tz?: string,
): { start: string; end: string } {
  const rule = parseRRule(e.recurrence);
  const anchorMs = Date.parse(e.start);
  if (!rule || Number.isNaN(anchorMs)) return { start: e.start, end: e.end };

  const duration = Math.max(0, Date.parse(e.end) - anchorMs);
  const nowMs = now.getTime();
  const at = (ms: number) => ({
    start: new Date(ms).toISOString(),
    end: new Date(ms + duration).toISOString(),
  });

  let last = anchorMs;
  for (const ms of occurrenceStarts(anchorMs, rule, tz)) {
    last = ms;
    if (ms + duration >= nowMs) return at(ms);
  }
  return at(last);
}

/** Short human label for a rule, e.g. "Weekly on Sat", "Every 2 weeks". */
export function recurrenceSummary(input?: string | null): string | null {
  const rule = parseRRule(input);
  if (!rule) return null;
  const { freq, interval } = rule;

  if (freq === "WEEKLY") {
    const days = rule.byday.map((d) => WD_SHORT[d]).join(", ");
    if (interval === 1) return days ? `Weekly on ${days}` : "Weekly";
    return days ? `Every ${interval} weeks on ${days}` : `Every ${interval} weeks`;
  }
  if (freq === "DAILY") return interval === 1 ? "Daily" : `Every ${interval} days`;
  if (freq === "MONTHLY") return interval === 1 ? "Monthly" : `Every ${interval} months`;
  return interval === 1 ? "Yearly" : `Every ${interval} years`;
}
