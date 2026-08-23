/**
 * The OSM opening-hours parser behind the venue card's "Open now" line.
 *
 * This is the one piece of the venue feature that is our own logic rather than
 * a projection of a Mapbox response, so it is the piece worth pinning down.
 * The hour strings are real shapes the Places API returns for San Diego venues.
 * "Open now" is a claim a user acts on by driving somewhere, which is why the
 * timezone cases are here: 12:00 UTC is 5 AM in San Diego, and a parser that
 * evaluates in the server's zone tells half the country the wrong thing.
 */
import { clockLabel, openState, parseOpeningHours } from "../../../../shared/hours.js";
import { expectEq, type EvalSuite } from "../harness.js";

const at = (iso: string) => new Date(iso);
/** 2026-07-29 is a Wednesday; UTC keeps the assertions unambiguous. */
const WED = "2026-07-29";

const ZOO = "Mo 09:00-18:00; Tu 09:00-18:00; We 09:00-18:00; Th 09:00-18:00; Fr 09:00-21:00; Sa 09:00-20:00; Su 09:00-17:00";

export const hoursSuite: EvalSuite = {
  id: "hours",
  title: "Venue opening hours",
  what: 'The "Open now" line on a venue card, and the closing time it promises.',
  kind: "offline",
  threshold: 1,
  cases: () => [
    {
      id: "parse-ranges",
      name: "Day ranges, day lists, and bare times",
      note: "The four shapes that cover most of the corpus.",
      run: () => {
        expectEq(parseOpeningHours("24/7")?.[0], [{ from: 0, to: 1440 }], "24/7 on Sunday");
        expectEq(parseOpeningHours("Mo-Fr 09:00-17:00")?.[0], [{ from: 540, to: 1020 }], "weekday range");
        expectEq(parseOpeningHours("Mo-Fr 09:00-17:00")?.[5], [], "weekday range must exclude Saturday");
        expectEq(parseOpeningHours("Sa,Su 10:00-14:00")?.[6], [{ from: 600, to: 840 }], "day list");
        expectEq(parseOpeningHours("09:00-17:00")?.[3], [{ from: 540, to: 1020 }], "bare times apply to every day");
        expectEq(parseOpeningHours("Fr-Mo 10:00-14:00")?.[0], [{ from: 600, to: 840 }], "range wrapping past Sunday");
        return "6 shapes parsed";
      },
    },
    {
      id: "parse-spans",
      name: "Late-night spans, split shifts, and explicit closures",
      note: "A span past midnight that stopped at 1440 would close every bar at midnight.",
      run: () => {
        expectEq(parseOpeningHours("Fr 20:00-02:00")?.[4], [{ from: 1200, to: 1560 }], "span past midnight");
        expectEq(
          parseOpeningHours("Sa 09:00-12:00,18:00-22:00")?.[5],
          [{ from: 540, to: 720 }, { from: 1080, to: 1320 }],
          "two spans in one day",
        );
        expectEq(parseOpeningHours("Mo-Su 09:00-17:00; Su off")?.[6], [], "a later rule clears the day");
        return "spans and overrides applied in order";
      },
    },
    {
      id: "parse-per-day",
      name: "Per-day rules (the real San Diego Zoo string)",
      note: "Seven rules in one string, with a different Friday.",
      run: () => {
        expectEq(parseOpeningHours(ZOO)?.[4], [{ from: 540, to: 1260 }], "Thursday of the zoo string");
        return "9 AM to 9 PM on the late day";
      },
    },
    {
      id: "parse-unsupported",
      name: "Unsupported syntax returns null rather than guessing",
      note: 'A wrong "Open now" is worse than no line at all, so the parser must refuse.',
      run: () => {
        expectEq(parseOpeningHours("Mo-Fr sunrise-sunset"), null, "solar times");
        expectEq(parseOpeningHours("PH off"), null, "public-holiday syntax");
        expectEq(parseOpeningHours(""), null, "empty string");
        return "3 unsupported shapes declined";
      },
    },
    {
      id: "state-mid-shift",
      name: "Open mid-shift, reporting the closing time",
      run: () => {
        expectEq(openState("Mo-Fr 09:00-17:00", "UTC", at(`${WED}T12:00:00Z`)), { open: true, at: "5 PM" }, "midday");
        return "open until 5 PM";
      },
    },
    {
      id: "state-before-opening",
      name: "Before opening, same day",
      run: () => {
        expectEq(
          openState("Mo-Fr 09:00-17:00", "UTC", at(`${WED}T07:00:00Z`)),
          { open: false, at: "9 AM", laterInWeek: false },
          "early morning",
        );
        return "closed, opens 9 AM today";
      },
    },
    {
      id: "state-after-closing",
      name: "After closing, rolling to the next day",
      note: 'laterInWeek is what turns "9 AM" into "9 AM tomorrow" in the UI.',
      run: () => {
        expectEq(
          openState("Mo-Fr 09:00-17:00", "UTC", at(`${WED}T18:00:00Z`)),
          { open: false, at: "9 AM", laterInWeek: true },
          "evening",
        );
        return "closed, opens 9 AM later in the week";
      },
    },
    {
      id: "state-late-span",
      name: "Last night's late span is still open after midnight",
      note: "1 AM on Thursday belongs to Wednesday's 20:00-02:00 shift.",
      run: () => {
        expectEq(openState("We 20:00-02:00", "UTC", at("2026-07-30T01:00:00Z")), { open: true, at: "2 AM" }, "1 AM");
        expectEq(
          openState("We 20:00-02:00", "UTC", at("2026-07-30T03:00:00Z")),
          { open: false, at: "8 PM", laterInWeek: true },
          "3 AM, after the span ends",
        );
        return "open at 1 AM, closed at 3 AM";
      },
    },
    {
      id: "state-always-open",
      name: "24/7 is always open",
      run: () => {
        expectEq(openState("24/7", "UTC", at(`${WED}T03:00:00Z`)), { open: true, at: "12 AM" }, "3 AM");
        return "open at 3 AM";
      },
    },
    {
      id: "state-degrades",
      name: "Unparseable hours and unknown zones give null, not a guess",
      run: () => {
        expectEq(openState("PH off", "UTC", at(`${WED}T12:00:00Z`)), null, "unparseable spec");
        expectEq(openState("Mo-Fr 09:00-17:00", "Not/AZone", at(`${WED}T12:00:00Z`)), null, "unknown timezone");
        return "both declined";
      },
    },
    {
      id: "state-venue-timezone",
      name: "Evaluated in the venue's own timezone",
      note: "12:00 UTC is 5 AM in San Diego. Evaluating in the server's zone would say open.",
      run: () => {
        expectEq(
          openState("Mo-Fr 09:00-17:00", "America/Los_Angeles", at(`${WED}T12:00:00Z`)),
          { open: false, at: "9 AM", laterInWeek: false },
          "noon UTC in Pacific time",
        );
        return "closed at 5 AM local, as it should be";
      },
    },
    {
      id: "clock-labels",
      name: "Clock labels",
      note: "Midnight and noon are where 12-hour formatting usually goes wrong.",
      run: () => {
        expectEq(clockLabel(1020), "5 PM", "on the hour");
        expectEq(clockLabel(1230), "8:30 PM", "with minutes");
        expectEq(clockLabel(0), "12 AM", "midnight");
        expectEq(clockLabel(720), "12 PM", "noon");
        return "4 labels";
      },
    },
  ],
};
