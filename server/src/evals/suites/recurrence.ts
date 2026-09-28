/**
 * RRULE expansion: the code that decides which night a weekly event is on.
 *
 * Every surface in the app reads through nextOccurrence: the map pin, the
 * "live now" count, the agent's snapshot, the digest push, the ICS feed. When
 * it is wrong it is wrong everywhere at once and silently, because a farmers
 * market showing last Sunday's date still looks like a farmers market.
 *
 * The daylight-saving case is the one to keep. A weekly 7 PM concert must stay
 * at 7 PM local across the November change; arithmetic in milliseconds moves it
 * to 6 PM and nothing throws.
 */
import { normalizeRRule, nextOccurrence, parseRRule, recurrenceSummary } from "../../recurrence.js";
import { expect, expectEq, type EvalSuite } from "../harness.js";
import { FIXTURE_NOW, FIXTURE_SETTINGS } from "../fixtures.js";

const TZ = FIXTURE_SETTINGS.tz;

/** Wall-clock rendering in the city's own zone, how a user reads a time. */
const wall = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));

const occ = (e: { start: string; end: string; recurrence?: string }, now: Date = FIXTURE_NOW) =>
  nextOccurrence(e, now, TZ);

export const recurrenceSuite: EvalSuite = {
  id: "recurrence",
  title: "Recurrence expansion",
  what: "Which night a weekly event is actually on, in the city's own clock.",
  kind: "offline",
  threshold: 1,
  cases: () => [
    {
      id: "normalize",
      name: "Rules are normalized, and prose is refused",
      note: 'Sources emit "RRULE:" prefixes and lowercase days; a model sometimes emits English.',
      run: () => {
        expectEq(
          normalizeRRule("RRULE:FREQ=WEEKLY;BYDAY=sa"),
          "FREQ=WEEKLY;BYDAY=SA",
          "prefixed and lowercase",
        );
        expectEq(normalizeRRule("every saturday"), null, "prose rule");
        expectEq(normalizeRRule(""), null, "empty");
        return "prefix stripped, days upper-cased, prose declined";
      },
    },
    {
      id: "one-off-unchanged",
      name: "A one-off returns its own start, untouched",
      note: "Most of the catalog has no rule at all; this path must stay a pass-through.",
      run: () => {
        const e = { start: "2026-09-01T10:00:00-07:00", end: "2026-09-01T12:00:00-07:00" };
        expectEq(occ(e), e, "one-off occurrence");
        return "returned verbatim";
      },
    },
    {
      id: "invalid-rule-degrades",
      name: "An unparseable rule degrades to a one-off",
      note: "The alternative is an event that vanishes because its rule was mistyped.",
      run: () => {
        const e = {
          start: "2026-09-01T10:00:00-07:00",
          end: "2026-09-01T12:00:00-07:00",
          recurrence: "every other saturday",
        };
        expectEq(occ(e), { start: e.start, end: e.end }, "occurrence for a bad rule");
        return "kept as a single dated event";
      },
    },
    {
      id: "weekly-next",
      name: "A weekly Saturday market, asked on a Wednesday",
      run: () => {
        const got = occ({
          start: "2026-08-08T08:00:00-07:00",
          end: "2026-08-08T14:00:00-07:00",
          recurrence: "FREQ=WEEKLY;BYDAY=SA",
        });
        expectEq(wall(got.start), "Sat, Aug 8, 8:00 AM PDT", "next occurrence");
        return "Sat, Aug 8, 8:00 AM PDT";
      },
    },
    {
      id: "live-occurrence-wins",
      name: "An occurrence already under way beats the next one",
      note: 'Returning next Wednesday here is what makes a market that is open right now read as "in 6 days".',
      run: () => {
        const got = occ({
          start: "2026-08-05T16:00:00-07:00",
          end: "2026-08-05T20:00:00-07:00",
          recurrence: "FREQ=WEEKLY;BYDAY=WE",
        });
        expectEq(wall(got.start), "Wed, Aug 5, 4:00 PM PDT", "occurrence at 6:30 PM Wednesday");
        expect(
          Date.parse(got.start) <= FIXTURE_NOW.getTime(),
          "returned a future occurrence while one is live",
        );
        expect(
          Date.parse(got.end) >= FIXTURE_NOW.getTime(),
          "returned an occurrence that has already ended",
        );
        return "today's 4 PM occurrence, still running";
      },
    },
    {
      id: "dst-holds-wall-clock",
      name: "A weekly 7 PM show stays at 7 PM across the November change",
      note: "Stepping in milliseconds moves it to 6 PM, and nothing anywhere throws.",
      run: () => {
        const series = {
          start: "2026-10-04T19:00:00-07:00",
          end: "2026-10-04T21:00:00-07:00",
          recurrence: "FREQ=WEEKLY;BYDAY=SU",
        };
        const before = occ(series, new Date("2026-10-05T00:00:00Z"));
        const after = occ(series, new Date("2026-11-02T12:00:00Z"));
        expectEq(wall(before.start), "Sun, Oct 4, 7:00 PM PDT", "before the change");
        expectEq(wall(after.start), "Sun, Nov 8, 7:00 PM PST", "after the change");
        return "7:00 PM in both PDT and PST";
      },
    },
    {
      id: "interval",
      name: "INTERVAL=2 skips the intervening week",
      run: () => {
        const got = occ({
          start: "2026-07-25T10:00:00-07:00",
          end: "2026-07-25T12:00:00-07:00",
          recurrence: "FREQ=WEEKLY;INTERVAL=2;BYDAY=SA",
        });
        expectEq(wall(got.start), "Sat, Aug 8, 10:00 AM PDT", "next fortnightly occurrence");
        return "Aug 8, skipping Aug 1";
      },
    },
    {
      id: "bounded-series-retires",
      name: "A finished series returns its last occurrence, not a new one",
      note: "Downstream code retires events by asking whether the occurrence has ended. Inventing a future date would keep a dead series on the map forever.",
      run: () => {
        const got = occ({
          start: "2026-06-06T10:00:00-07:00",
          end: "2026-06-06T12:00:00-07:00",
          recurrence: "FREQ=WEEKLY;BYDAY=SA;UNTIL=20260628T000000Z",
        });
        expect(
          Date.parse(got.end) < FIXTURE_NOW.getTime(),
          `returned ${got.start}, which has not ended`,
        );
        expectEq(wall(got.start), "Sat, Jun 27, 10:00 AM PDT", "final occurrence");
        return "final occurrence, already ended, so callers retire it";
      },
    },
    {
      id: "monthly-byday-of-month",
      name: "Monthly on the 31st skips the months that have no 31st",
      run: () => {
        const got = occ({
          start: "2026-01-31T10:00:00-08:00",
          end: "2026-01-31T11:00:00-08:00",
          recurrence: "FREQ=MONTHLY;BYMONTHDAY=31",
        });
        expectEq(wall(got.start), "Mon, Aug 31, 10:00 AM PDT", "next 31st");
        return "Aug 31, no drift into September";
      },
    },
    {
      id: "expansion-is-bounded",
      name: "A stale long-running series terminates and fails closed",
      note: "Expansion caps at 3000 steps, so a daily series older than about eight years resolves to a past occurrence. The cap is the point: callers drop a past occurrence, so the failure is a missing event rather than a wrong date on the map.",
      run: () => {
        const t0 = Date.now();
        const got = occ({
          start: "2006-01-01T10:00:00-08:00",
          end: "2006-01-01T11:00:00-08:00",
          recurrence: "FREQ=DAILY",
        });
        const ms = Date.now() - t0;
        expect(ms < 1000, `took ${ms}ms to give up`);
        expect(
          Date.parse(got.end) < FIXTURE_NOW.getTime(),
          `returned ${got.start}, a future date the expansion never actually reached`,
        );
        return `gave up in ${ms}ms and returned a past occurrence, which callers drop`;
      },
    },
    {
      id: "parse-and-summarize",
      name: "Rules parse into their parts and read back in English",
      note: "The summary is what the event card shows, so it is user-visible output.",
      run: () => {
        expectEq(
          parseRRule("FREQ=WEEKLY;BYDAY=SA,SU;COUNT=4"),
          { freq: "WEEKLY", interval: 1, byday: [0, 6], bymonthday: [], count: 4 },
          "parsed rule",
        );
        expectEq(recurrenceSummary("FREQ=WEEKLY;BYDAY=SA"), "Weekly on Sat", "weekly summary");
        expectEq(
          recurrenceSummary("FREQ=WEEKLY;INTERVAL=2;BYDAY=SA"),
          "Every 2 weeks on Sat",
          "fortnightly summary",
        );
        expectEq(recurrenceSummary("FREQ=DAILY"), "Daily", "daily summary");
        return "4 rules read back correctly";
      },
    },
  ],
};
