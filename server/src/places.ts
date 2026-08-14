/**
 * Mapbox Places API (public preview): the venue intelligence behind an event's
 * detail panel. Two hops, both cached:
 *
 *   1. Search Box `/forward` resolves "Soda Bar" near the event's coordinates
 *      to a `mapbox_id`
 *   2. Places `/details/retrieve/{id}` returns the Place record for that id
 *
 * Two hard limits from the preview shape this whole file:
 *
 *  - **Quota.** 1,000 records per account per month. That is small enough that
 *    details are fetched lazily (only when someone opens a detail panel) and
 *    behind a budget guard, never during ingest. Ingest still geocodes through
 *    mapbox.ts as before.
 *  - **Terms.** Places data is "for temporary display and use only"; storing it
 *    needs a separate agreement with Mapbox. So this cache is deliberately
 *    in-memory only — unlike geocoding, none of it goes in `geocode_cache` or
 *    any other table, and it evaporates on restart by design.
 *
 * The token also needs the `places:read` scope, which is not on a default
 * secret token: a 403 here means the scope is missing, and it is reported as
 * such rather than swallowed as "no data".
 */
import type { VenueDetails, VenuePhoto } from "./types.js";

function token(): string {
  const t = process.env.MAPBOX_SECRET_TOKEN;
  if (!t) throw new Error("MAPBOX_SECRET_TOKEN is not set");
  return t;
}

// ---------- quota guard ----------

/**
 * Public preview allows 1,000 records per account per month; we stop short of
 * it so an unattended scheduler can never eat the whole allowance. The counter
 * is per-process (same reason as the cache: nothing is persisted), so it is a
 * safety rail rather than an exact ledger — a restart forgets what was spent.
 */
const MONTHLY_CAP = Math.max(0, Number(process.env.MAPBOX_PLACES_MONTHLY_CAP ?? 900));

let spend = { month: "", records: 0 };

function budget(): { month: string; records: number } {
  const month = new Date().toISOString().slice(0, 7);
  if (spend.month !== month) spend = { month, records: 0 };
  return spend;
}

/** Records billed this month against the cap, for the admin/system readout. */
export function placesBudget(): { used: number; cap: number; month: string } {
  const b = budget();
  return { used: b.records, cap: MONTHLY_CAP, month: b.month };
}

// ---------- caches (memory only — see the file header) ----------

const DETAILS_TTL_MS = 12 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000; // re-ask about an unknown venue at most hourly
const CACHE_MAX = 500;

const detailsCache = new Map<string, { at: number; value: VenueDetails | null }>();
/** venue key to mapbox_id, or null when Search Box knows no such POI. */
const idCache = new Map<string, string | null>();

function cacheSet<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.size >= CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Drop everything — the admin "refresh venue data" escape hatch. */
export function clearPlacesCache(): void {
  detailsCache.clear();
  idCache.clear();
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
 * How far a matched POI may sit from the event's own coordinates before we
 * call it a different place. Event coordinates come from forward-geocoding a
 * venue string, so some slack is right, but not enough to grab the bar across
 * the street and show its hours as this venue's.
 */
const MATCH_RADIUS_M = 500;

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
 * keep only those near the event, and pick the best name match among them,
 * breaking ties by distance. Name beats distance on purpose, otherwise
 * "Petco Park" resolves to the taco stand two metres closer to the gate.
 */
async function resolveId(venue: string, at: [number, number]): Promise<string | null> {
  const key = `${venue.trim().toLowerCase()}@${round3(at[0])},${round3(at[1])}`;
  if (idCache.has(key)) return idCache.get(key)!;

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
    // A hit that lands somewhere else entirely is a miss, not a match.
    if (away > MATCH_RADIUS_M) continue;
    candidates.push({ id, rank: nameRank(venue, String(feat.properties?.name ?? "")), away });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.away - b.away);

  const value = candidates[0]?.id ?? null;
  cacheSet(idCache, key, value);
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

/**
 * Fetch and project one Place record. Counts against the monthly budget only
 * when Mapbox actually returns a record (the preview bills per record
 * returned, so a 404 is free).
 */
async function fetchDetails(mapboxId: string): Promise<VenueDetails | null> {
  const b = budget();
  if (b.records >= MONTHLY_CAP) {
    throw new PlacesQuotaError(
      `Mapbox Places budget spent for ${b.month} (${b.records}/${MONTHLY_CAP} records)`,
    );
  }

  const url =
    `https://api.mapbox.com/places/v1/details/retrieve/${encodeURIComponent(mapboxId)}` +
    `?access_token=${token()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

  if (res.status === 404 || res.status === 422) return null; // unknown/bad id, not billed
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
  b.records += 1;

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
 * for it. Cached in memory; misses are cached (briefly) too so a venue with no
 * Places record does not re-spend the budget on every panel open.
 */
export async function venueDetails(
  venue: string,
  at: [number, number],
): Promise<VenueDetails | null> {
  const name = venue.trim();
  if (!name) return null;

  const key = `${name.toLowerCase()}@${round3(at[0])},${round3(at[1])}`;
  const hit = detailsCache.get(key);
  if (hit) {
    const ttl = hit.value ? DETAILS_TTL_MS : MISS_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.value;
  }

  const id = await resolveId(name, at);
  if (!id) {
    cacheSet(detailsCache, key, { at: Date.now(), value: null });
    return null;
  }

  try {
    const value = await fetchDetails(id);
    cacheSet(detailsCache, key, { at: Date.now(), value });
    return value;
  } catch (err) {
    // Budget/scope problems are configuration, not "this venue has no data" —
    // serve a stale record if we have one, otherwise let the caller report it.
    if (hit) return hit.value;
    throw err;
  }
}
