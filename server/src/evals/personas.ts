/**
 * Example users.
 *
 * Personalization is the part of this app that is easiest to break and hardest
 * to notice breaking: nothing throws when the ranking quietly stops respecting
 * an "avoid", and no page turns red when a car-free user starts getting results
 * forty minutes up the coast. The fix is to give the promises a name and a
 * person, so a failing case reads as "Priya can no longer trust the distance
 * filter" instead of "assertion 7 failed".
 *
 * These are fixtures, not accounts. They never touch auth, never write to the
 * database, and their ids deliberately do not look like uuids so a persona can
 * never be mistaken for a real row. `history` is the reaction log the taste
 * model learns from (shared/affinity.ts), which is why two of them have one.
 */
import type { Category, EvalPersona, Reaction } from "../types.js";

export interface Persona extends EvalPersona {
  /** Origin for distance-filtered searches, [lng, lat]. */
  home: [number, number];
  /** Reactions keyed by fixture event id: the input to tagAffinity(). */
  reactions: Record<string, Reaction>;
}

function persona(p: {
  id: string;
  name: string;
  initials: string;
  tint: Category;
  blurb: string;
  homeLabel: string;
  home: [number, number];
  loves: string[];
  avoids: string[];
  reactions?: Record<string, Reaction>;
  history?: { title: string; reaction: Reaction }[];
  checks: string[];
}): Persona {
  return { reactions: {}, history: [], ...p };
}

export const PERSONAS: Persona[] = [
  persona({
    id: "nora-new-in-town",
    name: "Nora Ellis",
    initials: "NE",
    tint: "music",
    blurb: "Moved here in June. Wants live music she can walk out of, not a club night.",
    homeLabel: "Hillcrest",
    home: [-117.1604, 32.748],
    loves: ["live music", "jazz", "outdoors"],
    avoids: ["nightlife", "edm"],
    checks: [
      "Asking for music tonight never returns paid placement",
      "A tag search returns only events actually carrying that tag",
      "The free bayside set is findable by the word she would type",
    ],
  }),
  persona({
    id: "marcus-weekend-dad",
    name: "Marcus Webb",
    initials: "MW",
    tint: "market",
    blurb: "Two kids, plans Saturday on Thursday, will not pay $45 for a maybe.",
    homeLabel: "Clairemont",
    home: [-117.1934, 32.8207],
    loves: ["family", "markets", "outdoors"],
    avoids: ["nightlife", "beer"],
    checks: [
      "Free-only means free, with no ticketed event slipping through",
      "The weekly Mercato resolves onto the Saturday he asked about",
      "A weekend range never returns something that already happened",
    ],
  }),
  persona({
    id: "priya-car-free",
    name: "Priya Raman",
    initials: "PR",
    tint: "arts",
    blurb: "No car. If it is more than a half-hour bike ride, it does not exist.",
    homeLabel: "North Park",
    home: [-117.1291, 32.7484],
    loves: ["comedy", "vintage", "coffee"],
    avoids: ["baseball"],
    checks: [
      "A 3 km radius excludes the coast-highway events entirely",
      "Sorting by distance actually puts the closest thing first",
      "An unusable origin degrades to no filter, and says so",
    ],
  }),
  persona({
    id: "dana-power-user",
    name: "Dana Okafor",
    initials: "DO",
    tint: "food",
    blurb: "Reacts to everything. Her taste profile is the one most likely to drift.",
    homeLabel: "Little Italy",
    home: [-117.1686, 32.7235],
    loves: ["live music", "art"],
    avoids: [],
    reactions: {
      "shoreline-jazz": "went",
      "symphony-under-stars": "going",
      "gaslamp-bottle-service": "not_for_me",
    },
    history: [
      { title: "Shoreline Jazz: Ruby Lane Quartet", reaction: "went" },
      { title: "Symphony Under the Stars", reaction: "going" },
      { title: "VIP Bottle Night with Guest DJ", reaction: "not_for_me" },
    ],
    checks: [
      "Two nights out teach jazz and outdoors, not the whole catalog",
      "A rejection stays negative and never flips into a recommendation",
      "Reacting to an event that has since been deleted cannot corrupt the profile",
    ],
  }),
];

/** The wire shape the admin panel renders: no coordinates, no internals. */
export function personaCards(): EvalPersona[] {
  return PERSONAS.map(({ home: _home, reactions: _reactions, ...card }) => card);
}
