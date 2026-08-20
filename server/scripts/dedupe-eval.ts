/**
 * Dedupe eval — checks the near-duplicate predicate against the cases that
 * motivated it and, more importantly, against the ones it must NOT touch.
 *
 *   npx tsx scripts/dedupe-eval.ts
 *
 * The four "collapse" cases are the real pairs a 2026-08-02 discovery backfill
 * produced. The "keep apart" cases are the reason the predicate demands title
 * containment instead of keying on venue + day: two films at one multiplex, two
 * stages at one festival, and a support act share a venue and an instant, and
 * merging them would silently delete a real event.
 *
 * Imports only dedupe.ts, which pulls in recurrence.ts and types.ts and nothing
 * else — no DB, no LLM, so this runs offline in milliseconds.
 */
import { collapseNearDuplicates, nearDuplicate, richness } from "../src/dedupe.js";
import type { CityEvent } from "../src/types.js";

function ev(p: Partial<CityEvent> & { title: string; start: string; venue: string }): CityEvent {
  // Defaults first, caller's fields last — `p` always wins.
  return {
    id: p.title.toLowerCase().replace(/\W+/g, "-"),
    description: "",
    category: "music",
    tags: [],
    lng: -117.16,
    lat: 32.72,
    end: p.start,
    price: "",
    free: false,
    source: "test",
    sourceKind: "search",
    rating: 3,
    promoted: false,
    rarity: "common",
    ...p,
  } as CityEvent;
}

const COLLAPSE: [string, CityEvent, CityEvent][] = [
  [
    "bare vs. fully-qualified team name",
    ev({ title: "Padres vs. San Francisco Giants", start: "2026-08-02T13:10:00-07:00", venue: "Petco Park" }),
    ev({ title: "San Diego Padres vs. San Francisco Giants", start: "2026-08-02T13:10:00-07:00", venue: "Petco Park" }),
  ],
  [
    "festival name vs. name + descriptor",
    ev({ title: "Hillcrest CityFest", start: "2026-08-09T12:00:00-07:00", venue: "5th Avenue, Hillcrest" }),
    ev({ title: "Hillcrest CityFest Summer Block Party", start: "2026-08-09T12:00:00-07:00", venue: "5th Avenue Hillcrest" }),
  ],
  [
    "show vs. show + guest artist",
    ev({ title: "Stayin' Alive: The Bee Gees & Beyond", start: "2026-08-08T19:30:00-07:00", venue: "The Rady Shell at Jacobs Park" }),
    ev({ title: "Stayin' Alive: The Bee Gees & Beyond with RAJATON", start: "2026-08-08T19:30:00-07:00", venue: "Rady Shell @ Jacobs Park" }),
  ],
  [
    "recurring exhibit, one title extended",
    ev({ title: "Comic-Con Museum: Doctor Who Worlds of Wonder", start: "2026-08-02T10:00:00-07:00", venue: "Comic-Con Museum", recurrence: "FREQ=WEEKLY;BYDAY=SU,MO,TU,TH,FR,SA" }),
    ev({ title: "Comic-Con Museum: Doctor Who Worlds of Wonder and Lucha Libre Exhibits", start: "2026-08-02T10:00:00-07:00", venue: "Comic-Con Museum", recurrence: "FREQ=WEEKLY;BYDAY=SU,MO,TU,TH,FR,SA" }),
  ],
  [
    // Missed on the first live run: this pair reached the DB as two rows.
    "written-out ordinal vs. numeral in the venue",
    ev({ title: "Hillcrest CityFest", start: "2026-08-09T12:00:00-07:00", venue: "Fifth Avenue, Hillcrest" }),
    ev({ title: "Hillcrest CityFest Summer Block Party", start: "2026-08-09T12:00:00-07:00", venue: "5th Avenue, Hillcrest" }),
  ],
  [
    "same instant written in different offsets",
    ev({ title: "Moonchild", start: "2026-08-02T20:00:00-07:00", venue: "Music Box" }),
    ev({ title: "Moonchild Live", start: "2026-08-03T03:00:00Z", venue: "Music Box" }),
  ],
];

