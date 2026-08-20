/**
 * schema.org/Event harvesting — the deterministic fast path.
 *
 * When a page publishes its events as JSON-LD, the exact start instant, venue,
 * address, price and ticket URL are already there as data. Reading them beats
 * asking a model to infer them from prose: it cannot hallucinate a date, it
 * cannot mis-resolve "next Friday", and it costs nothing.
 *
 * It is NOT a replacement for LLM extraction. A probe of 15 real San Diego
 * sources on 2026-08-02 found event JSON-LD on only 2 of the 11 that were
 * reachable - the aggregator listicles discovery mostly reads publish
 * Organization and BreadcrumbList markup and nothing else. But those two pages
 * carried 74 events between them, all exact. So this runs first and hands
 * whatever it finds to the caller; pages without it fall through to the model
 * exactly as before.
 *
 * What this deliberately does NOT do is judge. Category comes from the
 * schema.org @type (a fact the publisher asserted), but buzz, tags and rarity
 * are opinions, so they are left at neutral defaults for the enrichment pass
 * in discovery.ts to fill in - one batched call per page instead of the
 * extract-then-verify pair the prose path needs.
 */
import { JSDOM } from "jsdom";
import type { Category, CityEvent } from "./types.js";

/** schema.org Event subtypes worth mapping, and the catalog category each
 * implies. Anything else that is still an Event lands in "community". */
const TYPE_CATEGORY: Record<string, Category> = {
  MusicEvent: "music",
  Festival: "festival",
  FoodEvent: "food",
  SportsEvent: "sports",
  TheaterEvent: "arts",
  ScreeningEvent: "arts",
  DanceEvent: "arts",
  ExhibitionEvent: "arts",
  VisualArtsEvent: "arts",
  LiteraryEvent: "arts",
  ComedyEvent: "arts",
  ChildrensEvent: "community",
  SocialEvent: "community",
  EducationEvent: "community",
  BusinessEvent: "community",
  SaleEvent: "market",
  Event: "community",
};

const EVENT_TYPES = new Set(Object.keys(TYPE_CATEGORY));

/** Statuses that mean "do not put this on a map". */
const DEAD_STATUS = /EventCancelled|EventPostponed|EventMovedOnline/i;

/**
 * Read a property whatever form the publisher used for the key.
 *
 * A real JSON-LD processor would expand every term against @context first. That
 * is a heavyweight dependency (and a network fetch for remote contexts) to buy
 * one thing we actually care about: publishers who emit fully-qualified keys
 * like "http://schema.org/startDate" instead of the plain "startDate". Matching
 * on the last path segment, case-insensitively, covers that without either
 * cost. Everything else in the wild uses the plain schema.org term.
 */
function prop(o: Record<string, unknown>, name: string): unknown {
  if (name in o) return o[name];
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(o)) {
    if (k === "@type" || k === "@context") continue;
    const tail = k.slice(Math.max(k.lastIndexOf("/"), k.lastIndexOf("#")) + 1).toLowerCase();
    if (tail === want) return v;
  }
  return undefined;
}

/** Type names likewise arrive bare or fully qualified. */
function typesOf(o: Record<string, unknown>): string[] {
  const t = o["@type"] ?? o["@Type"];
  return (Array.isArray(t) ? t : [t])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.slice(Math.max(x.lastIndexOf("/"), x.lastIndexOf("#")) + 1));
}

/**
 * Walk arbitrary JSON-LD and collect every Event node.
 *
 * Publishers nest these in wildly different ways - bare arrays, @graph,
 * ItemList/itemListElement, subEvent trees - so this recurses through every
 * object value rather than guessing a shape. `seen` guards the cyclic
 * references that @id-based graphs can produce.
 */
function collectEvents(node: unknown, out: Record<string, unknown>[], seen = new Set<unknown>()): void {
  if (Array.isArray(node)) {
    for (const n of node) collectEvents(n, out, seen);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (seen.has(node)) return;
  seen.add(node);
  const o = node as Record<string, unknown>;
  if (typesOf(o).some((t) => EVENT_TYPES.has(t))) out.push(o);
  for (const v of Object.values(o)) {
    if (v && typeof v === "object") collectEvents(v, out, seen);
  }
}

function firstString(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = firstString(x);
      if (s) return s;
    }
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Language-tagged and reference-style values: {"@value": …} / {"name": …}
    return firstString(o["@value"] ?? o.name ?? o.url);
  }
  return undefined;
}

/** schema.org allows a bare date; treat that as local midnight, not UTC. */
function isoOrUndefined(v: unknown): string | undefined {
  const s = firstString(v);
  if (!s) return undefined;
  const withTime = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s;
  return Number.isFinite(Date.parse(withTime)) ? withTime : undefined;
}

function place(o: Record<string, unknown>): { venue: string; address?: string } {
  const loc = prop(o, "location");
  const node = Array.isArray(loc) ? loc[0] : loc;
  if (typeof node === "string") return { venue: node.trim() };
  if (!node || typeof node !== "object") return { venue: "" };
  const l = node as Record<string, unknown>;
  const venue = firstString(prop(l, "name")) ?? "";
  const addr = prop(l, "address");
  if (typeof addr === "string") return { venue, address: addr.trim() };
  if (addr && typeof addr === "object") {
    const a = addr as Record<string, unknown>;
    const parts = ["streetAddress", "addressLocality", "addressRegion", "postalCode"]
      .map((k) => firstString(prop(a, k)))
      .filter((x): x is string => Boolean(x));
    if (parts.length) return { venue, address: parts.join(", ") };
  }
  return { venue };
}

