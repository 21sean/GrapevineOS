/**
 * The frozen world the offline suites run against.
 *
 * Every number here is fixed on purpose. An eval that reads the real clock,
 * the real database, or the live web tells you the weather, not whether the
 * code is correct: it goes red when a source is down and green again when it
 * comes back, and after two of those nobody reads it. So the catalog below is
 * a hand-built San Diego week, the clock is pinned to one instant, and the
 * suites are pure functions over both.
 *
 * The instant is Wednesday 5 August 2026, 6:30 PM in San Diego, chosen because
 * it sits INSIDE two events (the shoreline set and the Ocean Beach market) and
 * before six others. Off-by-one errors in "live now" have somewhere to show.
 */
import type { AgentCtx, Occurrence } from "../agent/context.js";
import { nextOccurrence } from "../recurrence.js";
import type { CityEvent, Settings } from "../types.js";

/** Wednesday 5 August 2026, 18:30 America/Los_Angeles. */
export const FIXTURE_NOW = new Date("2026-08-05T18:30:00-07:00");

export const FIXTURE_SETTINGS: Settings = {
  city: "San Diego",
  center: [-117.1611, 32.7157],
  tz: "America/Los_Angeles",
  model: "fixture",
  ollamaUrl: "http://127.0.0.1:11434",
  chatProvider: "ollama",
  extractProvider: "ollama",
  guardMode: "on",
  guardThreshold: 0.8,
};

/** Neighborhood centers the fixture venues sit at, [lng, lat]. */
export const PLACES: Record<string, [number, number]> = {
  gaslamp: [-117.1601, 32.7112],
  littleItaly: [-117.1686, 32.7235],
  northPark: [-117.1291, 32.7484],
  hillcrest: [-117.1604, 32.748],
  balboaPark: [-117.1466, 32.7311],
  laJolla: [-117.2713, 32.845],
  oceanBeach: [-117.2489, 32.7495],
  petco: [-117.1571, 32.7073],
  radyShell: [-117.1685, 32.7085],
  encinitas: [-117.292, 33.037],
  barrioLogan: [-117.142, 32.6968],
};

const at = (place: keyof typeof PLACES) => ({ lng: PLACES[place][0], lat: PLACES[place][1] });

function ev(
  p: Partial<CityEvent> & Pick<CityEvent, "id" | "title" | "venue" | "start" | "end" | "lng" | "lat">,
): CityEvent {
  return {
    description: "",
    category: "community",
    tags: [],
    price: "Free",
    free: true,
    source: "fixture",
    sourceKind: "seed",
    rating: 3,
    promoted: false,
    rarity: "common",
    ...p,
  };
}

/**
 * Fifteen events covering every branch retrieval has: live-now and upcoming,
 * free and ticketed, one-off and weekly, promoted and honest, near and far,
 * plus one that has already finished and must never surface again.
 */
