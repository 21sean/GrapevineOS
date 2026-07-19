/**
 * Adds verified real-world San Diego events for the week of Jul 6–12, 2026
 * (researched against venue calendars on 2026-07-06) and repairs recurrence on
 * three seeded weekly staples that predate the recurrence column. Idempotent:
 * inserts upsert on dedupe_key with ignoreDuplicates, updates are absolute.
 *
 *   npm --prefix server exec tsx scripts/add-week-events.ts
 *
 * Times are Pacific (-07:00 in July). End times marked "est." in descriptions
 * where the venue didn't publish one. Missing coordinates are geocoded via
 * Mapbox (cached in geocode_cache), never guessed.
 */
import "dotenv/config";
import { db } from "../src/db.js";
import { geocode } from "../src/mapbox.js";
import { normalizeRRule } from "../src/recurrence.js";
import { eventKey } from "../src/store.js";
import type { Category, Rarity } from "../src/types.js";

// Seed data is authored in San Diego wall-clock time.
const TZ = "America/Los_Angeles";

const SD_CENTER: [number, number] = [-117.1611, 32.7157];
const SOURCE_ID = "web-research";

interface NewEvent {
  id: string;
  title: string;
  description: string;
  category: Category;
  tags: string[];
  venue: string;
  address?: string;
  lngLat?: [number, number]; // omit to geocode venue+address
  start: string;
  end: string;
  recurrence?: string;
  price: string;
  free: boolean;
  ticketUrl?: string;
  rating: number;
  ratingRationale: string;
  rarity: Rarity;
}