const KEEP_APART: [string, CityEvent, CityEvent][] = [
  [
    "two films, one multiplex, same showtime",
    ev({ title: "Dune", start: "2026-08-02T20:00:00-07:00", venue: "AMC Mission Valley" }),
    ev({ title: "Barbie", start: "2026-08-02T20:00:00-07:00", venue: "AMC Mission Valley" }),
  ],
  [
    "two stages, one festival, same slot",
    ev({ title: "Clipping", start: "2026-08-04T21:00:00-07:00", venue: "Balboa Park" }),
    ev({ title: "Rome Streetz", start: "2026-08-04T21:00:00-07:00", venue: "Balboa Park" }),
  ],
  [
    "different nights of the same residency",
    ev({ title: "Roast Battle", start: "2026-08-05T20:00:00-07:00", venue: "The Comedy Store" }),
    ev({ title: "Roast Battle", start: "2026-08-12T20:00:00-07:00", venue: "The Comedy Store" }),
  ],
  [
    "same name, same time, different venues",
    ev({ title: "Farmers Market", start: "2026-08-02T09:00:00-07:00", venue: "Little Italy" }),
    ev({ title: "Farmers Market", start: "2026-08-02T09:00:00-07:00", venue: "Hillcrest" }),
  ],
  [
    "one-off must not merge into a weekly series",
    ev({ title: "Trivia Night", start: "2026-08-02T19:00:00-07:00", venue: "Bar X" }),
    ev({ title: "Trivia Night Special", start: "2026-08-02T19:00:00-07:00", venue: "Bar X", recurrence: "FREQ=WEEKLY;BYDAY=SU" }),
  ],
  [
    "blank venue is not evidence of sameness",
    ev({ title: "Concert", start: "2026-08-02T19:00:00-07:00", venue: "" }),
    ev({ title: "Concert Series", start: "2026-08-02T19:00:00-07:00", venue: "" }),
  ],
  [
    "headliner vs. support act at the same show",
    ev({ title: "Death Cab for Cutie", start: "2026-08-04T19:00:00-07:00", venue: "The Rady Shell" }),
    ev({ title: "Nation of Language", start: "2026-08-04T19:00:00-07:00", venue: "The Rady Shell" }),
  ],
];

let failed = 0;
console.log("should collapse:");
for (const [name, a, b] of COLLAPSE) {
  const ok = nearDuplicate(a, b) && nearDuplicate(b, a);
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}`);
}

console.log("\nshould stay apart:");
for (const [name, a, b] of KEEP_APART) {
  const ok = !nearDuplicate(a, b) && !nearDuplicate(b, a);
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}`);
}

// The merge must keep the richer record and backfill from the poorer one.
console.log("\nmerge behaviour:");
const poor = ev({ title: "Hillcrest CityFest", start: "2026-08-09T12:00:00-07:00", venue: "5th Ave", description: "A street fair.", price: "Free" });
const rich = ev({
  title: "Hillcrest CityFest Summer Block Party",
  start: "2026-08-09T12:00:00-07:00",
  venue: "5th Ave",
  description: "San Diego's largest free street fair, six blocks of food, art and live music.",
  tags: ["free", "street fair", "music"],
  ticketUrl: "https://example.org/cityfest",
});
const { events, collapsed } = collapseNearDuplicates([poor, rich]);
const merged = events[0];
const checks: [string, boolean][] = [
  ["collapses to one event", events.length === 1],
  ["reports the collapse", collapsed.length === 1],
  ["keeps the richer title", merged.title === rich.title],
  ["keeps the longer description", merged.description === rich.description],
  ["carries the ticket url over", merged.ticketUrl === rich.ticketUrl],
  ["backfills price from the poorer copy", merged.price === "Free"],
  ["ranks rich above poor", richness(rich) > richness(poor)],
];
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}`);
}

// Order must not decide the outcome.
const reversed = collapseNearDuplicates([rich, poor]).events[0];
const stable = reversed.title === merged.title && reversed.description === merged.description;
if (!stable) failed++;
console.log(`  ${stable ? "pass" : "FAIL"}  order-independent`);

const total = COLLAPSE.length + KEEP_APART.length + checks.length + 1;
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
