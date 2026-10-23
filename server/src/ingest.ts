import crypto from "node:crypto";
import { MAX_CHUNKS, charsPerChunk } from "./budget.js";
import { chunkDocument } from "./chunk.js";
import { activeProvider, generateJSON } from "./llm.js";
import { geocode } from "./mapbox.js";
import { normalizeRRule } from "./recurrence.js";
import { store } from "./store.js";
import { CATEGORIES, type CityEvent } from "./types.js";
import type { Output } from "./llm/generated.js";

/** One rubric for the buzz fields, shared by extraction and re-rating so the
 * two prompts can't drift apart. */
export const RATIONALE_MAX = 140;
export const BUZZ_RUBRIC = `1.0-5.0, one decimal: how excited actual locals would be. Free community
one-offs (parades, block parties, 5Ks) score high; generic paid promotions score low.`;
export const BUZZ_WHY_RUBRIC = `<=${RATIONALE_MAX} chars, blunt, like a jaded local`;
export const PROMOTED_RUBRIC = `true if this reads as a paid placement / sponsored plug / overpriced
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

export type ExtractedEvent = CityEvent;

export function slugId(title: string, start: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const hash = crypto
    .createHash("sha1")
    .update(title + start)
    .digest("hex")
    .slice(0, 6);
  return `${slug}-${hash}`;
}

/**
 * Only accept http(s) ticket links. The value is LLM-extracted from untrusted
 * newsletter/web content and later rendered as an <a href> and fetched
 * server-side, so a javascript:/data: URL must never be stored.
 */
/** Run LLM extraction over a raw email or web page, then geocode the venues. */
export async function extractEvents(opts: {
  text: string;
  source: string;
  model?: string;
  /** Provenance stamped on the results; also tunes the prompt. Default: newsletter. */
  sourceKind?: CityEvent["sourceKind"];
  /** Page the text came from; web discovery verifies candidates against it. */
  sourceUrl?: string;
}): Promise<ExtractedEvent[]> {
  const settings = await store.settings();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: settings.tz });
  const system = EXTRACTION_SYSTEM(
    settings.city,
    settings.tz,
    today,
    opts.sourceKind === "search" ? "web" : "newsletter",
  );

  // Cover the whole document instead of truncating it. Everything past the
  // model's window used to be dropped in silence, which on a long newsletter
  // meant the back half of the week simply never existed.
  const budget = charsPerChunk(await activeProvider(opts.model));
  const { chunks, dropped } = chunkDocument(opts.text, budget);
  if (dropped > 0) throw new Error(`Document exceeds the ${MAX_CHUNKS}-chunk extraction budget`);
  const items: Output<"extraction">["events"] = [];
  for (const chunk of chunks) {
    const raw = await generateJSON({ task: "extraction", system, user: chunk, model: opts.model });
    items.push(...raw.events);
  }

  const out: ExtractedEvent[] = [];
  const seen = new Set<string>();

  for (const it of items) {
    // Chunks overlap on purpose, so the same event legitimately arrives more
    // than once. Collapse here, before geocoding, so a duplicate never costs
    // a Mapbox lookup.
    const id = slugId(it.title, it.start);
    if (seen.has(id)) continue;
    seen.add(id);
    const hit = await geocode(
      [it.venue, it.address, settings.city].filter(Boolean).join(", "),
      settings.center,
    );
    if (!hit) throw new Error(`No location found for ${it.venue}`);
    const { lng, lat } = hit;

    out.push({
      id,
      title: it.title,
      description: it.description,
      category: it.category,
      tags: it.tags,
      venue: it.venue,
      address: it.address || undefined,
      lng,
      lat,
      start: it.start,
      end: it.end,
      ...(normalizeRRule(it.recurrence) && { recurrence: normalizeRRule(it.recurrence)! }),
      price: it.price,
      free: it.free,
      ticketUrl: it.ticketUrl ?? undefined,
      ticketProvider: it.ticketProvider ?? undefined,
      source: opts.source,
      sourceKind: opts.sourceKind ?? "newsletter",
      ...(opts.sourceUrl && { sourceUrl: opts.sourceUrl }),
      rating: it.buzz,
      ratingRationale: it.buzzWhy,
      promoted: it.promoted,
      rarity: it.rarity,
    });
  }
  return out;
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
    task: "rating",
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
  return raw;
}
