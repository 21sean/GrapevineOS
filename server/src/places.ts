/**
 * Mapbox Places API (public preview): the venue intelligence behind an event's
 * detail panel. Two hops, both cached in Postgres:
 *
 *   1. Search Box `/forward` resolves "Soda Bar" near the event's coordinates
 *      to a `mapbox_id`, kept in `place_lookups` (kind `poi`)
 *   2. Places `/details/retrieve/{id}` returns the Place record for that id,
 *      projected down to what the card renders and kept in `place_details`
 *
 * Both hops share one read: `venue_cache()` left-joins them, so a warm venue
 * costs a single round trip and a cold one tells us in the same query whether
 * the id is already known.
 *
 * The preview allows 1,000 records per account per month, so details are
 * fetched lazily — only when someone opens a detail panel, never during ingest
 * — and once fetched they are kept. `place_details` is permanent storage, not
 * a TTL cache: rows are never purged, a stored record is always served, and
 * age only decides when to refresh it (see `REFRESH_AFTER_MS`). Mapbox
 * describes this data as "for temporary display and use only" and asks for a
 * separate agreement to store it; keeping it is a deliberate call made here.
 *
 * The token also needs the `places:read` scope, which is not on a default
 * secret token: a 403 here means the scope is missing, and it is reported as
 * such rather than swallowed as "no data".
 */
import { db } from "./db.js";
import type { Json } from "./db-types.js";
import type { VenueDetails, VenuePhoto } from "./types.js";

function token(): string {
  const t = process.env.MAPBOX_SECRET_TOKEN;
  if (!t) throw new Error("MAPBOX_SECRET_TOKEN is not set");
  return t;
}

// ---------- cache policy ----------

/**
 * Records are kept permanently: nothing expires them and no job deletes them.
 * A stored record is always served, however old it is — the venue card showing
 * last month's hours beats the card not showing at all, and it means a venue
 * costs the preview quota once rather than once a fortnight.
 *
 * Age only decides when to refresh: past this, the next panel open re-fetches
 * (and falls back to the stored copy if Mapbox is unreachable). Venue hours
 * move slowly, so monthly is plenty.
 */
const REFRESH_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Misses are the exception — an absent record may appear, so re-ask hourly. */
const MISS_TTL_MS = 60 * 60 * 1000;

const age = (at: string | null) => (at ? Date.now() - Date.parse(at) : Infinity);

/**
 * Concurrent opens of the same venue while it is cold — a shared link doing
 * the rounds — collapse into one resolve-and-fetch instead of racing each
 * other to buy the same record twice. Purely a dedupe: nothing is remembered
 * here past the request, the cache is Postgres.
 */
const inflight = new Map<string, Promise<VenueDetails | null>>();

/** Drop the venue cache — the admin "refresh venue data" escape hatch. */
export async function clearPlacesCache(): Promise<void> {
  await db.from("place_details").delete().neq("mapbox_id", "").throwOnError();
  await db.from("place_lookups").delete().eq("kind", "poi").throwOnError();
}

