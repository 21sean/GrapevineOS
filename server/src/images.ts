/**
 * Event artwork, the no-paid-APIs way: events are text-only out of the LLM,
 * but most ticket/source pages carry an og:image. After ingest we fetch each
 * event's ticketUrl, lift the social-preview image, and store its URL plus a
 * dominant color — the color paints cards before (or without) the image, so
 * nothing flashes white on a slow network.
 *
 * Decoding stays pure-JS (jpeg-js / pngjs) and sampled, so a poster costs a
 * few ms; webp/avif and oversized files just skip the color and keep the URL.
 * Everything here is best-effort: an event without artwork is still an event.
 */
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { isBlockedUrl } from "./agent/websearch.js";
import { store } from "./store.js";
import type { CityEvent } from "./types.js";
import { logger } from "./log.js";

const log = logger("images");

const PAGE_TIMEOUT_MS = 12_000;
const IMAGE_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 500_000; // og tags live in <head> — no need for the body
const MAX_IMAGE_BYTES = 8_000_000;
const CONCURRENCY = 3;

const UA =
  "Mozilla/5.0 (compatible; GrapevineBot/0.1; +https://github.com/grapevine) " +
  "AppleWebKit/537.36 (KHTML, like Gecko)";

async function fetchText(url: string, maxBytes: number, timeoutMs: number): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok || !res.body) throw new Error(`${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * og:image URLs that are plainly a site-level default — a logo, a share card,
 * a placeholder — rather than art for one event. Web-discovered events all
 * carry the same aggregator page as their sourceUrl, whose og:image is exactly
 * this kind of generic banner; catching it by name is the cheap first line of
 * defense before the frequency guards below.
 */
const GENERIC_IMAGE_RE =
  /(?:^|[/_-])(?:og[-_]?default|default[-_]?(?:og|image|share|social|thumb)|social[-_]?(?:card|share|default|preview)|share[-_]?(?:image|card|default)|placeholder|fallback|logo|sprite|favicon|site[-_]?(?:image|banner)|banner[-_]?default|opengraph[-_]?default)(?:[/_.-]|$)/i;

export function looksGenericImageUrl(url: string): boolean {
  return GENERIC_IMAGE_RE.test(url);
}

/** og:image / twitter:image / link rel=image_src, resolved against the page. */
export function extractImageUrl(html: string, pageUrl: string): string | null {
  const metas = [
    /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["']/i,
    // content-before-property attribute order
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["']/i,
    /<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/i,
  ];
  for (const re of metas) {
    const m = re.exec(html);
    if (!m) continue;
    const raw = m[1].replace(/&amp;/g, "&").trim();
    try {
      const url = new URL(raw, pageUrl);
      if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    } catch {
      /* malformed url in the tag — try the next pattern */
    }
  }
  return null;
}

/**
 * Average color of a jpeg/png, sampled on a grid — close enough to "dominant"
 * for a background wash, without a clustering pass. Null for formats the
 * pure-JS decoders don't speak (webp, avif, gif).
 */
export function dominantColor(bytes: Buffer, contentType: string): string | null {
  let pixels: { data: Buffer | Uint8Array; width: number; height: number };
  try {
    if (/jpe?g/i.test(contentType) || (bytes[0] === 0xff && bytes[1] === 0xd8)) {
      pixels = jpeg.decode(bytes, { maxMemoryUsageInMB: 128, formatAsRGBA: true });
    } else if (/png/i.test(contentType) || bytes.subarray(1, 4).toString() === "PNG") {
      pixels = PNG.sync.read(bytes);
    } else {
      return null;
    }
  } catch {
    return null;
  }
  const { data, width, height } = pixels;
  if (!width || !height) return null;
  // ~4k samples regardless of image size
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 4096)));
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue; // transparent pixels say nothing
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  if (!n) return null;
  const hex = (v: number) =>
    Math.round(v / n)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

async function fetchImage(url: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    headers: { "User-Agent": UA, Accept: "image/*" },
    redirect: "follow",
  });
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") ?? "";
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_IMAGE_BYTES) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) return null;
  return { bytes: buf, contentType };
}

/** The page an event's artwork is scraped from — its own ticket page first. */
const pageOf = (e: CityEvent) => e.ticketUrl ?? e.sourceUrl ?? "";

/** Scrape one event's page; returns the artwork patch (or null). No write. */
async function scrapeImage(
  e: CityEvent,
): Promise<{ imageUrl: string; imageColor?: string } | null> {
  // Ticket page first; web-discovered events fall back to the page they
  // were verified against. Both come from LLM extraction over untrusted
  // newsletter/web content, so gate them (and the og:image they yield) against
  // the same SSRF guard the agent's page reader uses — an event field must not
  // aim this fetch at localhost or a private-range host.
  const pageUrl = pageOf(e);
  if (!pageUrl || isBlockedUrl(pageUrl)) return null;
  const html = await fetchText(pageUrl, MAX_HTML_BYTES, PAGE_TIMEOUT_MS).catch(() => null);
  if (!html) return null;
  const imageUrl = extractImageUrl(html, pageUrl);
  if (!imageUrl || isBlockedUrl(imageUrl) || looksGenericImageUrl(imageUrl)) return null;
  const img = await fetchImage(imageUrl).catch(() => null);
  const color = img ? dominantColor(img.bytes, img.contentType) : null;
  return { imageUrl, ...(color && { imageColor: color }) };
}

/**
 * Fire-and-forget artwork pass over freshly ingested events. Never throws —
 * ingest already succeeded; this only decorates it.
 *
 * A real event page has one og:image that belongs to that event. An aggregator
 * ("things to do in San Diego this week") has one generic banner that every
 * event scraped from it would inherit — that's the stock skyline showing up on
 * everything. Two frequency guards keep it off the map: skip any page that
 * backs more than one event, and skip an og:image another event already carries.
 */
export async function enrichEventImages(events: CityEvent[]): Promise<number> {
  // The passed events are already persisted (commitIngest writes before
  // enriching), so the catalog is the full picture — page and image counts
  // built from it already include this batch.
  const catalog = await store.events().catch(() => [] as CityEvent[]);
  const pageCount = new Map<string, number>();
  const usedImages = new Map<string, number>();
  for (const e of catalog) {
    const p = pageOf(e);
    if (p) pageCount.set(p, (pageCount.get(p) ?? 0) + 1);
    if (e.imageUrl) usedImages.set(e.imageUrl, (usedImages.get(e.imageUrl) ?? 0) + 1);
  }

  // Only events whose source page is theirs alone are worth scraping — a page
  // shared by 2+ events can only yield one image for all of them.
  const queue = events.filter(
    (e) => pageOf(e) && !e.imageUrl && (pageCount.get(pageOf(e)) ?? 0) <= 1,
  );
  let enriched = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      try {
        const patch = await scrapeImage(e);
        if (!patch) continue;
        // Another event (or a sibling worker this run) already claimed this
        // exact image — that proves it's a shared banner, not event art.
        if ((usedImages.get(patch.imageUrl) ?? 0) >= 1) continue;
        usedImages.set(patch.imageUrl, 1);
        await store.updateEvent(e.id, patch);
        enriched++;
      } catch {
        /* page down, image gone — the event stays text-only */
      }
    }
  });
  await Promise.all(workers);
  if (enriched) log.info(`images: ${enriched}/${events.length} events got artwork`);
  return enriched;
}

/**
 * Clear artwork that turned out to be generic: any og:image carried by 2+
 * events is a shared site banner, not art for any one of them. Self-heals a
 * catalog already polluted by the stock-skyline problem. Returns how many
 * events were stripped back to text-only.
 */
export async function pruneGenericImages(): Promise<number> {
  const events = await store.events();
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.imageUrl) counts.set(e.imageUrl, (counts.get(e.imageUrl) ?? 0) + 1);
  }
  const generic = new Set([...counts.entries()].filter(([, n]) => n >= 2).map(([url]) => url));
  let cleared = 0;
  for (const e of events) {
    if (e.imageUrl && generic.has(e.imageUrl)) {
      // null clears the column; imageColor goes with it (see updateEvent).
      await store.updateEvent(e.id, {
        imageUrl: null,
        imageColor: null,
      } as unknown as Partial<CityEvent>);
      cleared++;
    }
  }
  if (cleared) log.info(`images: cleared ${cleared} shared/generic banners`);
  return cleared;
}

/** Backfill artwork for the whole catalog (admin action / one-off). */
export async function backfillImages(): Promise<{
  scanned: number;
  enriched: number;
  pruned: number;
}> {
  // Clear already-shared banners first so their events re-enter the queue and
  // get a fresh, per-event shot at real artwork.
  const pruned = await pruneGenericImages();
  const events = (await store.events()).filter((e) => pageOf(e) && !e.imageUrl);
  const enriched = await enrichEventImages(events);
  return { scanned: events.length, enriched, pruned };
}
