/**
 * RFC 5545 recurrence handling: ONE implementation shared by the server and
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
 * the anchor itself is always the first instance (even when its weekday
 * isn't in BYDAY), and invalid dates (Jan 31 + 1 month) are skipped, never
 * rolled into the next month.
 *
 * Keep this file self-contained (no imports): it is compiled by two
 * TypeScript projects with different module resolutions.
 */

const FREQS = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
// RFC 5545 BYDAY codes, in week order, used to keep BYDAY output stable.
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
// An optional signed ordinal, then the weekday: "MO", "1MO", "+2TU", "-1FR".
const BYDAY_TOKEN = new RegExp(`^([+-]?\\d{1,2})?(${DAYS.join("|")})$`);

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
  // Ordinal weekdays ("1MO", "-1FR") and BYSETPOS only mean something inside
  // a month or a year. RFC 5545 forbids ordinals under DAILY and WEEKLY, so
  // there they reduce to the bare weekday.
  const periodic = freq === "MONTHLY" || freq === "YEARLY";

  const out: string[] = [`FREQ=${freq}`];

  const interval = parseInt(parts.get("INTERVAL") ?? "", 10);
  if (Number.isFinite(interval) && interval > 1) out.push(`INTERVAL=${interval}`);

  const byMonth = intList(parts.get("BYMONTH"), 12, false);
  if (byMonth.length) out.push(`BYMONTH=${byMonth.join(",")}`);

  const byday = new Map<string, [number, number]>();
  for (const raw of (parts.get("BYDAY") ?? "").split(",")) {
    const m = BYDAY_TOKEN.exec(raw.trim());
    if (!m) continue;
    const n = periodic && m[1] ? parseInt(m[1], 10) : 0;
    if (Math.abs(n) > 53) continue;
    byday.set(`${n || ""}${m[2]}`, [DAY_INDEX[m[2]], n]);
  }
  const bydayOut = [...byday]
    .sort(([, a], [, b]) => a[0] - b[0] || a[1] - b[1])
    .map(([token]) => token);
  if (bydayOut.length) out.push(`BYDAY=${bydayOut.join(",")}`);

  const byMonthDay = intList(parts.get("BYMONTHDAY"), 31);
  if (byMonthDay.length) out.push(`BYMONTHDAY=${byMonthDay.join(",")}`);

  const bySetPos = periodic ? intList(parts.get("BYSETPOS"), 366) : [];
  if (bySetPos.length) out.push(`BYSETPOS=${bySetPos.join(",")}`);

  const count = parseInt(parts.get("COUNT") ?? "", 10);
  if (Number.isFinite(count) && count > 0) out.push(`COUNT=${count}`);

  const until = parts.get("UNTIL");
  if (until && /^\d{8}(T\d{6}Z?)?$/.test(until)) out.push(`UNTIL=${until}`);

  return out.join(";");
}

/** Comma-separated nonzero integers within +-max (1..max when unsigned), deduped and sorted. */
function intList(v: string | undefined, max: number, signed = true): number[] {
  return [
    ...new Set(
      (v ?? "")
        .split(",")
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isFinite(n) && n !== 0 && n <= max && n >= (signed ? -max : 1)),
    ),
  ].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedRRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byday: number[]; // JS weekday, 0=Sun … 6=Sat; every such day in the period
  /** Ordinal weekdays: n=1 is the first in the month (or year), n=-1 the last. */
  bynthday: { n: number; day: number }[];
  bymonthday: number[]; // negative counts back from the month's last day
  bymonth: number[]; // 1-12
  bysetpos: number[];
  count?: number;
  until?: RRuleUntil;
}

/**
 * UNTIL as written. It becomes an instant only once the event's timezone is
 * known: a date-only or floating value is local wall-clock time there.
 */