// ---------- venue resolution ----------

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Metres between two [lng, lat] points. */
function metres(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(a[0] - b[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * How far a matched POI may sit from the event's own coordinates before we call
 * it a different place — and the radius depends on how much the name tells us,
 * because an event's coordinates are not evidence you can lean on.
 *
 * They come from geocoding whatever address the newsletter printed, and that
 * address is sometimes simply wrong: every seeded Observatory North Park show
 * carried a downtown address, putting the event 4.6 km from the venue actually
 * named in its own title. Trusting the point absolutely means the venue with
 * the most events in the city silently has no card, and nothing ever says why.
 *
 * So the point is corroboration, not truth:
 *
 *  - a candidate whose NAME answers the query is accepted anywhere in the metro
 *    (`NAMED_RADIUS_M`) — "The Observatory North Park" matching a POI called
 *    The Observatory North Park is the venue, whatever the event row claims
 *  - a candidate whose name says nothing ("Bayard St between Garnet and
 *    Hornblend") has only the coordinates going for it, so it stays on the
 *    tight radius — otherwise a vague location grabs a POI across town
 *
 * Both are still ranked name-first, distance-second, so a nearby exact match
 * always wins over a far one.
 */
const MATCH_RADIUS_M = 500;
const NAMED_RADIUS_M = 25000;

/** Loose comparison key: "The Casbah!" and "the casbah" should match. */
const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * How well a candidate's name answers the query. 0 is an exact match, 1 is one
 * name containing the other ("Balboa Park" against "Balboa Park Carousel"),
 * 2 is neither.
 */
function nameRank(wanted: string, candidate: string): number {
  const a = normalise(wanted);
  const b = normalise(candidate);
  if (!b) return 2;
  if (a === b) return 0;
  return a.includes(b) || b.includes(a) ? 1 : 2;
}

/**
 * Resolve a venue name near a point to a Places `mapbox_id`. Search Box
 * `/forward` is billed per request and needs no session token.
 *
 * Search Box ranks by relevance, not distance, and for a venue named after its
 * neighbourhood that is actively wrong: "Balboa Park" returns a brewery a
 * kilometre away ahead of the park itself. So we ask for several candidates,
 * drop the ones too far out for what their name proves (see the radii above),
 * and pick the best name match among the rest, breaking ties by distance. Name
 * beats distance on purpose, otherwise "Petco Park" resolves to the taco stand
 * two metres closer to the gate.
 *
 * The answer — including "no such POI" — is written to `place_lookups` under
 * the caller's key. `created_at` is stamped explicitly so re-resolving an
 * expired miss restarts its clock.
 */
async function resolveId(
  venue: string,
  at: [number, number],
  key: string,
): Promise<string | null> {
  const url =
    `https://api.mapbox.com/search/searchbox/v1/forward` +
    `?q=${encodeURIComponent(venue)}&proximity=${at[0]},${at[1]}` +
    `&types=poi&limit=5&country=us&access_token=${token()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`search box failed: HTTP ${res.status}`);

  const body = (await res.json()) as any;
  const candidates: { id: string; rank: number; away: number }[] = [];
  for (const feat of body.features ?? []) {
    const id: unknown = feat?.properties?.mapbox_id;
    const coords = feat?.geometry?.coordinates;
    if (typeof id !== "string" || !Array.isArray(coords) || coords.length !== 2) continue;
    const away = metres(at, [coords[0], coords[1]]);
    const rank = nameRank(venue, String(feat.properties?.name ?? ""));
    // A hit further out than its name earns is a miss, not a match.
    if (away > (rank === 2 ? MATCH_RADIUS_M : NAMED_RADIUS_M)) continue;
    candidates.push({ id, rank, away });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.away - b.away);

  const value = candidates[0]?.id ?? null;
  await db
    .from("place_lookups")
    .upsert(
      { kind: "poi", query: key, mapbox_id: value, created_at: new Date().toISOString() },
      { onConflict: "kind,query" },
    )
    .throwOnError();
  return value;
}

// ---------- attribute projection ----------

// Generic humanising gets these wrong, so they are spelled out.
const LABEL_OVERRIDES: Record<string, string> = {
  known_with_locals: "Known with locals",
  wi_fi: "Wi-Fi",
  atm: "ATM",
  tv: "TV",
  bbq: "BBQ",
  byob: "BYOB",
  dj: "DJ",
  lgbtq: "LGBTQ",
  ada: "ADA",
};

/** "feature_outdoor_seating" to "Outdoor seating"; prefix already stripped. */
function humanise(key: string): string {
  const override = LABEL_OVERRIDES[key];
  if (override) return override;
  const words = key.split("_").map((w) => LABEL_OVERRIDES[w] ?? w);
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Mapbox reports these as booleans or "true"/"yes" strings depending on source. */
function isTrue(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(true|yes)$/i.test(v.trim());
  return false;
}

/**
 * Which attributes earn a badge, best first. A real record carries roughly
 * forty flags and most are noise for someone deciding whether to go out
 * ("Restroom", "Seating", "Credit card"), so this ranks the ones that actually
 * change the answer and drops the rest. Lower rank wins when a venue has more
 * than we show.
 */
const FEATURE_RANKS: { rank: number; test: (key: string) => boolean; strip?: RegExp }[] = [
  // Grapevine's whole thesis, handed to us as a boolean.
  { rank: 0, test: (k) => k === "known_with_locals" },
  { rank: 1, test: (k) => k.startsWith("offering_live"), strip: /^offering_/ },
  { rank: 2, test: (k) => k.startsWith("activity_"), strip: /^activity_/ },
  { rank: 3, test: (k) => k.startsWith("environment_"), strip: /^environment_/ },
  { rank: 4, test: (k) => k.startsWith("feature_"), strip: /^feature_/ },
  { rank: 5, test: (k) => k.startsWith("known_for_"), strip: /^known_for_/ },
  { rank: 6, test: (k) => k.startsWith("offering_"), strip: /^offering_/ },
  { rank: 7, test: (k) => /_friendly$/.test(k) },
];

// True but not worth the space: every venue has a restroom and somewhere to sit.
const FEATURE_SUPPRESS = new Set([
  "feature_restroom",
  "feature_unisex_restroom",
  "feature_seating",
  "feature_parking",
]);

const MAX_FEATURES = 8;

/**
 * Pull the attributes worth showing out of the (large, open-ended) attributes
 * object. Only true flags survive: a venue missing an attribute and a venue
 * with it explicitly false both mean "do not claim this", which matters most
 * for accessibility, where a wrong claim is worse than no claim at all.
 */
function projectAttributes(attrs: Record<string, unknown> | undefined): {
  accessibility: string[];
  features: string[];
  priceLevel?: string;
} {
  const accessibility: string[] = [];
  // Keyed by label so "known_for_beer" and "offering_beer" don't both show up.
  const features = new Map<string, number>();
  let priceLevel: string | undefined;

  for (const [rawKey, value] of Object.entries(attrs ?? {})) {
    if (rawKey === "price_level") {
      if (typeof value === "string" && value.trim()) priceLevel = value.trim();
      continue;
    }
    if (!isTrue(value) || FEATURE_SUPPRESS.has(rawKey)) continue;

    if (rawKey.startsWith("accommodation_")) {
      accessibility.push(humanise(rawKey.replace(/^accommodation_/, "")));
      continue;
    }
    const match = FEATURE_RANKS.find((r) => r.test(rawKey));
    if (!match) continue;
    const label = humanise(match.strip ? rawKey.replace(match.strip, "") : rawKey);
    const seen = features.get(label);
    if (seen === undefined || match.rank < seen) features.set(label, match.rank);
  }

  accessibility.sort();
  return {
    accessibility,
    features: [...features.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_FEATURES)
      .map(([label]) => label),
    priceLevel,
  };
}

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** telemetry.activity_score, validated into 7 x 24 numbers or dropped. */
function projectActivity(telemetry: any): Record<string, number[]> | undefined {
  const raw = telemetry?.activity_score;
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, number[]> = {};
  for (const day of WEEKDAYS) {
    const hours = raw[day];
    if (!Array.isArray(hours) || hours.length !== 24) continue;
    if (!hours.every((h: unknown) => typeof h === "number" && Number.isFinite(h))) continue;
    out[day] = hours.map((h: number) => Math.max(0, Math.min(100, h)));
  }
  return Object.keys(out).length ? out : undefined;
}

function projectPhotos(raw: unknown): VenuePhoto[] {
  if (!Array.isArray(raw)) return [];
  const photos: VenuePhoto[] = [];
  for (const p of raw) {
    const url = typeof p?.url === "string" ? p.url : null;
    // Only https — these render as <img> in the panel.
    if (!url || !url.startsWith("https://")) continue;
    photos.push({
      url,
      width: typeof p.width === "number" ? p.width : undefined,
      height: typeof p.height === "number" ? p.height : undefined,
    });
    if (photos.length === 8) break;
  }
  return photos;
}

// ---------- details ----------

export class PlacesScopeError extends Error {}
export class PlacesQuotaError extends Error {}

/** Fetch and project one Place record, or null when Mapbox has none for the id. */
async function fetchDetails(mapboxId: string): Promise<VenueDetails | null> {
  const url =
    `https://api.mapbox.com/places/v1/details/retrieve/${encodeURIComponent(mapboxId)}` +
    `?access_token=${token()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

  if (res.status === 404 || res.status === 422) return null; // unknown/bad id, no record billed
  if (res.status === 403) {
    throw new PlacesScopeError(
      "Mapbox token lacks the places:read scope — add it to MAPBOX_SECRET_TOKEN",
    );
  }
  if (res.status === 429) {
    throw new PlacesQuotaError("Mapbox Places rate limit or monthly quota exceeded");
  }
  if (!res.ok) throw new Error(`places details failed: HTTP ${res.status}`);

  const body = (await res.json()) as any;
  // The single-id GET returns the record itself; tolerate the batch envelope too.
  const rec = body?.results?.[0] ?? body;
  if (!rec?.mapbox_id) return null;

  const { accessibility, features, priceLevel } = projectAttributes(rec.attributes);
  const popularity = rec.score?.popularity;

  return {
    mapboxId: rec.mapbox_id,
    name: typeof rec.name === "string" ? rec.name : "",
    address: typeof rec.full_address === "string" ? rec.full_address : undefined,
    category: typeof rec.primary_category === "string" ? humanise(rec.primary_category) : undefined,
    categories: Array.isArray(rec.categories)
      ? rec.categories.filter((c: unknown) => typeof c === "string").slice(0, 6).map(humanise)
      : [],
    phone: typeof rec.phone === "string" ? rec.phone : undefined,
    website: typeof rec.website === "string" && rec.website.startsWith("http")
      ? rec.website
      : undefined,
    openingHours: typeof rec.opening_hours === "string" ? rec.opening_hours : undefined,
    tz: typeof rec.telemetry?.tags?.timezone === "string" ? rec.telemetry.tags.timezone : undefined,
    popularity: typeof popularity === "number" ? Math.max(0, Math.min(1, popularity)) : undefined,
    priceLevel,
    photos: projectPhotos(rec.photos),
    accessibility,
    features,
    activity: projectActivity(rec.telemetry),
    permanentlyClosed: rec.permanently_closed === true ? true : undefined,
  };
}

/**
 * Venue intelligence for an event's location, or null when Mapbox has nothing
 * for it. Misses are cached (briefly) at both hops, so a venue with no POI and
 * a POI with no Places record each cost one lookup an hour rather than one per
 * panel open.
 */
export async function venueDetails(
  venue: string,
  at: [number, number],
): Promise<VenueDetails | null> {
  const name = venue.trim();
  if (!name) return null;

  const key = `${name.toLowerCase()}@${round3(at[0])},${round3(at[1])}`;
  const running = inflight.get(key);
  if (running) return running;

  const work = resolveVenue(name, at, key).finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}

async function resolveVenue(
  name: string,
  at: [number, number],
  key: string,
): Promise<VenueDetails | null> {
  const { data } = await db.rpc("venue_cache", { p_query: key }).throwOnError();
  const cached = data?.[0];
  const stored = cached?.details ? (cached.details as unknown as VenueDetails) : null;

  if (cached) {
    // A remembered "no such POI" — re-ask occasionally, in case Search Box
    // learns the venue later.
    if (!cached.mapbox_id) {
      if (age(cached.resolved_at) < MISS_TTL_MS) return null;
    } else if (cached.details_at !== null) {
      const ttl = stored ? REFRESH_AFTER_MS : MISS_TTL_MS;
      if (age(cached.details_at) < ttl) return stored;
    }
  }

  const id = cached?.mapbox_id ?? (await resolveId(name, at, key));
  if (!id) return null;

  try {
    const value = await fetchDetails(id);
    await db
      .from("place_details")
      .upsert(
        {
          mapbox_id: id,
          details: value as unknown as Json,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "mapbox_id" },
      )
      .throwOnError();
    return value;
  } catch (err) {
    // Quota/scope problems are configuration, not "this venue has no data" —
    // serve the record due for refresh if we hold one, otherwise let the caller
    // report it and say so in the panel.
    if (stored) return stored;
    throw err;
  }
}
