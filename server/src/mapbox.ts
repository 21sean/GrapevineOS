/**
 * Server-side Mapbox calls using the SECRET token.
 * Per mapbox-token-security: sk. tokens never reach the browser —
 * the web app talks to these endpoints instead.
 *
 * Both calls are cached to stay far inside the free tier:
 *  - geocode: permanent (geocode_cache table) — venues don't move; misses
 *    are cached too (null lng/lat) so a bad venue string is billed once
 *  - eta: 10-minute in-memory TTL — traffic-aware, so it shouldn't live forever
 */
import { db } from "./db.js";

function token(): string {
  const t = process.env.MAPBOX_SECRET_TOKEN;
  if (!t) throw new Error("MAPBOX_SECRET_TOKEN is not set");
  return t;
}

// ---------- caches ----------

const ETA_TTL_MS = 10 * 60 * 1000;
const etaCache = new Map<string, { at: number; value: Eta | null }>();

// Per-process memo in front of the table: repeat lookups in one session
// (ingest batches hit the same venue over and over) cost zero round trips.
// Capped so a long-running server can't grow it without bound.
const GEO_MEMO_MAX = 5000;
const geoMemo = new Map<string, GeocodeHit | null>();

function memoSet(key: string, value: GeocodeHit | null): void {
  if (geoMemo.size >= GEO_MEMO_MAX) {
    const oldest = geoMemo.keys().next().value;
    if (oldest !== undefined) geoMemo.delete(oldest);
  }
  geoMemo.set(key, value);
}

/** ~110 m grid so nearby origins share an ETA cache entry. */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

// ---------- directions ----------

export interface Eta {
  minutes: number;
  km: number;
}

/** Traffic-aware driving ETA between two [lng, lat] points. */
export async function eta(
  from: [number, number],
  to: [number, number],
): Promise<Eta | null> {
  const key = [round3(from[0]), round3(from[1]), round3(to[0]), round3(to[1])].join(",");
  const hit = etaCache.get(key);
  if (hit && Date.now() - hit.at < ETA_TTL_MS) return hit.value;

  const coords = `${from[0]},${from[1]};${to[0]},${to[1]}`;
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}` +
    `?overview=false&access_token=${token()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return hit?.value ?? null; // stale-if-error
  const body = (await res.json()) as any;
  const route = body.routes?.[0];
  const value: Eta | null = route
    ? {
        minutes: Math.round(route.duration / 60),
        km: Math.round(route.distance / 100) / 10,
      }
    : null;
  etaCache.set(key, { at: Date.now(), value });
  return value;
}

// ---------- geocoding ----------

export interface GeocodeHit {
  lng: number;
  lat: number;
  name: string;
}

// Half-size of the geocoding box around the city center, in degrees. Wide
// enough to cover the metro (Del Mar/Escondido to Chula Vista) but tight enough
// that a vague venue string ("Adams Avenue") can't resolve to another country.
const GEO_BBOX_LON = 0.75;
const GEO_BBOX_LAT = 0.65;

/**
 * Forward-geocode a venue/address, constrained to the city's bounding box.
 * proximity biases ranking; the bbox + country hard-limit it so a loose venue
 * name can't land halfway across the world.
 *
 * Returns null only for a genuine "no such place" (cached, so a bad venue
 * string is billed once). Transport failures — rate limits, 5xx, timeouts —
 * THROW instead, so callers can tell "this venue doesn't geocode" apart from
 * "Mapbox is down" and retry rather than silently dropping an event.
 */
export async function geocode(
  q: string,
  proximity: [number, number],
): Promise<GeocodeHit | null> {
  const [cx, cy] = proximity;
  // The answer depends on the search box, so the box is part of the key —
  // an admin re-centering the app can't be served another city's hits.
  const key = `${q.trim().toLowerCase()}@${round3(cx)},${round3(cy)}`;
  if (geoMemo.has(key)) return geoMemo.get(key)!;

  const { data: cached } = await db
    .from("geocode_cache")
    .select("*")
    .eq("query", key)
    .maybeSingle()
    .throwOnError();
  if (cached) {
    const value: GeocodeHit | null =
      cached.lng !== null && cached.lat !== null
        ? { lng: cached.lng, lat: cached.lat, name: cached.name }
        : null;
    memoSet(key, value);
    return value;
  }

  const bbox = [cx - GEO_BBOX_LON, cy - GEO_BBOX_LAT, cx + GEO_BBOX_LON, cy + GEO_BBOX_LAT].join(",");
  const url =
    `https://api.mapbox.com/search/geocode/v6/forward` +
    `?q=${encodeURIComponent(q)}&proximity=${cx},${cy}` +
    `&bbox=${bbox}&country=us&limit=1&access_token=${token()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    throw new Error(`geocode failed for "${q}": HTTP ${res.status}`);
  }
  const body = (await res.json()) as any;
  const feat = body.features?.[0];
  const value: GeocodeHit | null = feat
    ? {
        lng: feat.geometry.coordinates[0],
        lat: feat.geometry.coordinates[1],
        name: feat.properties?.full_address ?? q,
      }
    : null;
  memoSet(key, value);
  // Cache persistence is best-effort — a failed write just re-geocodes later.
  await db
    .from("geocode_cache")
    .upsert(
      { query: key, lng: value?.lng ?? null, lat: value?.lat ?? null, name: value?.name ?? "" },
      { onConflict: "query", ignoreDuplicates: true },
    );
  return value;
}