export const FIXTURE_EVENTS: CityEvent[] = [
  ev({
    id: "shoreline-jazz",
    title: "Shoreline Jazz: Ruby Lane Quartet",
    description: "Free bayside set as the marine layer burns off.",
    category: "music",
    tags: ["jazz", "live music", "outdoors"],
    venue: "The Rady Shell at Jacobs Park",
    ...at("radyShell"),
    start: "2026-08-05T18:00:00-07:00",
    end: "2026-08-05T21:00:00-07:00",
    rating: 5,
    rarity: "notable",
  }),
  ev({
    id: "ob-wednesday-market",
    title: "Ocean Beach Farmers Market",
    description: "Newport Avenue closes for produce, tamales, and a busker or four.",
    category: "market",
    tags: ["markets", "food trucks", "farmers market"],
    venue: "Newport Avenue, Ocean Beach",
    ...at("oceanBeach"),
    start: "2026-08-05T16:00:00-07:00",
    end: "2026-08-05T20:00:00-07:00",
    recurrence: "FREQ=WEEKLY;BYDAY=WE",
    rating: 4,
  }),
  ev({
    id: "casbah-moonchild",
    title: "Moonchild",
    description: "Late set at the Casbah.",
    category: "music",
    tags: ["live music", "indie"],
    venue: "The Casbah",
    ...at("littleItaly"),
    start: "2026-08-05T21:00:00-07:00",
    end: "2026-08-05T23:30:00-07:00",
    price: "$25",
    free: false,
    rating: 4,
  }),
  ev({
    // Same night as the two above, so only the promoted flag separates it.
    id: "gaslamp-bottle-service",
    title: "VIP Bottle Night with Guest DJ",
    description: "Paid placement.",
    category: "music",
    tags: ["nightlife", "dancing", "edm"],
    venue: "Fifth Avenue, Gaslamp",
    ...at("gaslamp"),
    start: "2026-08-05T22:00:00-07:00",
    end: "2026-08-06T02:00:00-07:00",
    price: "$40+",
    free: false,
    rating: 2,
    promoted: true,
  }),
  ev({
    id: "padres-giants",
    title: "Padres vs. San Francisco Giants",
    category: "sports",
    tags: ["baseball", "family"],
    venue: "Petco Park",
    ...at("petco"),
    start: "2026-08-06T18:40:00-07:00",
    end: "2026-08-06T21:40:00-07:00",
    price: "$18+",
    free: false,
    rating: 4,
  }),
  ev({
    id: "observatory-roast",
    title: "Roast Battle North Park",
    category: "arts",
    tags: ["comedy", "nightlife"],
    venue: "The Observatory North Park",
    ...at("northPark"),
    start: "2026-08-07T20:00:00-07:00",
    end: "2026-08-07T22:00:00-07:00",
    price: "$15",
    free: false,
    rating: 3,
  }),
  ev({
    id: "little-italy-mercato",
    title: "Little Italy Mercato",
    category: "market",
    tags: ["markets", "food trucks", "family", "farmers market"],
    venue: "Date Street, Little Italy",
    ...at("littleItaly"),
    start: "2026-08-08T08:00:00-07:00",
    end: "2026-08-08T14:00:00-07:00",
    recurrence: "FREQ=WEEKLY;BYDAY=SA",
    rating: 4,
  }),
  ev({
    id: "north-park-vinyl",
    title: "North Park Vinyl and Vintage Fair",
    category: "market",
    tags: ["vintage", "markets", "coffee"],
    venue: "North Park Way",
    ...at("northPark"),
    start: "2026-08-08T11:00:00-07:00",
    end: "2026-08-08T16:00:00-07:00",
    rating: 3,
  }),
  ev({
    id: "tide-pool-walk",
    title: "Low-Tide Pool Walk with a Marine Biologist",
    description: "Twice-a-year minus tide.",
    category: "community",
    tags: ["outdoors", "beach", "family", "water"],
    venue: "Dike Rock, La Jolla",
    ...at("laJolla"),
    start: "2026-08-08T09:00:00-07:00",
    end: "2026-08-08T11:00:00-07:00",
    rating: 4,
    rarity: "rare",
  }),
  ev({
    id: "beer-garden-fest",
    title: "Balboa Park Beer Garden Festival",
    category: "food",
    tags: ["beer", "food trucks"],
    venue: "Balboa Park",
    ...at("balboaPark"),
    start: "2026-08-08T12:00:00-07:00",
    end: "2026-08-08T18:00:00-07:00",
    price: "$45",
    free: false,
    rating: 4,
  }),
  ev({
    id: "symphony-under-stars",
    title: "Symphony Under the Stars",
    category: "music",
    tags: ["live music", "outdoors"],
    venue: "The Rady Shell at Jacobs Park",
    ...at("radyShell"),
    start: "2026-08-08T19:30:00-07:00",
    end: "2026-08-08T21:30:00-07:00",
    price: "$30",
    free: false,
    rating: 5,
    rarity: "notable",
  }),
  ev({
    id: "encinitas-beach-yoga",
    title: "Sunrise Beach Yoga",
    category: "community",
    tags: ["yoga", "wellness", "beach", "outdoors"],
    venue: "Moonlight Beach, Encinitas",
    ...at("encinitas"),
    start: "2026-08-08T08:00:00-07:00",
    end: "2026-08-08T09:00:00-07:00",
    rating: 3,
  }),
  ev({
    id: "hillcrest-farmers-market",
    title: "Hillcrest Farmers Market",
    category: "market",
    tags: ["markets", "family", "farmers market"],
    venue: "Normal Street, Hillcrest",
    ...at("hillcrest"),
    start: "2026-08-09T09:00:00-07:00",
    end: "2026-08-09T14:00:00-07:00",
    recurrence: "FREQ=WEEKLY;BYDAY=SU",
    rating: 4,
  }),
  ev({
    id: "spreckels-organ",
    title: "Spreckels Organ Sunday Concert",
    category: "arts",
    tags: ["history", "outdoors", "family"],
    venue: "Spreckels Organ Pavilion",
    ...at("balboaPark"),
    start: "2026-08-09T14:00:00-07:00",
    end: "2026-08-09T15:00:00-07:00",
    recurrence: "FREQ=WEEKLY;BYDAY=SU",
    rating: 3,
  }),
  ev({
    // Finished before the frozen clock. Must never reach a search result.
    id: "barrio-taco-crawl",
    title: "Barrio Logan Taco Crawl",
    category: "food",
    tags: ["food trucks"],
    venue: "Logan Avenue",
    ...at("barrioLogan"),
    start: "2026-08-04T17:00:00-07:00",
    end: "2026-08-04T21:00:00-07:00",
    rating: 4,
  }),
];

export const FIXTURE_BY_ID = new Map(FIXTURE_EVENTS.map((e) => [e.id, e]));

/**
 * The same snapshot buildCtx() assembles from the database, built from the
 * frozen catalog instead: recurrence resolved to each event's occurrence at
 * FIXTURE_NOW, finished events dropped, sorted by next start. It stays in step
 * with buildCtx by construction, because both call nextOccurrence and filter
 * on the same predicate.
 */
export function fixtureCtx(
  opts: { userPos?: [number, number]; events?: CityEvent[] } = {},
): AgentCtx {
  const now = FIXTURE_NOW;
  const upcoming: { e: CityEvent; occ: Occurrence }[] = (opts.events ?? FIXTURE_EVENTS)
    .map((e) => ({ e, occ: nextOccurrence(e, now, FIXTURE_SETTINGS.tz) }))
    .filter(({ occ }) => Date.parse(occ.end) >= now.getTime())
    .sort((a, b) => Date.parse(a.occ.start) - Date.parse(b.occ.start));
  return {
    upcoming,
    byId: new Map(upcoming.map((u) => [u.e.id, u])),
    settings: FIXTURE_SETTINGS,
    now,
    ...(opts.userPos && { userPos: opts.userPos }),
  };
}