const EVENTS: NewEvent[] = [
  // ---- Monday Jul 6 ----------------------------------------------------------
  {
    id: "padres-vs-diamondbacks-jul6",
    title: "Padres vs. Diamondbacks",
    description:
      "The Padres open a four-game homestand against NL West rival Arizona. Nightly through Thu Jul 9 (Wed starts 7:10 PM).",
    category: "sports",
    tags: ["baseball", "sports", "downtown", "family", "nightlife"],
    venue: "Petco Park",
    address: "100 Park Blvd, San Diego, CA 92101",
    start: "2026-07-06T18:40:00-07:00",
    end: "2026-07-06T21:40:00-07:00",
    price: "Varies",
    free: false,
    ticketUrl: "https://www.mlb.com/padres/schedule",
    rating: 4.0,
    ratingRationale: "Petco on a summer night is its own event, rivalry series or not.",
    rarity: "common",
  },
  {
    id: "mattson-nielson-casbah-jul6",
    title: "Jared Mattson & Ruban Nielson at The Casbah",
    description:
      "Experimental collaboration between the Mattson 2's jazz-psych guitarist and Unknown Mortal Orchestra's Ruban Nielson, with Joshua Crumbly. Doors 7, show 8. 21+.",
    category: "music",
    tags: ["live music", "indie", "experimental", "jazz", "nightlife"],
    venue: "The Casbah",
    address: "2501 Kettner Blvd, San Diego, CA 92101",
    start: "2026-07-06T20:00:00-07:00",
    end: "2026-07-06T23:00:00-07:00",
    price: "$25",
    free: false,
    ticketUrl: "https://www.casbahmusic.com/calendar/",
    rating: 4.4,
    ratingRationale: "A one-off pairing you won't see again soon, in a 200-cap room.",
    rarity: "notable",
  },
  // ---- Tuesday Jul 7 ---------------------------------------------------------
  {
    id: "drag-takeover-disney-bellyup-jul7",
    title: "Drag Takeover: Disney Magic",
    description:
      "Disney-themed drag night with Chad Michaels, Mariam T, Kickxy Vixen and cast. Evening show (times est.).",
    category: "music",
    tags: ["drag", "nightlife", "lgbtq", "live music"],
    venue: "Belly Up Tavern",
    address: "143 S Cedros Ave, Solana Beach, CA 92075",
    start: "2026-07-07T20:00:00-07:00",
    end: "2026-07-07T22:30:00-07:00",
    price: "$25–44",
    free: false,
    ticketUrl: "https://bellyup.com/calendar/",
    rating: 3.9,
    ratingRationale: "Chad Michaels is SD drag royalty; reliably sells the room.",
    rarity: "common",
  },
  {
    id: "beauty-and-the-beast-civic-jul7",
    title: "Disney's Beauty and the Beast — Broadway San Diego",
    description:
      "First North American tour of the Disney musical in 25+ years. Eight performances Tue–Sun (evening curtains, weekend matinees — times vary).",
    category: "arts",
    tags: ["theater", "musical", "family", "downtown"],
    venue: "San Diego Civic Theatre",
    address: "1100 Third Ave, San Diego, CA 92101",
    start: "2026-07-07T19:30:00-07:00",
    end: "2026-07-07T22:00:00-07:00",
    recurrence: "FREQ=DAILY;UNTIL=20260713T065959Z",
    price: "From $82",
    free: false,
    ticketUrl: "https://www.broadwaysd.com/upcoming-events/disneys-beauty-and-the-beast-2026/",
    rating: 4.2,
    ratingRationale: "Touring Broadway production, one week only.",
    rarity: "notable",
  },
  // ---- Wednesday Jul 8 -------------------------------------------------------
  {
    id: "shinyribs-bellyup-jul8",
    title: "Shinyribs at Belly Up",
    description:
      "Kevin Russell's Austin swamp-funk and country-soul revue, with Schaefer Llana. Evening show (times est.).",
    category: "music",
    tags: ["live music", "americana", "funk", "nightlife"],
    venue: "Belly Up Tavern",
    address: "143 S Cedros Ave, Solana Beach, CA 92075",
    start: "2026-07-08T20:00:00-07:00",
    end: "2026-07-08T22:30:00-07:00",
    price: "$20–35",
    free: false,
    ticketUrl: "https://bellyup.com/calendar/",
    rating: 4.0,
    ratingRationale: "One of the great live bar bands, in the right-size venue.",
    rarity: "common",
  },
  {
    id: "milestone-hump-day-run-jul8",
    title: "Milestone Running Hump Day Run Club",
    description:
      "Free weekly group run (3–5 mile loop) from the North Park running shop, all paces welcome, post-run prizes.",
    category: "community",
    tags: ["running", "fitness", "free", "community"],
    venue: "Milestone Running",
    address: "Milestone Running, North Park, San Diego",
    start: "2026-07-08T18:00:00-07:00",
    end: "2026-07-08T19:15:00-07:00",
    recurrence: "FREQ=WEEKLY;BYDAY=WE",
    price: "Free",
    free: true,
    ticketUrl: "https://milestonerunning.com/content/community",
    rating: 3.6,
    ratingRationale: "Solid neighborhood run club; a staple, not a spectacle.",
    rarity: "common",
  },
  // ---- Thursday Jul 9 --------------------------------------------------------
  {
    id: "creature-canyon-bellyup-jul9",
    title: "Creature Canyon at Belly Up",
    description:
      "San Diego indie-rock band headlines a local triple bill with SeaPoodle and Three Legged Dog. Evening show (times est.).",
    category: "music",
    tags: ["live music", "indie", "local bands", "nightlife"],
    venue: "Belly Up Tavern",
    address: "143 S Cedros Ave, Solana Beach, CA 92075",
    start: "2026-07-09T20:00:00-07:00",
    end: "2026-07-09T22:30:00-07:00",
    price: "$18–32",
    free: false,
    ticketUrl: "https://bellyup.com/calendar/",
    rating: 3.9,
    ratingRationale: "Hometown bill with real local following.",
    rarity: "common",
  },
  {
    id: "north-by-northwest-oldglobe-jul9",
    title: "North by Northwest — Opening Night at The Old Globe",
    description:
      "North American premiere of Emma Rice's stage adaptation of Hitchcock's thriller — six shape-shifting performers and a '50s soundtrack. Runs through Aug 2 (curtain time est.).",
    category: "arts",
    tags: ["theater", "balboa park", "arts", "date night"],
    venue: "The Old Globe",
    address: "1363 Old Globe Way, San Diego, CA 92101",
    start: "2026-07-09T19:30:00-07:00",
    end: "2026-07-09T21:45:00-07:00",
    price: "Varies",
    free: false,
    ticketUrl: "https://www.theoldglobe.org/pdp/26-season/north-by-northwest/",
    rating: 4.3,
    ratingRationale: "A premiere at the Globe with a director people travel for.",
    rarity: "notable",
  },
  // ---- Friday Jul 10 ---------------------------------------------------------
  {
    id: "padres-vs-bluejays-jul10",
    title: "Padres vs. Blue Jays",
    description:
      "Interleague weekend series caps the homestand: Fri 6:40 PM, Sat 5:40 PM, Sun 1:10 PM matinee.",
    category: "sports",
    tags: ["baseball", "sports", "downtown", "family", "weekend"],
    venue: "Petco Park",
    address: "100 Park Blvd, San Diego, CA 92101",
    start: "2026-07-10T18:40:00-07:00",
    end: "2026-07-10T21:40:00-07:00",
    price: "Varies",
    free: false,
    ticketUrl: "https://www.mlb.com/padres/schedule",
    rating: 4.0,
    ratingRationale: "Weekend baseball downtown; the Sunday matinee is the family move.",
    rarity: "common",
  },
  {
    id: "music-of-69-radyshell-jul10",
    title: "Let The Sunshine In: The Music of '69",
    description:
      "San Diego Symphony with Ted Sperling and Broadway vocalists Morgan James, Bryonha Marie, and Noah J. Ricketts — Woodstock and the Harlem Cultural Festival, outdoors on the bay.",
    category: "music",
    tags: ["live music", "symphony", "outdoors", "waterfront"],
    venue: "The Rady Shell at Jacobs Park",
    address: "222 Marina Park Way, San Diego, CA 92101",
    start: "2026-07-10T19:30:00-07:00",
    end: "2026-07-10T21:45:00-07:00",
    price: "From $39",
    free: false,
    ticketUrl: "https://www.theshell.org/performances/let-the-sunshine-in/",
    rating: 4.5,
    ratingRationale: "The Shell at sunset with a pops program built for it.",
    rarity: "notable",
  },
  {
    id: "revisiting-creedence-humphreys-jul10",
    title: "Revisiting Creedence",
    description:
      "CCR-alumni-connected tribute plays the Creedence Clearwater Revival catalog at the bayside amphitheater.",
    category: "music",
    tags: ["live music", "classic rock", "waterfront", "outdoors"],
    venue: "Humphreys Concerts by the Bay",
    address: "2241 Shelter Island Dr, San Diego, CA 92106",
    start: "2026-07-10T19:30:00-07:00",
    end: "2026-07-10T22:00:00-07:00",
    price: "Varies",
    free: false,
    ticketUrl: "https://humphreysconcerts.com/schedule.cfm",
    rating: 3.8,
    ratingRationale: "Tribute act, but Humphreys on the water forgives a lot.",
    rarity: "common",
  },
  {
    id: "point-loma-summer-concerts-jul10",
    title: "Point Loma Summer Concerts",
    description:
      "Free family concert series opener: TLR – The Long Run (Eagles tribute). Junior stage 5:30, main stage 6:30. Fridays through Aug 7.",
    category: "music",
    tags: ["live music", "free", "family", "outdoors"],
    venue: "Point Loma Park",
    address: "1049 Catalina Blvd, San Diego, CA 92106",
    start: "2026-07-10T17:30:00-07:00",
    end: "2026-07-10T20:30:00-07:00",
    recurrence: "FREQ=WEEKLY;BYDAY=FR;UNTIL=20260808T065959Z",
    price: "Free",
    free: true,
    ticketUrl: "https://www.pointlomasummerconcerts.org/",
    rating: 4.1,
    ratingRationale: "A real neighborhood institution — bring a blanket.",
    rarity: "common",
  },
  {
    id: "fellow-travelers-sdopera-jul10",
    title: "San Diego Opera: Fellow Travelers",
    description:
      "Southern California premiere of Gregory Spears' opera about a secret love affair during the 1950s Lavender Scare. Fri & Sat 7:30 PM, Sun 2 PM.",
    category: "arts",
    tags: ["opera", "arts", "lgbtq", "downtown"],
    venue: "Balboa Theatre",
    address: "868 Fourth Ave, San Diego, CA 92101",
    start: "2026-07-10T19:30:00-07:00",
    end: "2026-07-10T21:45:00-07:00",
    price: "Varies",
    free: false,
    ticketUrl: "https://www.sdopera.org/shows/fellow-travelers/",
    rating: 4.2,
    ratingRationale: "Acclaimed contemporary opera in a three-night-only run.",
    rarity: "notable",
  },
  {
    id: "san-diego-black-pride-jul10",
    title: "San Diego Black Pride",
    description:
      "Three-day celebration of the Black LGBTQ+ community — Mini Ball, drag performances, live music, and a Sunday festival. Times and venues vary by event.",
    category: "festival",
    tags: ["festival", "lgbtq", "community", "nightlife"],
    venue: "Various venues",
    lngLat: SD_CENTER,
    start: "2026-07-10T17:00:00-07:00",
    end: "2026-07-12T22:00:00-07:00",
    price: "Free–ticketed, varies",
    free: false,
    ticketUrl:
      "https://www.sandiego.org/events-festivals/san-diego-black-pride/5315163a5aa111f1a7f2",
    rating: 4.0,
    ratingRationale: "Annual multi-venue weekend with real community pull.",
    rarity: "notable",
  },
  // ---- Saturday Jul 11 -------------------------------------------------------
  {
    id: "beat-farmers-hootenanny-bellyup-jul11",
    title: "15th Annual Beat Farmers Hootenanny",
    description:
      "Annual tribute to San Diego roots-rock legends the Beat Farmers, this year marking 40 years of \"Van Go\". The Farmers & friends. Evening show (times est.).",
    category: "music",
    tags: ["live music", "roots rock", "local legends", "nightlife"],
    venue: "Belly Up Tavern",
    address: "143 S Cedros Ave, Solana Beach, CA 92075",
    start: "2026-07-11T20:00:00-07:00",
    end: "2026-07-11T23:00:00-07:00",
    price: "$25–44",
    free: false,
    ticketUrl: "https://bellyup.com/calendar/",
    rating: 4.2,
    ratingRationale: "Once-a-year gathering of SD music history; locals plan around it.",
    rarity: "rare",
  },
  {
    id: "e40-seaworld-jul11",
    title: "E-40 — SeaWorld Summer Spectacular",
    description:
      "Bay Area hip-hop legend opens SeaWorld's Saturday-night concert series. Free with park admission, first-come seating (parental discretion advised).",
    category: "music",
    tags: ["live music", "hip hop", "family", "theme park"],
    venue: "Bayside Amphitheater, SeaWorld San Diego",
    address: "500 Sea World Dr, San Diego, CA 92109",
    start: "2026-07-11T18:00:00-07:00",
    end: "2026-07-11T19:15:00-07:00",
    price: "With park admission",
    free: false,
    ticketUrl: "https://seaworld.com/san-diego/events/summer-spectacular/concerts/",
    rating: 3.7,
    ratingRationale: "Big name, short set, theme-park logistics.",
    rarity: "common",
  },
  {
    id: "cecil-beaton-sdma-jul11",
    title: "Cecil Beaton's Fashionable World — opening",
    description:
      "Portrait-photography exhibition of the legendary British photographer's 20th-century icons opens at SDMA (museum hours approx. 10–5; also opening: Oriana Poindexter's \"Field Notes\").",
    category: "arts",
    tags: ["art", "museum", "photography", "balboa park"],
    venue: "San Diego Museum of Art",
    address: "1450 El Prado, San Diego, CA 92101",
    start: "2026-07-11T10:00:00-07:00",
    end: "2026-07-11T17:00:00-07:00",
    price: "With museum admission",
    free: false,
    ticketUrl: "https://www.sandiegomuseumofart.org/",
    rating: 3.8,
    ratingRationale: "Strong exhibition opening, ongoing after this weekend.",
    rarity: "common",
  },
  // ---- Sunday Jul 12 ---------------------------------------------------------
  {
    id: "beethoven-by-the-bay-jul12",
    title: "Beethoven by the Bay — San Diego Symphony",
    description:
      "Egmont Overture, the \"Emperor\" Concerto with pianist Parker Van Ostrand, and Symphony No. 4, outdoors at The Shell.",
    category: "music",
    tags: ["classical", "symphony", "outdoors", "waterfront"],
    venue: "The Rady Shell at Jacobs Park",
    address: "222 Marina Park Way, San Diego, CA 92101",
    start: "2026-07-12T19:30:00-07:00",
    end: "2026-07-12T21:45:00-07:00",
    price: "Varies",
    free: false,
    ticketUrl: "https://www.theshell.org/performances/beethoven-by-the-bay-2026/",
    rating: 4.4,
    ratingRationale: "Full symphony program on the bay to close the weekend.",
    rarity: "notable",
  },
  {
    id: "coronado-promenade-concerts-jul12",
    title: "Coronado Promenade Concerts",
    description:
      "Free Sunday concerts-in-the-park series (through Labor Day). This week: high-energy rock covers from The Pine Mountain Logs.",
    category: "music",
    tags: ["live music", "free", "family", "outdoors", "picnic"],
    venue: "Spreckels Park",
    address: "601 Orange Ave, Coronado, CA 92118",
    start: "2026-07-12T18:00:00-07:00",
    end: "2026-07-12T19:30:00-07:00",
    recurrence: "FREQ=WEEKLY;BYDAY=SU;UNTIL=20260908T065959Z",
    price: "Free",
    free: true,
    ticketUrl: "https://coronadoconcert.com/coronado-concert-schedule/",
    rating: 4.0,
    ratingRationale: "Classic Coronado Sunday — picnic blankets by 4 PM.",
    rarity: "common",
  },
  {
    id: "spreckels-organ-sunday-jul12",
    title: "Spreckels Organ Sunday Concert",
    description:
      "The world's largest outdoor pipe organ in its weekly civic concert — a Balboa Park tradition since 1917. (Monday-night Summer Organ Festival starts Jul 13.)",
    category: "music",
    tags: ["organ", "free", "balboa park", "family", "history"],
    venue: "Spreckels Organ Pavilion",
    address: "Pan American Rd E, Balboa Park, San Diego, CA 92101",
    start: "2026-07-12T14:00:00-07:00",
    end: "2026-07-12T15:00:00-07:00",
    recurrence: "FREQ=WEEKLY;BYDAY=SU",
    price: "Free",
    free: true,
    ticketUrl: "https://www.spreckelsorgan.org/",
    rating: 3.9,
    ratingRationale: "Free, iconic, and exactly one hour — an easy yes.",
    rarity: "common",
  },
  {
    id: "dylan-leblanc-casbah-jul12",
    title: "Dylan LeBlanc at The Casbah",
    description:
      "Muscle Shoals-bred singer-songwriter brings his gothic-Americana songcraft to an intimate room, with Olivia Wolf. Doors 7, show 8. 21+.",
    category: "music",
    tags: ["live music", "americana", "singer-songwriter", "nightlife"],
    venue: "The Casbah",
    address: "2501 Kettner Blvd, San Diego, CA 92101",
    start: "2026-07-12T20:00:00-07:00",
    end: "2026-07-12T22:30:00-07:00",
    price: "$20–25",
    free: false,
    ticketUrl: "https://www.casbahmusic.com/calendar/",
    rating: 4.1,
    ratingRationale: "Songwriter's songwriter in the town's best small room.",
    rarity: "common",
  },
];

