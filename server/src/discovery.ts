/**
 * Web discovery — builds map events from AI web search, with a verification
 * gate between "the model said so" and "it's on the map".
 *
 * One run: web-search the query (scoped to the city) → read the top result
 * pages → LLM-extract event candidates per page (never across pages, so every
 * candidate is attributable to exactly one URL) → verify each candidate:
 *
 *   1. deterministic gates — parseable dates, not in the past, not absurdly
 *      far out, and the title actually appears in the source text (a cheap
 *      hallucination check the model can't talk its way past);
 *   2. an LLM cross-check that re-reads the source page and must either
 *      CONFIRM the event (with a supporting quote), CORRECT a detail the
 *      extractor got wrong, or call it UNSUPPORTED;
 *   3. corroboration — a candidate found on 2+ independent pages clears a
 *      lower confidence bar.
 *
 * Only verified candidates reach store.addEvents (which dedupes against the
 * whole catalog); every run is logged to ingests with kind "search". Saved
 * searches in discovery_searches re-run on a cadence via the scheduler below.
 */
import { scanText } from "./agent/guardrails.js";
import { readPage, webSearch } from "./agent/websearch.js";
import { extractEvents, slugId } from "./ingest.js";
import { generateJSON } from "./llm.js";
import { commitIngest } from "./pipeline.js";
import { eventKey, store } from "./store.js";
import type { CityEvent, DiscoverySearch } from "./types.js";

const MAX_RESULTS = 8; // search hits considered
const MAX_PAGES = 4; // pages actually read per run
const PAGE_CHARS = 12_000; // readable chars fed to extraction/verification
const MIN_PAGE_CHARS = 200; // below this a page has nothing to extract
const MAX_DAYS_OUT = 400; // beyond this a "found" date is suspect

function minConfidence(): number {
  const n = Number(process.env.DISCOVERY_MIN_CONFIDENCE ?? 0.6);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0.6;
}

// ---------------------------------------------------------------------------
// Request-shape helpers shared by every surface that fronts runDiscovery
// (internal API, external agent API, MCP) — one definition of the flag names,
// defaults, and limits, so the three routes can't drift apart.
// ---------------------------------------------------------------------------

export const CADENCE_MIN_HOURS = 1;
export const CADENCE_MAX_HOURS = 336;
export const CADENCE_DEFAULT_HOURS = 24;

/** Clamp cadence to the DB's 1–336 h range; default daily. */
export function clampCadence(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n)
    ? Math.min(Math.max(CADENCE_MIN_HOURS, Math.round(n)), CADENCE_MAX_HOURS)
    : CADENCE_DEFAULT_HOURS;
}

/** Trimmed 3–200 char query, or null when invalid. */
export function validQuery(v: unknown): string | null {
  const q = String(v ?? "").trim();
  return q.length >= 3 && q.length <= 200 ? q : null;
}

/**
 * Read the dry-run flag in either spelling (dry_run / dryRun). Omitted means
 * DRY RUN on every surface — committing machine-verified events to the map
 * is always an explicit `dry_run: false`.
 */
export function wantsCommit(body: unknown): boolean {
  const b = (body ?? {}) as Record<string, unknown>;
  return (b.dry_run ?? b.dryRun) === false;
}

export interface DiscoveryCandidate {
  event: CityEvent;
  verdict: "confirmed" | "corrected" | "rejected";
  confidence: number;
  /** Short quote from the source page that names the event (when verified). */
  evidence?: string;
  /** Why a rejected candidate was dropped. */
  reason?: string;
  sourceUrl: string;
  /** How many pages in this run yielded the same event. */
  corroborations: number;
}

export interface DiscoveryRunResult {
  query: string;
  searchedAt: string; // ISO 8601
  pagesRead: { url: string; title: string }[];
  pagesSkipped: { url: string; error: string }[];
  extracted: number;
  verified: DiscoveryCandidate[];
  rejected: DiscoveryCandidate[];
  /** Events actually written (0 on dry runs; dedupe drops known ones). */
  added: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "your", "free",
  "event", "events", "night", "day", "festival", "annual",
]);