export interface RRuleUntil {
  y: number;
  mo: number; // 1-12
  d: number;
  /** Absent for a date-only UNTIL, which includes that whole local day. */
  time?: { hh: number; mi: number; ss: number };
  utc: boolean;
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

// Reads the canonical form, so what expands is exactly what gets persisted
// and exported to calendar clients.
function parseRRuleFresh(input: string): ParsedRRule | null {
  const canonical = normalizeRRule(input);
  if (!canonical) return null;
  const parts = new Map(canonical.split(";").map((kv) => kv.split("=") as [string, string]));
  const ints = (key: string) => (parts.get(key)?.split(",") ?? []).map(Number);

  const byday: number[] = [];
  const bynthday: { n: number; day: number }[] = [];
  for (const token of parts.get("BYDAY")?.split(",") ?? []) {
    const [, nth, code] = BYDAY_TOKEN.exec(token)!;
    if (nth) bynthday.push({ n: Number(nth), day: DAY_INDEX[code] });
    else byday.push(DAY_INDEX[code]);
  }

  const count = parts.has("COUNT") ? Number(parts.get("COUNT")) : undefined;
  return {
    freq: parts.get("FREQ") as ParsedRRule["freq"],
    interval: Number(parts.get("INTERVAL") ?? 1),
    byday,
    bynthday,
    bymonthday: ints("BYMONTHDAY"),
    bymonth: ints("BYMONTH"),
    bysetpos: ints("BYSETPOS"),
    count,
    until: parseUntil(parts.get("UNTIL")),
  };
}

/** RRULE UNTIL is "YYYYMMDD", "YYYYMMDDTHHMMSS" (floating), or "...Z" (UTC). */
function parseUntil(v?: string): RRuleUntil | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(v);
  if (!m) return undefined;
  const [, y, mo, d, hh, mi, ss, z] = m;
  return {
    y: +y,
    mo: +mo,
    d: +d,
    ...(hh !== undefined && { time: { hh: +hh, mi: +mi, ss: +ss } }),
    utc: z === "Z",
  };
}