/**
 * Seeded weekly staples that predate the recurrence column: re-anchor to this
 * week's verified occurrence and attach the rule. dedupe_key moves to the
 * series form so a future events.json re-seed can't duplicate them.
 */
const REPAIRS: {
  id: string;
  title: string;
  start: string;
  end: string;
  recurrence: string;
}[] = [
  {
    // Tue–Thu 6:30–7:30 PM, series runs Jun 16 – Aug 27, 2026
    id: "twilight-in-the-park-y7z8a9",
    title: "Twilight in the Park: Spreckels Organ Concert",
    start: "2026-07-07T18:30:00-07:00",
    end: "2026-07-07T19:30:00-07:00",
    recurrence: "FREQ=WEEKLY;BYDAY=TU,WE,TH;UNTIL=20260828T065959Z",
  },
  {
    // Wednesdays alongside the OB farmers market, sunset peak
    id: "ob-drum-circle-n4o5p6",
    title: "Ocean Beach Sunset Drum Circle",
    start: "2026-07-08T18:00:00-07:00",
    end: "2026-07-08T21:30:00-07:00",
    recurrence: "FREQ=WEEKLY;BYDAY=WE",
  },
  {
    // Weekly Friday evening series in Balboa Park
    id: "balboa-food-truck-friday-q7r8s9",
    title: "Food Truck Friday in Balboa Park",
    start: "2026-07-10T16:00:00-07:00",
    end: "2026-07-10T20:00:00-07:00",
    recurrence: "FREQ=WEEKLY;BYDAY=FR",
  },
];

