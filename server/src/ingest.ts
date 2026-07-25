import crypto from "node:crypto";
import { generateJSON } from "./llm.js";
import { geocode } from "./mapbox.js";
import { normalizeRRule } from "./recurrence.js";
import { store } from "./store.js";
import { CATEGORIES, type Category, type CityEvent, type Rarity } from "./types.js";

/** One rubric for the buzz fields, shared by extraction and re-rating so the
 * two prompts can't drift apart. */
const RATIONALE_MAX = 140;
const BUZZ_RUBRIC = `1.0-5.0, one decimal: how excited actual locals would be. Free community
one-offs (parades, block parties, 5Ks) score high; generic paid promotions score low.`;
const BUZZ_WHY_RUBRIC = `<=${RATIONALE_MAX} chars, blunt, like a jaded local`;
const PROMOTED_RUBRIC = `true if this reads as a paid placement / sponsored plug / overpriced
club promo rather than something a newsletter editor picked`;

const EXTRACTION_SYSTEM = (
  city: string,
  tz: string,
  today: string,
  origin: "newsletter" | "web" = "newsletter",
) => `
You extract local events from ${origin === "web" ? "web pages" : "newsletter emails"} into strict JSON.

City: ${city}. Timezone: ${tz}. Today's date: ${today}.

Return ONLY a JSON object shaped exactly like:
{"events":[{
  "title": string,                    // short, no ALL CAPS, no emoji
  "description": string,              // 1-2 plain sentences, what a local would tell a friend
  "category": one of ${JSON.stringify(CATEGORIES)},
  "tags": string[],                    // 2-5 lowercase interest tags, e.g. "live music","beer","running","family","yoga"
  "venue": string,
  "address": string,                   // street address if present, else venue + city
  "start": string,                     // ISO 8601 WITH timezone offset, resolve relative dates against today.
                                       // For a recurring event, this is the NEXT occurrence on or after today.
  "end": string,                       // ISO 8601; if unknown, estimate a sensible duration
  "recurrence": string|null,           // RFC 5545 RRULE if it repeats on a schedule, else null.
                                       // "every Saturday" -> "FREQ=WEEKLY;BYDAY=SA";
                                       // "weekly" (no day) -> "FREQ=WEEKLY";
                                       // "Tuesdays & Thursdays" -> "FREQ=WEEKLY;BYDAY=TU,TH";
                                       // "every other Friday" -> "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR";
                                       // "daily" -> "FREQ=DAILY". One-off events: null.
  "price": string,                     // "Free", "$15", "$40+" etc
  "free": boolean,
  "ticketUrl": string|null,
  "ticketProvider": string|null,       // "Eventbrite","AXS","Ticketmaster","DICE", venue box office, etc
  "buzz": number,                      // ${BUZZ_RUBRIC.replace(/\n/g, "\n                                       // ")}
  "buzzWhy": string,                   // ${BUZZ_WHY_RUBRIC}
  "promoted": boolean,                 // ${PROMOTED_RUBRIC.replace(/\n/g, "\n                                       // ")}
  "rarity": "common"|"notable"|"rare"  // rare = one-off or annual (parade, fireworks, festival, race);
                                       // notable = special but recurring; common = weekly/anytime
}]}

Rules:
- Only include events happening in or near ${city} with a concrete date.
- Skip ads for products, job posts, classes-in-general, and anything without a when+where.
- Never invent ticket URLs. Use null when absent.
- If the email lists many events, extract each one separately.
- If an event repeats on a schedule (a weekly market, run club, trivia night), emit ONE
  event: set "recurrence" to its RRULE and anchor "start"/"end" to the next occurrence.${
    origin === "web"
      ? `
- The text is ONE web page's readable content and may include navigation junk,
  unrelated links, comments, or stale listings from past years. Extract only
  events this page itself announces with a concrete upcoming date — never
  reconstruct an event from a passing mention or a bare link.`
      : ""
  }`;

export interface ExtractedEvent extends CityEvent {}

export function slugId(title: string, start: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const hash = crypto.createHash("sha1").update(title + start).digest("hex").slice(0, 6);
  return `${slug}-${hash}`;
}