/**
 * Cheap hallucination gate: at least half of the title's meaningful tokens
 * must literally appear in the page text the extractor saw. Survivors still
 * face the LLM cross-check; this only removes fabrications early.
 */
function titleOnPage(title: string, pageText: string): boolean {
  const tokens = (title.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(
    (t) => !STOPWORDS.has(t),
  );
  if (!tokens.length) return true; // nothing to test — leave it to the LLM
  const hay = pageText.toLowerCase();
  const found = tokens.filter((t) => hay.includes(t)).length;
  return found * 2 >= tokens.length;
}

/**
 * Is the verifier's supporting quote actually on the page? The prompt demands
 * a verbatim quote, so a real one is a substring; we allow heavy token overlap
 * to survive light reformatting (whitespace, an inserted word). A quote that
 * checks out is evidence we verified ourselves — much harder to fake than a
 * self-reported confidence number, which is why it can bend the floor below.
 */
function evidenceOnPage(quote: string | undefined, pageText: string): boolean {
  const q = (quote ?? "").toLowerCase().trim();
  if (q.length < 8) return false; // too short to mean anything
  const hay = pageText.toLowerCase();
  if (hay.includes(q)) return true;
  const tokens = q.match(/[a-z0-9]{3,}/g) ?? [];
  if (tokens.length < 3) return false;
  const found = tokens.filter((t) => hay.includes(t)).length;
  return found >= Math.ceil(tokens.length * 0.7);
}

/**
 * Does the candidate's own date appear in the page text? A concrete date on the
 * page is strong corroboration the extractor didn't invent or mis-resolve it;
 * for a recurring event the weekday (or a "weekly/every" cue) plays that role.
 * A soft signal that bends the floor, never a hard reject — page date formats
 * vary far too much to fail closed on a miss.
 */
function dateOnPage(e: CityEvent, pageText: string, tz: string): boolean {
  const d = new Date(e.start);
  if (!Number.isFinite(d.getTime())) return false;
  const hay = pageText.toLowerCase();
  const part = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(d).toLowerCase();
  const monthLong = part({ month: "long" });
  const day = part({ day: "numeric" });
  const monthNum = part({ month: "numeric" });
  const candidates = [
    `${monthLong} ${day}`, // july 15
    `${monthLong.slice(0, 3)} ${day}`, // jul 15
    `${day} ${monthLong}`, // 15 july
    `${monthNum}/${day}`, // 7/15
  ];
  if (candidates.some((c) => hay.includes(c))) return true;
  if (e.recurrence) {
    const weekday = part({ weekday: "long" });
    if (hay.includes(weekday) || /\b(weekly|every|each|recurring)\b/.test(hay)) return true;
  }
  return false;
}

/** Deterministic gates. Returns a rejection reason or null to proceed. */
function hardReject(e: CityEvent, pageText: string, now: Date): string | null {
  const start = Date.parse(e.start);
  const end = Date.parse(e.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "unparseable date";
  const dayMs = 86_400_000;
  if (!e.recurrence && Math.max(start, end) < now.getTime() - dayMs)
    return "event is in the past";
  if (start > now.getTime() + MAX_DAYS_OUT * dayMs)
    return `start is more than ${MAX_DAYS_OUT} days out`;
  if (!e.venue.trim()) return "no venue";
  if (!titleOnPage(e.title, pageText)) return "title not found on the source page";
  return null;
}

const VERIFY_SYSTEM = (tz: string, today: string) => `
You are a skeptical fact-checker for a local events app.

You get SOURCE TEXT (the readable text of one web page) and CANDIDATES
(events an extraction model claims that page announces). Judge each candidate
ONLY against the source text — no outside knowledge, no benefit of the doubt.

Today: ${today}. Timezone: ${tz}.

Return ONLY JSON shaped exactly like:
{"verdicts":[{
  "index": number,                   // the candidate's index, unchanged
  "verdict": "confirmed"|"corrected"|"unsupported",
  "confidence": number,              // 0-1, how sure you are of the verdict
  "evidence": string,                // <=160 chars quoted/near-quoted from the
                                     // source text naming the event; "" if none
  "start": string|null,              // ONLY with "corrected": fixed ISO 8601
  "end": string|null,                //   values for whatever was wrong;
  "venue": string|null,              //   null for details that were right
  "price": string|null
}]}

Verdict rules:
- "confirmed": the page clearly announces this event and supports its date,
  time, and venue.
- "corrected": the page announces the event but the candidate got a detail
  (date, time, venue, price) wrong — supply the fixed value(s) from the page.
- "unsupported": the page never actually announces this event, the date or
  venue is invented or ambiguous, the listing is from a past year, or the page
  merely links elsewhere without naming a concrete when-and-where.
Promotional vagueness ("fun all summer long!") is "unsupported".
Set "confidence" to how directly the page backs the event: a clear title with a
concrete date and venue on the page is high (0.8+); a real but partial match is
mid (0.5-0.7); reserve low confidence for genuine doubt. Do NOT deflate the
number just to seem careful — an event the page plainly announces should score
high. Copy "evidence" VERBATIM from the source text (an exact substring) so it
can be checked against the page; if you cannot quote it, the verdict is
"unsupported".`;

interface Verdict {
  index: number;
  verdict: "confirmed" | "corrected" | "unsupported";
  confidence: number;
  evidence: string;
  start?: string | null;
  end?: string | null;
  venue?: string | null;
  price?: string | null;
}

/** One LLM call per page verifies all of that page's surviving candidates. */
async function verifyAgainstPage(
  pageText: string,
  candidates: CityEvent[],
  tz: string,
): Promise<Map<number, Verdict>> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const raw = await generateJSON({
    system: VERIFY_SYSTEM(tz, today),
    user: JSON.stringify({
      source_text: pageText,
      candidates: candidates.map((e, index) => ({
        index,
        title: e.title,
        start: e.start,
        end: e.end,
        venue: e.venue,
        price: e.price,
        recurrence: e.recurrence ?? null,
      })),
    }),
  });
  const out = new Map<number, Verdict>();
  // Tolerate a bare array — smaller models sometimes skip the wrapper.
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.verdicts) ? raw.verdicts : [];
  for (const v of list) {
    const index = Number(v?.index);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) continue;
    const verdict = ["confirmed", "corrected", "unsupported"].includes(v.verdict)
      ? v.verdict
      : "unsupported";
    const confidence = Number(v.confidence);
    out.set(index, {
      index,
      verdict,
      confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0,
      evidence: String(v.evidence ?? "").slice(0, 200),
      start: v.start ?? null,
      end: v.end ?? null,
      venue: v.venue ?? null,
      price: v.price ?? null,
    });
  }
  return out;
}