await db
  .from("sources")
  .upsert(
    {
      id: SOURCE_ID,
      name: "Verified web research",
      address: "",
      kind: "manual",
      note: "Events verified against venue calendars and official sites.",
      active: false,
    },
    { onConflict: "id", ignoreDuplicates: true },
  )
  .throwOnError();

let inserted = 0;
for (const e of EVENTS) {
  let lngLat = e.lngLat;
  if (!lngLat) {
    const hit = await geocode(e.address ?? e.venue, SD_CENTER);
    if (!hit) throw new Error(`geocode failed for ${e.id}: ${e.address ?? e.venue}`);
    lngLat = [hit.lng, hit.lat];
  }
  const recurrence = normalizeRRule(e.recurrence);
  const { data } = await db
    .from("events")
    .upsert(
      {
        id: e.id,
        title: e.title,
        description: e.description,
        category: e.category,
        tags: e.tags,
        venue: e.venue,
        address: e.address ?? null,
        lng: lngLat[0],
        lat: lngLat[1],
        starts_at: e.start,
        ends_at: e.end,
        recurrence,
        price: e.price,
        is_free: e.free,
        ticket_url: e.ticketUrl ?? null,
        ticket_provider: null,
        source_id: SOURCE_ID,
        source_kind: "manual",
        rating: e.rating,
        rating_rationale: e.ratingRationale,
        promoted: false,
        rarity: e.rarity,
        dedupe_key: eventKey({ title: e.title, start: e.start, recurrence: e.recurrence }, TZ),
      },
      { onConflict: "dedupe_key", ignoreDuplicates: true },
    )
    .select("id")
    .throwOnError();
  if (data?.length) inserted++;
}
console.log(`events: ${inserted}/${EVENTS.length} inserted (rest already present)`);

for (const r of REPAIRS) {
  await db
    .from("events")
    .update({
      starts_at: r.start,
      ends_at: r.end,
      recurrence: normalizeRRule(r.recurrence),
      dedupe_key: eventKey({ title: r.title, start: r.start, recurrence: r.recurrence }, TZ),
    })
    .eq("id", r.id)
    .throwOnError();
  console.log(`repaired recurrence: ${r.id}`);
}

console.log("done.");
