/**
 * Near-duplicate collapse.
 *
 * The "collapse" pairs are the real ones a 2026-08-02 discovery backfill put
 * in the database: four duplicate rows in about a hundred events, every one of
 * the same shape. The "keep apart" pairs are the reason the predicate demands
 * title containment rather than keying on venue and day — two films at one
 * multiplex, two stages at one festival, and a support act all share a venue
 * and an instant, and merging them silently deletes a real event.
 *
 * The second list is the one that matters. A dedupe that is too eager fails
 * invisibly: nobody notices the show that never appeared.
 */
import { collapseNearDuplicates, nearDuplicate, richness } from "../../dedupe.js";
import type { CityEvent } from "../../types.js";
import { expect, expectEq, type EvalCase, type EvalSuite } from "../harness.js";

function ev(p: Partial<CityEvent> & Pick<CityEvent, "title" | "start" | "venue">): CityEvent {
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

const COLLAPSE: { id: string; name: string; note: string; a: CityEvent; b: CityEvent }[] = [
  {
    id: "bare-vs-qualified-team",
    name: "Bare vs. fully-qualified team name",
    note: "Two sources, one ballgame: the schedule page drops the city, the ticket page keeps it.",
    a: ev({ title: "Padres vs. San Francisco Giants", start: "2026-08-02T13:10:00-07:00", venue: "Petco Park" }),
    b: ev({ title: "San Diego Padres vs. San Francisco Giants", start: "2026-08-02T13:10:00-07:00", venue: "Petco Park" }),
  },
  {
    id: "festival-plus-descriptor",
    name: "Festival name vs. name plus descriptor",
    note: "One street fair, two rows, because a listing appended its own subtitle.",
    a: ev({ title: "Hillcrest CityFest", start: "2026-08-09T12:00:00-07:00", venue: "5th Avenue, Hillcrest" }),
    b: ev({ title: "Hillcrest CityFest Summer Block Party", start: "2026-08-09T12:00:00-07:00", venue: "5th Avenue Hillcrest" }),
  },
  {
    id: "show-plus-guest",
    name: "Show vs. show with guest artist",
    note: "Venue spellings differ too, so this pair also exercises the venue normalizer.",
    a: ev({ title: "Stayin' Alive: The Bee Gees & Beyond", start: "2026-08-08T19:30:00-07:00", venue: "The Rady Shell at Jacobs Park" }),
    b: ev({ title: "Stayin' Alive: The Bee Gees & Beyond with RAJATON", start: "2026-08-08T19:30:00-07:00", venue: "Rady Shell @ Jacobs Park" }),
  },
  {
    id: "recurring-exhibit-extended-title",
    name: "Recurring exhibit, one title extended",
    note: "Both carry the same RRULE, so the series clause must not block the collapse.",
    a: ev({ title: "Comic-Con Museum: Doctor Who Worlds of Wonder", start: "2026-08-02T10:00:00-07:00", venue: "Comic-Con Museum", recurrence: "FREQ=WEEKLY;BYDAY=SU,MO,TU,TH,FR,SA" }),
    b: ev({ title: "Comic-Con Museum: Doctor Who Worlds of Wonder and Lucha Libre Exhibits", start: "2026-08-02T10:00:00-07:00", venue: "Comic-Con Museum", recurrence: "FREQ=WEEKLY;BYDAY=SU,MO,TU,TH,FR,SA" }),
  },
  {
    id: "written-ordinal-venue",
    name: "Written-out ordinal vs. numeral in the venue",
    note: "Missed on the first live run: this exact pair reached the database as two rows.",
    a: ev({ title: "Hillcrest CityFest", start: "2026-08-09T12:00:00-07:00", venue: "Fifth Avenue, Hillcrest" }),
    b: ev({ title: "Hillcrest CityFest Summer Block Party", start: "2026-08-09T12:00:00-07:00", venue: "5th Avenue, Hillcrest" }),
  },
  {
    id: "same-instant-different-offset",
    name: "Same instant written in different offsets",
    note: "Comparing local wall-clock strings instead of instants would miss this.",
    a: ev({ title: "Moonchild", start: "2026-08-02T20:00:00-07:00", venue: "Music Box" }),
    b: ev({ title: "Moonchild Live", start: "2026-08-03T03:00:00Z", venue: "Music Box" }),
  },
];

const KEEP_APART: { id: string; name: string; note: string; a: CityEvent; b: CityEvent }[] = [
  {
    id: "two-films-one-multiplex",
    name: "Two films, one multiplex, same showtime",
    note: "The canonical false merge a venue-and-day key would produce.",
    a: ev({ title: "Dune", start: "2026-08-02T20:00:00-07:00", venue: "AMC Mission Valley" }),
    b: ev({ title: "Barbie", start: "2026-08-02T20:00:00-07:00", venue: "AMC Mission Valley" }),
  },
  {
    id: "two-stages-one-festival",
    name: "Two stages, one festival, same slot",
    note: "Festival programming is the highest-volume source of same-venue collisions.",
    a: ev({ title: "Clipping", start: "2026-08-04T21:00:00-07:00", venue: "Balboa Park" }),
    b: ev({ title: "Rome Streetz", start: "2026-08-04T21:00:00-07:00", venue: "Balboa Park" }),
  },
  {
    id: "residency-different-nights",
    name: "Different nights of the same residency",
    note: "Identical titles, one week apart: the instant clause is what keeps them apart.",
    a: ev({ title: "Roast Battle", start: "2026-08-05T20:00:00-07:00", venue: "The Comedy Store" }),
    b: ev({ title: "Roast Battle", start: "2026-08-12T20:00:00-07:00", venue: "The Comedy Store" }),
  },
  {
    id: "same-name-different-venues",
    name: "Same name, same time, different venues",
    note: "Every neighborhood runs a farmers market at 9 on a Sunday.",
    a: ev({ title: "Farmers Market", start: "2026-08-02T09:00:00-07:00", venue: "Little Italy" }),
    b: ev({ title: "Farmers Market", start: "2026-08-02T09:00:00-07:00", venue: "Hillcrest" }),
  },
  {
    id: "one-off-vs-series",
    name: "One-off must not merge into a weekly series",
    note: "Merging these would delete a whole recurring series or pin it to one night.",
    a: ev({ title: "Trivia Night", start: "2026-08-02T19:00:00-07:00", venue: "Bar X" }),
    b: ev({ title: "Trivia Night Special", start: "2026-08-02T19:00:00-07:00", venue: "Bar X", recurrence: "FREQ=WEEKLY;BYDAY=SU" }),
  },
  {
    id: "blank-venue",
    name: "A blank venue is not evidence of sameness",
    note: "Two unknown venues are not the same venue — missing data must not merge rows.",
    a: ev({ title: "Concert", start: "2026-08-02T19:00:00-07:00", venue: "" }),
    b: ev({ title: "Concert Series", start: "2026-08-02T19:00:00-07:00", venue: "" }),
  },
  {
    id: "headliner-vs-support",
    name: "Headliner vs. support act at the same show",
    note: "Both are real listings a user might be looking for by name.",
    a: ev({ title: "Death Cab for Cutie", start: "2026-08-04T19:00:00-07:00", venue: "The Rady Shell" }),
    b: ev({ title: "Nation of Language", start: "2026-08-04T19:00:00-07:00", venue: "The Rady Shell" }),
  },
];

const poor = ev({
  title: "Hillcrest CityFest",
  start: "2026-08-09T12:00:00-07:00",
  venue: "5th Ave",
  description: "A street fair.",
  price: "Free",
});
const rich = ev({
  title: "Hillcrest CityFest Summer Block Party",
  start: "2026-08-09T12:00:00-07:00",
  venue: "5th Ave",
  description: "San Diego's largest free street fair, six blocks of food, art and live music.",
  tags: ["free", "street fair", "music"],
  ticketUrl: "https://example.org/cityfest",
});

export const dedupeSuite: EvalSuite = {
  id: "dedupe",
  title: "Near-duplicate collapse",
  what: "Two spellings of one event become one row, and two real events never become one.",
  kind: "offline",
  threshold: 1,
  cases: (): EvalCase[] => [
    ...COLLAPSE.map(({ id, name, note, a, b }) => ({
      id: `collapse-${id}`,
      name,
      note,
      run: () => {
        expect(nearDuplicate(a, b), "not detected as a duplicate");
        expect(nearDuplicate(b, a), "detected in one direction only — the predicate is not symmetric");
        return "collapsed, both directions";
      },
    })),
    ...KEEP_APART.map(({ id, name, note, a, b }) => ({
      id: `apart-${id}`,
      name,
      note,
      run: () => {
        expect(!nearDuplicate(a, b), `wrongly merged "${a.title}" into "${b.title}"`);
        expect(!nearDuplicate(b, a), `wrongly merged "${b.title}" into "${a.title}"`);
        return "kept apart, both directions";
      },
    })),
    {
      id: "merge-keeps-the-richer-record",
      name: "The merge keeps the richer record and backfills from the poorer one",
      note: "A collapse that dropped the only price or ticket link would lose real information.",
      run: () => {
        const { events, collapsed } = collapseNearDuplicates([poor, rich]);
        expectEq(events.length, 1, "events after collapse");
        expectEq(collapsed.length, 1, "collapses reported");
        const merged = events[0];
        expectEq(merged.title, rich.title, "kept title");
        expectEq(merged.description, rich.description, "kept description");
        expectEq(merged.ticketUrl, rich.ticketUrl, "carried the ticket url over");
        expectEq(merged.price, "Free", "backfilled price from the poorer copy");
        expect(richness(rich) > richness(poor), "richness ranks the poorer record higher");
        return "richer record kept, price backfilled from the poorer one";
      },
    },
    {
      id: "merge-is-order-independent",
      name: "Input order does not decide the outcome",
      note: "Sources arrive in whatever order the crawl finished — the result must not depend on it.",
      run: () => {
        const forward = collapseNearDuplicates([poor, rich]).events[0];
        const reversed = collapseNearDuplicates([rich, poor]).events[0];
        expectEq(reversed.title, forward.title, "title after reversing the input");
        expectEq(reversed.description, forward.description, "description after reversing the input");
        return "same merged record either way round";
      },
    },
  ],
};