/**
 * Only accept http(s) ticket links. The value is LLM-extracted from untrusted
 * newsletter/web content and later rendered as an <a href> and fetched
 * server-side, so a javascript:/data: URL must never be stored.
 */
function httpUrl(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Run LLM extraction over a raw email or web page, then geocode the venues. */
export async function extractEvents(opts: {
  text: string;
  source: string;
  model?: string;
  /** Provenance stamped on the results; also tunes the prompt. Default: newsletter. */
  sourceKind?: CityEvent["sourceKind"];
  /** Page the text came from — web discovery verifies candidates against it. */
  sourceUrl?: string;
}): Promise<ExtractedEvent[]> {
  const settings = await store.settings();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: settings.tz });
  const raw = await generateJSON({
    system: EXTRACTION_SYSTEM(
      settings.city,
      settings.tz,
      today,
      opts.sourceKind === "search" ? "web" : "newsletter",
    ),
    user: opts.text.slice(0, 24000),
    model: opts.model,
  });

  const items: any[] = Array.isArray(raw) ? raw : raw?.events ?? [];
  const out: ExtractedEvent[] = [];

  for (const it of items) {
    if (!it?.title || !it?.start) continue;
    const category: Category = CATEGORIES.includes(it.category) ? it.category : "community";
    const rarity: Rarity = ["common", "notable", "rare"].includes(it.rarity) ? it.rarity : "common";

    let lng = Number(it.lng);
    let lat = Number(it.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      const q = [it.venue, it.address, settings.city].filter(Boolean).join(", ");
      // A transient geocode failure (rate limit, outage) propagates and fails
      // the whole ingest, so the email row keeps processed_at null and the
      // next kick retries it — a partial batch must not be stamped "done".
      // Only a genuine no-match (null) skips the event.
      const hit = await geocode(q, settings.center);
      if (!hit) continue; // no location, no marker
      lng = hit.lng;
      lat = hit.lat;
    }

    out.push({
      id: slugId(String(it.title), String(it.start)),
      title: String(it.title),
      description: String(it.description ?? ""),
      category,
      tags: Array.isArray(it.tags) ? it.tags.map(String).slice(0, 6) : [],
      venue: String(it.venue ?? ""),
      address: it.address ? String(it.address) : undefined,
      lng,
      lat,
      start: String(it.start),
      end: String(it.end ?? it.start),
      ...(normalizeRRule(it.recurrence) && { recurrence: normalizeRRule(it.recurrence)! }),
      price: String(it.price ?? (it.free ? "Free" : "")),
      free: Boolean(it.free),
      ticketUrl: httpUrl(it.ticketUrl),
      ticketProvider: it.ticketProvider || undefined,
      source: opts.source,
      sourceKind: opts.sourceKind ?? "newsletter",
      ...(opts.sourceUrl && { sourceUrl: opts.sourceUrl }),
      rating: clampRating(it.buzz),
      ratingRationale: it.buzzWhy ? String(it.buzzWhy).slice(0, RATIONALE_MAX) : undefined,
      promoted: Boolean(it.promoted),
      rarity,
    });
  }
  return out;
}

function clampRating(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.round(n * 10) / 10));
}

const RATING_SYSTEM = `
You are a jaded local who has lived in this city for 15 years and reads every
neighborhood subreddit thread. Given an event, estimate how the locals actually
talk about it: is it beloved, decent, or an overpriced tourist/promo trap?

Return ONLY JSON: {"rating": number  // ${BUZZ_RUBRIC},
"rationale": string  // ${BUZZ_WHY_RUBRIC},
"promoted": boolean  // ${PROMOTED_RUBRIC}}`;

export async function rateEvent(e: CityEvent): Promise<{
  rating: number;
  rationale: string;
  promoted: boolean;
}> {
  const raw = await generateJSON({
    system: RATING_SYSTEM,
    user: JSON.stringify({
      title: e.title,
      description: e.description,
      venue: e.venue,
      price: e.price,
      category: e.category,
      tags: e.tags,
      source: e.source,
    }),
  });
  return {
    rating: clampRating(raw.rating),
    rationale: String(raw.rationale ?? "").slice(0, RATIONALE_MAX),
    promoted: Boolean(raw.promoted),
  };
}