/** Apply a "corrected" verdict's fixes; the id follows the fixed start. */
function applyFixes(e: CityEvent, v: Verdict): CityEvent {
  const start = v.start && Number.isFinite(Date.parse(v.start)) ? v.start : e.start;
  const end = v.end && Number.isFinite(Date.parse(v.end)) ? v.end : e.end;
  return {
    ...e,
    start,
    end,
    venue: v.venue?.trim() ? v.venue.trim() : e.venue,
    price: v.price?.trim() ? v.price.trim() : e.price,
    id: slugId(e.title, start),
  };
}

// ---------------------------------------------------------------------------
// One discovery run
// ---------------------------------------------------------------------------

export async function runDiscovery(opts: {
  query: string;
  /** false = dry run: verify and report, write nothing. Default true. */
  commit?: boolean;
  maxPages?: number;
}): Promise<DiscoveryRunResult> {
  const query = opts.query.trim();
  const commit = opts.commit !== false;
  const result: DiscoveryRunResult = {
    query,
    searchedAt: new Date().toISOString(),
    pagesRead: [],
    pagesSkipped: [],
    extracted: 0,
    verified: [],
    rejected: [],
    added: 0,
  };
  if (query.length < 3) return { ...result, error: "query too short" };

  const settings = await store.settings();
  const now = new Date();

  // Scope to the city unless the query already names it.
  const cityToken = settings.city.split(",")[0].trim();
  const scoped = query.toLowerCase().includes(cityToken.toLowerCase())
    ? query
    : `${query} ${cityToken}`;

  const search = await webSearch(scoped, { limit: MAX_RESULTS });
  if ("error" in search) return { ...result, error: search.error };

  // Read pages until enough succeed. Sequential on purpose: page reads feed
  // LLM extraction anyway, and gentle beats parallel for scraping.
  const maxPages = Math.min(Math.max(1, opts.maxPages ?? MAX_PAGES), 6);
  const pages: { url: string; title: string; text: string }[] = [];
  for (const hit of search.results) {
    if (pages.length >= maxPages) break;
    const page = await readPage(hit.url, { maxChars: PAGE_CHARS });
    if ("error" in page) {
      result.pagesSkipped.push({ url: hit.url, error: page.error });
      continue;
    }
    if (page.text.length < MIN_PAGE_CHARS) {
      result.pagesSkipped.push({ url: hit.url, error: "too little readable text" });
      continue;
    }
    // Same content rail the in-app read_page tool applies: fetched web text
    // is untrusted input to the extraction LLM, so a page the injection
    // classifier flags never reaches a prompt.
    const verdict = await scanText(`${page.title}\n${page.text}`);
    if (verdict.malicious) {
      result.pagesSkipped.push({
        url: hit.url,
        error: "page withheld by guardrails (possible prompt injection)",
      });
      continue;
    }
    pages.push({ url: page.url, title: page.title, text: page.text });
    result.pagesRead.push({ url: page.url, title: page.title });
  }
  if (!pages.length) return { ...result, error: "no readable result pages" };

  // Extract per page so every candidate stays attributable to one URL.
  const perPage: { page: (typeof pages)[number]; events: CityEvent[] }[] = [];
  for (const page of pages) {
    try {
      const events = await extractEvents({
        text: `Web page: ${page.title}\nURL: ${page.url}\n\n${page.text}`,
        source: "web-search",
        sourceKind: "search",
        sourceUrl: page.url,
      });
      perPage.push({ page, events });
      result.extracted += events.length;
    } catch (err) {
      result.pagesSkipped.push({
        url: page.url,
        error: `extraction failed: ${String(err).slice(0, 120)}`,
      });
    }
  }

  const keyOf = (e: CityEvent) => eventKey(e, settings.tz);

  // Deterministic gates first — no LLM tokens spent on obvious fabrications,
  // and hard-rejected candidates must not corroborate anything.
  const gated: { page: (typeof pages)[number]; events: CityEvent[] }[] = [];
  for (const { page, events } of perPage) {
    const survivors: CityEvent[] = [];
    for (const e of events) {
      const reason = hardReject(e, page.text, now);
      if (reason) {
        result.rejected.push({
          event: e, verdict: "rejected", confidence: 0, reason,
          sourceUrl: page.url, corroborations: 1,
        });
      } else {
        survivors.push(e);
      }
    }
    if (survivors.length) gated.push({ page, events: survivors });
  }

  // Corroboration: the same event (catalog dedupe key) found on 2+ DISTINCT
  // pages. A page vouches for an event at most once, no matter how many times
  // the extractor repeats it, so a single source can never clear the lower bar.
  const keyPages = new Map<string, Set<string>>();
  for (const { page, events } of gated) {
    for (const e of events) {
      const k = keyOf(e);
      let urls = keyPages.get(k);
      if (!urls) keyPages.set(k, (urls = new Set()));
      urls.add(page.url);
    }
  }
  const corroborationsOf = (e: CityEvent) => keyPages.get(keyOf(e))?.size ?? 1;

  const bar = minConfidence();
  for (const { page, events: survivors } of gated) {
    let verdicts: Map<number, Verdict>;
    try {
      verdicts = await verifyAgainstPage(page.text, survivors, settings.tz);
    } catch (err) {
      // Verification unavailable ≠ verified: fail closed, keep the reason.
      for (const e of survivors) {
        result.rejected.push({
          event: e, verdict: "rejected", confidence: 0,
          reason: `verifier failed: ${String(err).slice(0, 120)}`,
          sourceUrl: page.url, corroborations: corroborationsOf(e),
        });
      }
      continue;
    }

    survivors.forEach((e, index) => {
      const corroborations = corroborationsOf(e);
      const v = verdicts.get(index);
      if (!v || v.verdict === "unsupported") {
        result.rejected.push({
          event: e, verdict: "rejected", confidence: v?.confidence ?? 0,
          reason: v ? "source page does not support this event" : "verifier returned no verdict",
          ...(v?.evidence && { evidence: v.evidence }),
          sourceUrl: page.url, corroborations,
        });
        return;
      }
      // The corrected event is what we'd store, so check its (possibly fixed)
      // date against the page.
      const event = v.verdict === "corrected" ? applyFixes(e, v) : e;
      // Deterministic supports we verified ourselves. Each one earns a lower
      // confidence floor, so the run leans on checkable evidence — a real quote
      // on the page, the date on the page, the same event on a second page —
      // rather than a small local model's self-reported confidence alone. The
      // title is already known to be on the page (hardReject), so a confirmed
      // verdict with any of these is well-grounded even at modest confidence.
      const evidenceSupport = evidenceOnPage(v.evidence, page.text);
      const dateSupport = dateOnPage(event, page.text, settings.tz);
      const supports =
        (evidenceSupport ? 1 : 0) + (dateSupport ? 1 : 0) + (corroborations >= 2 ? 1 : 0);
      const required = Math.max(0.3, bar - 0.15 * supports);
      if (v.confidence < required) {
        result.rejected.push({
          event: e, verdict: "rejected", confidence: v.confidence,
          reason:
            `confidence ${v.confidence.toFixed(2)} below ${required.toFixed(2)} ` +
            `(date on page: ${dateSupport ? "yes" : "no"}, quote on page: ` +
            `${evidenceSupport ? "yes" : "no"}, sources: ${corroborations})`,
          ...(v.evidence && { evidence: v.evidence }),
          sourceUrl: page.url, corroborations,
        });
        return;
      }
      result.verified.push({
        event, verdict: v.verdict, confidence: v.confidence,
        ...(v.evidence && { evidence: v.evidence }),
        sourceUrl: page.url, corroborations,
      });
    });
  }

  // A run can meet the same event on two pages — keep the higher-confidence copy.
  const byKey = new Map<string, DiscoveryCandidate>();
  for (const c of result.verified) {
    const k = keyOf(c.event);
    const prev = byKey.get(k);
    if (!prev || c.confidence > prev.confidence) byKey.set(k, c);
  }
  result.verified = [...byKey.values()];

  if (commit && result.verified.length) {
    const { added } = await commitIngest({
      events: result.verified.map((c) => c.event),
      source: "web-search",
      kind: "search",
      subject: query,
      extracted: result.extracted,
    });
    result.added = added.length;
  }
  return result;
}

