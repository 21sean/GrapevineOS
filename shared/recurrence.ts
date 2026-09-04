/**
 * RFC 5545 recurrence handling — ONE implementation shared by the server and
 * the web client (each re-exports this module from its local `recurrence`
 * file, so the two runtimes can never disagree about when an event repeats).
 *
 * An event's `recurrence` column stores a normalized RRULE string with no
 * "RRULE:" prefix, e.g. "FREQ=WEEKLY;BYDAY=SA". NULL means a one-off. The
 * anchor (start/end) is the first occurrence and its duration; the rule
 * expands it forward.
 *
 * Expansion preserves the anchor's LOCAL wall-clock time in the given
 * timezone: occurrences step the local calendar date and re-resolve the
 * instant, so a weekly 6 pm market stays at 6 pm across DST transitions
 * (matching what calendar clients do with an exported RRULE). Per RFC 5545,
 * the anchor itself is always the first instance — even when its weekday
 * isn't in BYDAY — and invalid dates (Jan 31 + 1 month) are skipped, never
 * rolled into the next month.
 *
 * Keep this file self-contained (no imports): it is compiled by two
 * TypeScript projects with different module resolutions.
 */

const FREQS = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
// RFC 5545 BYDAY codes, in week order — used to keep BYDAY output stable.
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const DAY_MS = 86_400_000;
const MAX_STEPS = 3000; // safety cap on occurrence expansion

const DAY_INDEX: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Normalize a raw RRULE (however an LLM or client emits it) into the canonical
 * form we persist, or null if it is not a usable recurrence. Idempotent, so it
 * also serves as validation. Keys come out in a fixed order with FREQ first,
 * which keeps the value a stable series key for dedupe and satisfies the DB's
 * `recurrence ~ '^FREQ='` check.
 */
