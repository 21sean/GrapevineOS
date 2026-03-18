/**
 * Server-side Mapbox calls using the SECRET token.
 * Per mapbox-token-security: sk. tokens never reach the browser —
 * the web app talks to these endpoints instead.
 *
 * Both calls are cached to stay far inside the free tier:
 *  - geocode: persistent (data/geocache.json) — venues don't move
 *  - eta: 10-minute TTL — traffic-aware, so it shouldn't live forever
 */
import fs from "node:fs";
import path from "node:path";

function token(): string {
  const t = process.env.MAPBOX_SECRET_TOKEN;
  if (!t) throw new Error("MAPBOX_SECRET_TOKEN is not set");
  return t;
}

// ---------- caches ----------

const ETA_TTL_MS = 10 * 60 * 1000;
const etaCache = new Map<string, { at: number; value: Eta | null }>();

const GEOCACHE_FILE = path.resolve(import.meta.dirname, "../data/geocache.json");
let geoCache: Record<string, GeocodeHit | null> | null = null;

function loadGeoCache(): Record<string, GeocodeHit | null> {
  if (geoCache) return geoCache;
  try {
    geoCache = JSON.parse(fs.readFileSync(GEOCACHE_FILE, "utf8"));
  } catch {
    geoCache = {};
  }
  return geoCache!;
}

function saveGeoCache() {
  if (!geoCache) return;
  try {
    fs.writeFileSync(GEOCACHE_FILE, JSON.stringify(geoCache, null, 2));
  } catch {
    /* cache persistence is best-effort */
  }
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

/** Forward-geocode a venue/address, biased toward the city center. */
export async function geocode(
  q: string,
  proximity: [number, number],
): Promise<GeocodeHit | null> {
  const cache = loadGeoCache();
  const key = q.trim().toLowerCase();
  if (key in cache) return cache[key];

  const url =
    `https://api.mapbox.com/search/geocode/v6/forward` +
    `?q=${encodeURIComponent(q)}&proximity=${proximity[0]},${proximity[1]}` +
    `&limit=1&access_token=${token()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null; // don't cache transport errors
  const body = (await res.json()) as any;
  const feat = body.features?.[0];
  const value: GeocodeHit | null = feat
    ? {
        lng: feat.geometry.coordinates[0],
        lat: feat.geometry.coordinates[1],
        name: feat.properties?.full_address ?? q,
      }
    : null;
  cache[key] = value;
  saveGeoCache();
  return value;
}