/** One-line summary for logs and discovery_searches.last_status. */
export function summarizeRun(r: DiscoveryRunResult): string {
  if (r.error) return `error: ${r.error}`;
  return (
    `${r.pagesRead.length} pages, ${r.extracted} extracted, ` +
    `${r.verified.length} verified, ${r.rejected.length} rejected, ${r.added} new`
  );
}

/** Collapse a rejection reason to a coarse, human bucket so a run can report
 * *why* it was thin without leaking a dozen near-identical strings. */
function rejectionBucket(reason: string | undefined): string {
  const r = (reason ?? "").toLowerCase();
  if (r.includes("confidence")) return "verifier not confident enough";
  if (r.includes("does not support") || r.includes("no verdict"))
    return "page didn't back the event";
  if (r.includes("title not found")) return "title not on the source page";
  if (r.includes("in the past")) return "event already passed";
  if (r.includes("unparseable")) return "no readable date";
  if (r.includes("no venue")) return "no venue named";
  if (r.includes("days out")) return "date implausibly far out";
  if (r.includes("verifier failed")) return "verifier error";
  return reason ?? "rejected";
}

/**
 * The top rejection reasons for a run, most common first, each with a count and
 * one example title — enough for the agent to explain a thin run to the user
 * and decide whether to retry with a tighter query or a different source.
 */