function geo(o: Record<string, unknown>): { lat: number; lng: number } | undefined {
  const rawLoc = prop(o, "location");
  const loc = Array.isArray(rawLoc) ? rawLoc[0] : rawLoc;
  if (!loc || typeof loc !== "object") return undefined;
  const g = prop(loc as Record<string, unknown>, "geo");
  if (!g || typeof g !== "object") return undefined;
  const gg = g as Record<string, unknown>;
  const lat = Number(firstString(prop(gg, "latitude")));
  const lng = Number(firstString(prop(gg, "longitude")));
  // Reject (0,0) too: it is Null Island, never a real venue, and a common
  // placeholder in half-filled markup.
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return undefined;
  return { lat, lng };
}

/** Cheapest offer wins the headline price, matching how listings read. */
function pricing(o: Record<string, unknown>): { price: string; free: boolean; url?: string } {
  const offers = prop(o, "offers");
  const list = (Array.isArray(offers) ? offers : [offers]).filter(
    (x): x is Record<string, unknown> => Boolean(x) && typeof x === "object",
  );
  let low = Number.POSITIVE_INFINITY;
  const currency = "$";
  let url: string | undefined;
  let sawAny = false;
  for (const f of list) {
    url ??= firstString(prop(f, "url"));
    const raw = firstString(prop(f, "price")) ?? firstString(prop(f, "lowPrice"));
    if (raw === undefined) continue;
    const n = Number(raw.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(n)) continue;
    sawAny = true;
    if (n < low) low = n;
  }
  if (!sawAny || !Number.isFinite(low)) return { price: "", free: false, url };
  if (low === 0) return { price: "Free", free: true, url };
  // More than one distinct offer means the low price is a floor.
  const multiple = list.length > 1;
  return { price: `${currency}${low}${multiple ? "+" : ""}`, free: false, url };
}

function httpUrl(v: unknown): string | undefined {
  const s = firstString(v);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : undefined;
  } catch {
    return undefined;
  }
}

/** A candidate carries the facts the page asserted; judgement fields are
 * neutral until the enrichment pass fills them in. */
export type JsonLdCandidate = Omit<CityEvent, "id" | "lng" | "lat"> & {
  lng?: number;
  lat?: number;
  /**
   * Whether the markup pinned this down well enough to be worth preferring
   * over reading the page's prose. False means a bare `startDate: "2026-08-08"`
   * on a single-day event: the listing page knows the day but not the hour,
   * while the visible text usually says "7:30 PM". Listing pages on the big
   * ticketing sites are full of these, so the caller uses it to decide whether
   * structured-first is actually the better path for a given page.
   */
  precise: boolean;
};

function toCandidate(o: Record<string, unknown>, sourceUrl: string): JsonLdCandidate | null {
  const title = firstString(prop(o, "name"));
  const rawStart = firstString(prop(o, "startDate"));
  const start = isoOrUndefined(prop(o, "startDate"));
  if (!title || !start) return null; // no name or no date is not an event listing
  const end = isoOrUndefined(prop(o, "endDate")) ?? start;
  // A multi-day run legitimately has no start hour, so it counts as precise;
  // a single day without one is simply missing the time.
  const hasClock = /\d{2}:\d{2}/.test(rawStart ?? "");
  const spansDays = end.slice(0, 10) > start.slice(0, 10);
  const precise = hasClock || spansDays;
  const status = firstString(prop(o, "eventStatus"));
  if (status && DEAD_STATUS.test(status)) return null;

  const { venue, address } = place(o);
  const coords = geo(o);
  const { price, free, url } = pricing(o);
  const category =
    typesOf(o).map((t) => TYPE_CATEGORY[t]).find((c): c is Category => Boolean(c)) ?? "community";

  const rawPerformer = prop(o, "performer");
  const performers = (Array.isArray(rawPerformer) ? rawPerformer : [rawPerformer])
    .map(firstString)
    .filter((x): x is string => Boolean(x))
    .slice(0, 3);

  return {
    title,
    description: firstString(prop(o, "description"))?.slice(0, 600) ?? "",
    category,
    // Performer names are facts, not opinions, so they are safe as tags; the
    // interest tags proper come from enrichment.
    tags: performers.map((p) => p.toLowerCase()).slice(0, 3),
    venue,
    ...(address && { address }),
    ...(coords && { lat: coords.lat, lng: coords.lng }),
    start,
    end,
    precise,
    price,
    free,
    ...(httpUrl(url ?? prop(o, "url")) && { ticketUrl: httpUrl(url ?? prop(o, "url")) }),
    source: "web-search",
    sourceKind: "search",
    sourceUrl,
    rating: 3,
    promoted: false,
    rarity: "common",
    ...(httpUrl(prop(o, "image")) && { imageUrl: httpUrl(prop(o, "image")) }),
  };
}

/**
 * Pull every usable Event out of a page's JSON-LD. Returns [] for the common
 * case of a page with no event markup, which is the caller's signal to fall
 * back to the model.
 */
export function extractJsonLdEvents(html: string, sourceUrl: string): JsonLdCandidate[] {
  let dom: JSDOM;
  try {
    dom = new JSDOM(html);
  } catch {
    return [];
  }
  const nodes: Record<string, unknown>[] = [];
  for (const block of dom.window.document.querySelectorAll('script[type="application/ld+json"]')) {
    const text = block.textContent?.trim();
    if (!text) continue;
    try {
      collectEvents(JSON.parse(text), nodes);
    } catch {
      // Unescaped newlines inside JSON strings are the usual culprit and are
      // not worth repairing - the page still has its prose path.
    }
  }
  const out: JsonLdCandidate[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    const c = toCandidate(n, sourceUrl);
    if (!c) continue;
    // The same event often appears in both @graph and an ItemList.
    const key = `${c.title.toLowerCase()}|${Date.parse(c.start)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