export function normalizeRRule(input: string | null | undefined): string | null {
  if (!input) return null;
  const body = String(input)
    .trim()
    .replace(/^RRULE:/i, "");
  if (!body) return null;

  const parts = new Map<string, string>();
  for (const chunk of body.split(";")) {
    const eq = chunk.indexOf("=");
    if (eq < 0) continue;
    const key = chunk.slice(0, eq).trim().toUpperCase();
    const value = chunk
      .slice(eq + 1)
      .trim()
      .toUpperCase();
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
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedRRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byday: number[]; // JS weekday, 0=Sun … 6=Sat
  bymonthday: number[];
  count?: number;
  until?: number; // epoch ms, inclusive upper bound
}

// Parsing is memoized by rule string: the same handful of RRULEs is asked for
// on every clock tick, filter pass, and card render, so each distinct rule is
// parsed exactly once per session.
const ruleCache = new Map<string, ParsedRRule | null>();

export function parseRRule(input?: string | null): ParsedRRule | null {
  if (!input) return null;
  let rule = ruleCache.get(input);
  if (rule === undefined) {
    if (ruleCache.size >= 1000) ruleCache.clear(); // backstop; rules are few
    rule = parseRRuleFresh(input);
    ruleCache.set(input, rule);
  }
  return rule;
}

function parseRRuleFresh(input: string): ParsedRRule | null {
  const parts = new Map<string, string>();
  for (const chunk of input.replace(/^RRULE:/i, "").split(";")) {
    const eq = chunk.indexOf("=");
    if (eq < 0) continue;
    parts.set(
      chunk.slice(0, eq).trim().toUpperCase(),
      chunk
        .slice(eq + 1)
        .trim()
        .toUpperCase(),
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

// ---------------------------------------------------------------------------
// Local wall-clock helpers. Occurrences are "same local time, later local
// date", so expansion works on (calendar date, wall time) pairs in the
// event's timezone and only converts back to an instant at the end.
// ---------------------------------------------------------------------------

interface WallParts {
  y: number;
  mo: number; // 1-12
  d: number;
  hh: number;
  mi: number;
  ss: number;
}

const wallFmtCache = new Map<string, Intl.DateTimeFormat>();

function wallFmt(tz: string): Intl.DateTimeFormat {
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
  return f;
}

function wallInTz(ms: number, tz?: string): WallParts {
  const dt = new Date(ms);
  if (!tz) {
    return {
      y: dt.getFullYear(),
      mo: dt.getMonth() + 1,
      d: dt.getDate(),
      hh: dt.getHours(),
      mi: dt.getMinutes(),
      ss: dt.getSeconds(),
    };
  }
  const parts = wallFmt(tz).formatToParts(dt);
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

/** The instant at which `tz` shows this local wall time. For the nonexistent
 * hour of a spring-forward gap the result lands one hour over — the same
 * shift every calendar client applies. */
function instantOf(w: WallParts, tz?: string): number {
  if (!tz) return new Date(w.y, w.mo - 1, w.d, w.hh, w.mi, w.ss).getTime();
  const wanted = Date.UTC(w.y, w.mo - 1, w.d, w.hh, w.mi, w.ss);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const back = wallInTz(guess, tz);
    const asUtc = Date.UTC(back.y, back.mo - 1, back.d, back.hh, back.mi, back.ss);
    if (asUtc === wanted) break;
    guess += wanted - asUtc;
  }
  return guess;
}

// A local calendar date as a plain day number (UTC days since epoch) — pure
// calendar arithmetic with no DST anywhere near it.
const dateIndex = (y: number, mo: number, d: number) => Date.UTC(y, mo - 1, d) / DAY_MS;
const fromIndex = (idx: number) => {
  const dt = new Date(idx * DAY_MS);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};
const weekdayOfIndex = (idx: number) => new Date(idx * DAY_MS).getUTCDay();
const daysInMonth = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/**
 * Occurrence start instants (ms) in chronological order, honoring COUNT and
 * UNTIL. The anchor is always the first instance (RFC 5545 — DTSTART belongs
 * to the set even when BYDAY/BYMONTHDAY wouldn't generate it, which is also
 * how exported calendars expand). Unbounded rules stop at MAX_STEPS; the
 * caller stops as soon as it finds the current-or-next occurrence, so that
 * cap is only a backstop.
 */
function* occurrenceStarts(
  anchorMs: number,
  rule: ParsedRRule,
  tz: string | undefined,
): Generator<number> {
  const aw = wallInTz(anchorMs, tz);
  const anchorIdx = dateIndex(aw.y, aw.mo, aw.d);
  const timeOf = (idx: number): number => {
    const { y, mo, d } = fromIndex(idx);
    return instantOf({ y, mo, d, hh: aw.hh, mi: aw.mi, ss: aw.ss }, tz);
  };

  let emitted = 0;
  let steps = 0;
  const done = () => (rule.count != null && emitted >= rule.count) || steps >= MAX_STEPS;

  // The anchor instant itself, exactly as stored.
  if (done()) return;
  if (rule.until != null && anchorMs > rule.until) return;
  yield anchorMs;
  emitted++;

  if (rule.freq === "DAILY") {
    for (let p = 1; !done(); p++) {
      steps++;
      const ms = timeOf(anchorIdx + p * rule.interval);
      if (rule.until != null && ms > rule.until) return;
      yield ms;
      emitted++;
    }
    return;
  }

  if (rule.freq === "WEEKLY") {
    const targets = rule.byday.length ? rule.byday : [weekdayOfIndex(anchorIdx)];
    // Offsets from Monday (RFC 5545 default WKST=MO), so an "every other
    // week" rule attributes each weekday to its own calendar week instead of
    // wrapping early days into the anchor's week.
    const offsets = [...new Set(targets.map((t) => (t + 6) % 7))].sort((a, b) => a - b);
    const weekStart = anchorIdx - ((weekdayOfIndex(anchorIdx) + 6) % 7);
    for (let w = 0; !done(); w++) {
      const base = weekStart + w * 7 * rule.interval;
      for (const off of offsets) {
        steps++;
        const idx = base + off;
        if (idx <= anchorIdx) continue; // anchor (and its week's past days) already covered
        const ms = timeOf(idx);
        if (rule.until != null && ms > rule.until) return;
        if (done()) return;
        yield ms;
        emitted++;
      }
    }
    return;
  }

  // MONTHLY / YEARLY. MONTHLY honors BYMONTHDAY (defaulting to the anchor's
  // day); months without that day are skipped per RFC 5545 — never rolled
  // into the next month.
  const monthStep = rule.freq === "YEARLY" ? 12 * rule.interval : rule.interval;
  const days = rule.freq === "MONTHLY" && rule.bymonthday.length ? rule.bymonthday : [aw.d];
  const anchorMonth = aw.y * 12 + (aw.mo - 1);
  for (let p = 0; !done(); p++) {
    const total = anchorMonth + p * monthStep;
    const y = Math.floor(total / 12);
    const mo = (total % 12) + 1;
    for (const d of days) {
      steps++;
      if (d > daysInMonth(y, mo)) continue; // e.g. Jan 31 + 1 month
      const idx = dateIndex(y, mo, d);
      if (idx <= anchorIdx) continue;
      const ms = timeOf(idx);
      if (rule.until != null && ms > rule.until) return;
      if (done()) return;
      yield ms;
      emitted++;
    }
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
  occ: { start: string; end: string };
  validFrom: number;
  validTo: number;
}
const occCache = new Map<string, OccWindow>();

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
  const key = `${e.start}|${e.end}|${e.recurrence ?? ""}|${tz ?? ""}`;
  const nowMs = now.getTime();
  const hit = occCache.get(key);
  if (hit && nowMs >= hit.validFrom && nowMs <= hit.validTo) return hit.occ;

  const rule = parseRRule(e.recurrence);
  const anchorMs = Date.parse(e.start);
  let win: OccWindow;
  if (!rule || Number.isNaN(anchorMs)) {
    win = { occ: { start: e.start, end: e.end }, validFrom: -Infinity, validTo: Infinity };
  } else {
    const duration = Math.max(0, Date.parse(e.end) - anchorMs);
    const at = (ms: number) => ({
      start: new Date(ms).toISOString(),
      end: new Date(ms + duration).toISOString(),
    });
    let last = anchorMs;
    let found: number | undefined;
    for (const ms of occurrenceStarts(anchorMs, rule, tz)) {
      last = ms;
      if (ms + duration >= nowMs) {
        found = ms;
        break;
      }
    }
    win =
      found !== undefined
        ? { occ: at(found), validFrom: nowMs, validTo: found + duration }
        : // series over — every later `now` lands on the final occurrence
          { occ: at(last), validFrom: nowMs, validTo: Infinity };
  }
  if (occCache.size >= 5000) occCache.clear();
  occCache.set(key, win);
  return win.occ;
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
