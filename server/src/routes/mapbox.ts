/**
 * The Mapbox calls the browser needs (the secret token stays here), each
 * rate-limited per address because each spends quota: directions and
 * isochrones are metered, and the Places preview allows 1,000 records a
 * month. Failures fall through to the error handler.
 */
import { Router } from "express";
import { eta, isochrone } from "../mapbox.js";
import { PlacesQuotaError, PlacesScopeError, venueDetails } from "../places.js";
import { rateLimit } from "../rate-limit.js";
import { store } from "../store.js";

export const mapbox = Router();

// Generous for a person, tight for a loop.
const etaLimit = rateLimit({ name: "eta", windowMs: 60_000, max: 60 });
const isochroneLimit = rateLimit({ name: "isochrone", windowMs: 60_000, max: 20 });
const venueLimit = rateLimit({ name: "venue", windowMs: 60_000, max: 30 });

const parsePair = (s: unknown): [number, number] | null => {
  const parts = String(s ?? "")
    .split(",")
    .map(Number);
  return parts.length === 2 && parts.every(Number.isFinite) ? [parts[0], parts[1]] : null;
};

mapbox.get("/api/eta", etaLimit, async (req, res) => {
  const from = parsePair(req.query.from) ?? (await store.settings()).center;
  const to = parsePair(req.query.to);
  if (!to) return res.status(400).json({ error: "to=lng,lat required" });
  res.json((await eta(from, to)) ?? { minutes: null, km: null });
});

/**
 * "Near me" drive-time contour. The web app filters events to the polygons;
 * the point-in-polygon test happens client-side so one cached contour serves
 * the whole list.
 */
mapbox.get("/api/isochrone", isochroneLimit, async (req, res) => {
  const center = parsePair(req.query.center) ?? (await store.settings()).center;
  const minutes = Number(req.query.minutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) {
    return res.status(400).json({ error: "minutes must be 1-60" });
  }
  res.json((await isochrone(center, minutes)) ?? { polygons: [] });
});

/**
 * Venue intelligence for one event's location (Mapbox Places, public
 * preview): hours, photos, accessibility, and how busy the place usually is.
 *
 * Keyed off an event id rather than a free-text venue on purpose: an open
 * ?venue= proxy would let anyone spend the monthly preview quota on arbitrary
 * lookups. This way only venues already on the map can be asked about, and
 * the answer comes from the Postgres venue cache when it is warm (places.ts).
 */
mapbox.get("/api/events/:id/venue", venueLimit, async (req, res) => {
  const event = await store.eventById(String(req.params.id));
  if (!event) return res.status(404).json({ error: "unknown event" });
  try {
    res.json({ venue: await venueDetails(event.venue, [event.lng, event.lat]) });
  } catch (err) {
    // A missing scope or an exhausted quota is a configuration answer, not a
    // 502: the panel just hides the venue card, and the message says why.
    if (err instanceof PlacesScopeError || err instanceof PlacesQuotaError) {
      return res.status(200).json({ venue: null, unavailable: String(err.message) });
    }
    throw err;
  }
});
