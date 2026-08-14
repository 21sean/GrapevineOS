/**
 * Assertions for the OSM opening-hours parser behind the venue card's
 * "Open now" line (shared/hours.ts, evaluated in the browser).
 *
 *   npm run hours:eval
 *
 * No network and no model — the parser is the one piece of this feature that
 * is entirely our own logic rather than a projection of a Mapbox response, so
 * it is the piece worth pinning down. The hour strings here are real shapes
 * the Places API returns for San Diego venues.
 */
import { clockLabel, openState, parseOpeningHours } from "../../shared/hours.js";

let failures = 0;

function check(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(52)} ${ok ? g : `${g}  wanted ${w}`}`);
}

// ---------------------------------------------------------------------------
// 1. Parsing
// ---------------------------------------------------------------------------
console.log("\nparsing");
check("24/7 opens every day", parseOpeningHours("24/7")?.[0], [{ from: 0, to: 1440 }]);
check("weekday range", parseOpeningHours("Mo-Fr 09:00-17:00")?.[0], [{ from: 540, to: 1020 }]);
check("weekday range excludes Saturday", parseOpeningHours("Mo-Fr 09:00-17:00")?.[5], []);
check("span past midnight extends past 1440", parseOpeningHours("Fr 20:00-02:00")?.[4], [
  { from: 1200, to: 1560 },
]);
check("two spans in one day", parseOpeningHours("Sa 09:00-12:00,18:00-22:00")?.[5], [
  { from: 540, to: 720 },
  { from: 1080, to: 1320 },
]);
check("off clears the day", parseOpeningHours("Mo-Su 09:00-17:00; Su off")?.[6], []);
check("day list", parseOpeningHours("Sa,Su 10:00-14:00")?.[6], [{ from: 600, to: 840 }]);
check("wrapping range Fr-Mo includes Monday", parseOpeningHours("Fr-Mo 10:00-14:00")?.[0], [
  { from: 600, to: 840 },
]);
check("bare times apply to every day", parseOpeningHours("09:00-17:00")?.[3], [
  { from: 540, to: 1020 },
]);
// The real San Diego Zoo string, which varies by day.
check(
  "per-day rules (San Diego Zoo)",
  parseOpeningHours(
    "Mo 09:00-18:00; Tu 09:00-18:00; We 09:00-18:00; Th 09:00-18:00; Fr 09:00-21:00; Sa 09:00-20:00; Su 09:00-17:00",
  )?.[4],
  [{ from: 540, to: 1260 }],
);
check("unsupported syntax is null", parseOpeningHours("Mo-Fr sunrise-sunset"), null);
check("holiday syntax is null", parseOpeningHours("PH off"), null);
check("empty is null", parseOpeningHours(""), null);

// ---------------------------------------------------------------------------
// 2. Open state — UTC so the assertions are unambiguous. 2026-07-29 is a Wed.
// ---------------------------------------------------------------------------
console.log("\nopen state");
const at = (iso: string) => new Date(iso);

check("open mid-shift reports closing time", openState("Mo-Fr 09:00-17:00", "UTC", at("2026-07-29T12:00:00Z")), {
  open: true,
  at: "5 PM",
});
check("before opening, same day", openState("Mo-Fr 09:00-17:00", "UTC", at("2026-07-29T07:00:00Z")), {
  open: false,
  at: "9 AM",
  laterInWeek: false,
});
check("after closing rolls to tomorrow", openState("Mo-Fr 09:00-17:00", "UTC", at("2026-07-29T18:00:00Z")), {
  open: false,
  at: "9 AM",
  laterInWeek: true,
});
check("last night's late span is still open", openState("We 20:00-02:00", "UTC", at("2026-07-30T01:00:00Z")), {
  open: true,
  at: "2 AM",
});
check("closed once the late span ends", openState("We 20:00-02:00", "UTC", at("2026-07-30T03:00:00Z")), {
  open: false,
  at: "8 PM",
  laterInWeek: true,
});
check("24/7 is always open", openState("24/7", "UTC", at("2026-07-29T03:00:00Z")), {
  open: true,
  at: "12 AM",
});
check("unparseable hours give null", openState("PH off", "UTC", at("2026-07-29T12:00:00Z")), null);
check("unknown timezone gives null", openState("Mo-Fr 09:00-17:00", "Not/AZone", at("2026-07-29T12:00:00Z")), null);
// 12:00 UTC is 05:00 in San Diego, before opening — the zone must be applied.
check(
  "evaluated in the venue's own timezone",
  openState("Mo-Fr 09:00-17:00", "America/Los_Angeles", at("2026-07-29T12:00:00Z")),
  { open: false, at: "9 AM", laterInWeek: false },
);

// ---------------------------------------------------------------------------
// 3. Labels
// ---------------------------------------------------------------------------
console.log("\nlabels");
check("on the hour", clockLabel(1020), "5 PM");
check("with minutes", clockLabel(1230), "8:30 PM");
check("midnight", clockLabel(0), "12 AM");
check("noon", clockLabel(720), "12 PM");

console.log(`\n${failures === 0 ? "All expectations met." : `${failures} expectation(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