export function summarizeRejections(
  rejected: DiscoveryCandidate[],
  top = 3,
): { reason: string; count: number; example: string }[] {
  const groups = new Map<string, { count: number; example: string }>();
  for (const c of rejected) {
    const key = rejectionBucket(c.reason);
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { count: 1, example: c.event.title });
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, top)
    .map(([reason, { count, example }]) => ({ reason, count, example }));
}

// ---------------------------------------------------------------------------
// Scheduler — re-runs saved searches on their cadence
// ---------------------------------------------------------------------------

const DEFAULT_TICK_SECONDS = 300;

/** Run one saved search now (scheduler tick or "Run now" button/tool). */
export async function runSavedSearch(s: DiscoverySearch): Promise<DiscoveryRunResult> {
  const result = await runDiscovery({ query: s.query, commit: true });
  await store.markDiscoveryRun(s.id, summarizeRun(result));
  console.log(`[grapevine] discovery: “${s.query}” → ${summarizeRun(result)}`);
  return result;
}

function isDue(s: DiscoverySearch, now: number): boolean {
  if (!s.active) return false;
  if (!s.lastRunAt) return true;
  // Slack of 90s so a cadence doesn't drift one tick later every cycle.
  return now - Date.parse(s.lastRunAt) >= s.cadenceHours * 3_600_000 - 90_000;
}