/** The last instant an occurrence may start at, for an UNTIL read in `tz`. */
function untilInstant(u: RRuleUntil, tz: string | undefined): number {
  if (!u.time) {
    // The whole local day counts: the bound sits just before the next local midnight.
    const next = fromIndex(dateIndex(u.y, u.mo, u.d) + 1);
    return instantOf({ ...next, hh: 0, mi: 0, ss: 0 }, tz) - 1;
  }
  const { hh, mi, ss } = u.time;
  if (u.utc) return Date.UTC(u.y, u.mo - 1, u.d, hh, mi, ss);
  return instantOf({ y: u.y, mo: u.mo, d: u.d, hh, mi, ss }, tz);
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
 * hour of a spring-forward gap the result lands one hour over, the same
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

// A local calendar date as a plain day number (UTC days since epoch): pure
// calendar arithmetic with no DST anywhere near it.
const dateIndex = (y: number, mo: number, d: number) => Date.UTC(y, mo - 1, d) / DAY_MS;
const fromIndex = (idx: number) => {
  const dt = new Date(idx * DAY_MS);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};
const weekdayOfIndex = (idx: number) => new Date(idx * DAY_MS).getUTCDay();
const daysInMonth = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

/** BYMONTHDAY match; negative values count back from the month's last day. */
function matchesMonthDay(idx: number, days: number[]): boolean {
  const { y, mo, d } = fromIndex(idx);
  const dim = daysInMonth(y, mo);
  return days.some((n) => (n > 0 ? n : dim + 1 + n) === d);
}

/** Dates in [first, last] that BYDAY selects; ordinals count from either end of that span. */
function weekdayDates(rule: ParsedRRule, first: number, last: number): number[] {
  const firstOf = (day: number) => first + ((day - weekdayOfIndex(first) + 7) % 7);
  const lastOf = (day: number) => last - ((weekdayOfIndex(last) - day + 7) % 7);
  const out: number[] = [];
  for (const day of rule.byday) {
    for (let idx = firstOf(day); idx <= last; idx += 7) out.push(idx);
  }
  for (const { n, day } of rule.bynthday) {
    const idx = n > 0 ? firstOf(day) + (n - 1) * 7 : lastOf(day) + (n + 1) * 7;
    if (idx >= first && idx <= last) out.push(idx);
  }
  return out;
}

/**
 * The dates one MONTHLY or YEARLY period generates, ascending, after
 * BYSETPOS. `months` are the months of year `y` inside the period. BYDAY
 * together with BYMONTHDAY means both must hold (Friday the 13th); with
 * neither, each month contributes the anchor's day of the month.
 */
function periodDates(rule: ParsedRRule, y: number, months: number[], anchorDay: number): number[] {
  const byWeekday = rule.byday.length > 0 || rule.bynthday.length > 0;
  let dates: number[] = [];
  if (rule.freq === "YEARLY" && !rule.bymonth.length && byWeekday) {
    // Without BYMONTH a yearly ordinal counts through the whole year.
    dates = weekdayDates(rule, dateIndex(y, 1, 1), dateIndex(y, 12, 31));
    if (rule.bymonthday.length)
      dates = dates.filter((idx) => matchesMonthDay(idx, rule.bymonthday));
  } else {
    for (const mo of months) {
      const first = dateIndex(y, mo, 1);
      const dim = daysInMonth(y, mo);
      if (byWeekday) {
        const inMonth = weekdayDates(rule, first, first + dim - 1);
        dates.push(
          ...(rule.bymonthday.length
            ? inMonth.filter((idx) => matchesMonthDay(idx, rule.bymonthday))
            : inMonth),
        );
      } else if (rule.bymonthday.length) {
        for (const n of rule.bymonthday) {
          const d = n > 0 ? n : dim + 1 + n;
          if (d >= 1 && d <= dim) dates.push(first + d - 1);
        }
      } else if (anchorDay <= dim) {
        dates.push(first + anchorDay - 1);
      }
    }
  }
  dates = [...new Set(dates)].sort((a, b) => a - b);
  if (!rule.bysetpos.length) return dates;
  const picked = rule.bysetpos
    .map((pos) => dates[pos > 0 ? pos - 1 : dates.length + pos])
    .filter((idx) => idx !== undefined);
  return [...new Set(picked)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/**
 * Occurrence start instants (ms) in chronological order, honoring COUNT and
 * UNTIL. The anchor is always the first instance (RFC 5545: DTSTART belongs
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
  // UNTIL is local wall-clock time (or UTC when it ends in Z), so it only
  // becomes an instant once the event's timezone is known.
  const untilMs = rule.until ? untilInstant(rule.until, tz) : undefined;
  const pastUntil = (ms: number) => untilMs != null && ms > untilMs;

  // The anchor instant itself, exactly as stored.
  if (done()) return;
  if (pastUntil(anchorMs)) return;
  yield anchorMs;
  emitted++;

  if (rule.freq === "DAILY") {
    for (let p = 1; !done(); p++) {
      steps++;
      const ms = timeOf(anchorIdx + p * rule.interval);
      if (pastUntil(ms)) return;
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
        if (pastUntil(ms)) return;
        if (done()) return;
        yield ms;
        emitted++;
      }
    }
    return;
  }

  // MONTHLY / YEARLY. BYDAY, BYMONTHDAY, BYMONTH and BYSETPOS are applied
  // per period; a month without the requested day is skipped, never rolled
  // into the next month (Jan 31 + 1 month).
  const monthStep = rule.freq === "YEARLY" ? 12 * rule.interval : rule.interval;
  const anchorMonth = aw.y * 12 + (aw.mo - 1);
  for (let p = 0; !done(); p++) {
    steps++;
    const total = anchorMonth + p * monthStep;
    const y = Math.floor(total / 12);
    const mo = (total % 12) + 1;
    const months =
      rule.freq === "YEARLY"
        ? rule.bymonth.length
          ? rule.bymonth
          : [aw.mo]
        : !rule.bymonth.length || rule.bymonth.includes(mo)
          ? [mo]
          : [];
    for (const idx of periodDates(rule, y, months, aw.d)) {
      if (idx <= anchorIdx) continue;
      const ms = timeOf(idx);
      if (pastUntil(ms)) return;
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
        : // series over; every later `now` lands on the final occurrence
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