let running = false;

async function tick(): Promise<void> {
  if (running) return; // a slow run must not overlap the next tick
  running = true;
  try {
    const due = (await store.discoverySearches()).filter((s) => isDue(s, Date.now()));
    for (const s of due) {
      try {
        await runSavedSearch(s);
      } catch (err) {
        const message = `error: ${String(err).slice(0, 200)}`;
        console.log(`[grapevine] discovery: “${s.query}” failed — ${message}`);
        await store.markDiscoveryRun(s.id, message).catch(() => {});
      }
    }
  } catch (err) {
    console.log(`[grapevine] discovery tick error: ${String(err).slice(0, 200)}`);
  } finally {
    running = false;
  }
}

/** Starts the cadence loop unless DISCOVERY_SCHEDULE=0. */
export function startDiscoveryScheduler(): void {
  if (/^(0|false|no)$/i.test(process.env.DISCOVERY_SCHEDULE ?? "")) {
    console.log("[grapevine] discovery: scheduler disabled (DISCOVERY_SCHEDULE=0)");
    return;
  }
  const seconds = Math.max(
    60,
    Number(process.env.DISCOVERY_TICK_SECONDS ?? DEFAULT_TICK_SECONDS) || DEFAULT_TICK_SECONDS,
  );
  console.log(`[grapevine] discovery: checking saved searches every ${seconds}s`);
  void tick();
  setInterval(() => void tick(), seconds * 1000);
}
