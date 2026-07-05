/**
 * Free, keyless web access for the agent — no accounts, no billed APIs.
 *
 * Search prefers a self-hosted SearXNG instance when SEARXNG_URL is set
 * (docker one-liner, see .env.example) and falls back to scraping DuckDuckGo
 * in-process via duck-duck-scrape. Page reading fetches the URL and distills
 * it with Mozilla's Readability (the Firefox reader-mode extractor).
 *
 * Framework-free like context.ts — the LangChain tool wrappers live in
 * tools.ts.
 */
import { Readability } from "@mozilla/readability";
import { search as ddg, SafeSearchType } from "duck-duck-scrape";
import { JSDOM } from "jsdom";

export interface WebHit {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearchResult =
  | { provider: "searxng" | "duckduckgo"; count: number; results: WebHit[] }
  | { error: string };

const SEARCH_TIMEOUT_MS = 12_000;
const PAGE_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 2_000_000;
const MAX_PAGE_CHARS = 4_000;
const MAX_SNIPPET_CHARS = 300;

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function withDeadline(ms: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function searxng(
  base: string,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<WebHit[]> {
  const url = new URL("/search", base);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json"); // needs formats: [html, json] in settings.yml
  url.searchParams.set("safesearch", "1");
  const res = await fetch(url, { signal: withDeadline(SEARCH_TIMEOUT_MS, signal) });
  if (!res.ok) throw new Error(`searxng ${res.status}`);
  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  return (data.results ?? [])
    .filter((r) => r.url && r.title)
    .slice(0, limit)
    .map((r) => ({
      title: stripHtml(r.title!),
      url: r.url!,
      snippet: stripHtml(r.content ?? "").slice(0, MAX_SNIPPET_CHARS),
    }));
}

async function duckduckgo(query: string, limit: number): Promise<WebHit[]> {
  const res = await ddg(query, { safeSearch: SafeSearchType.MODERATE });
  if (res.noResults) return [];
  return res.results.slice(0, limit).map((r) => ({
    title: stripHtml(r.title),
    url: r.url,
    snippet: stripHtml(r.description).slice(0, MAX_SNIPPET_CHARS),
  }));
}

/**
 * Last-resort scrape of DuckDuckGo's no-JS HTML endpoint — more lenient than
 * the API endpoint duck-duck-scrape uses when its anomaly detection trips.
 * Result links are uddg redirect params, so unwrap them.
 */
async function duckduckgoHtml(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<WebHit[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const res = await fetch(url, {
    signal: withDeadline(SEARCH_TIMEOUT_MS, signal),
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      accept: "text/html",
    },
  });
  if (!res.ok) throw new Error(`ddg html ${res.status}`);
  const dom = new JSDOM(await res.text());
  const hits: WebHit[] = [];
  for (const a of dom.window.document.querySelectorAll("a.result__a")) {
    // hrefs are protocol-relative uddg redirects: //duckduckgo.com/l/?uddg=<enc>
    let href = a.getAttribute("href") ?? "";
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith("//")) href = `https:${href}`;
    if (!/^https?:\/\//.test(href)) continue;
    // skip sponsored results (y.js ad redirects that don't carry uddg)
    try {
      if (new URL(href).hostname.endsWith("duckduckgo.com")) continue;
    } catch {
      continue;
    }
    const body = a.closest(".result") ?? a.parentElement?.parentElement;
    hits.push({
      title: stripHtml(a.textContent ?? ""),
      url: href,
      snippet: stripHtml(body?.querySelector(".result__snippet")?.textContent ?? "").slice(
        0,
        MAX_SNIPPET_CHARS,
      ),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export async function webSearch(
  query: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<WebSearchResult> {
  const q = query.trim();
  if (!q) return { error: "empty query" };
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 5)), 8);

  const base = process.env.SEARXNG_URL;
  if (base) {
    try {
      const results = await searxng(base, q, limit, opts.signal);
      if (results.length) return { provider: "searxng", count: results.length, results };
      // fall through — an empty SearXNG answer is often an engine hiccup
    } catch {
      // fall through to DuckDuckGo
    }
  }
  try {
    const results = await duckduckgo(q, limit);
    if (results.length) return { provider: "duckduckgo", count: results.length, results };
  } catch {
    // fall through to the HTML endpoint
  }
  try {
    const results = await duckduckgoHtml(q, limit, opts.signal);
    return { provider: "duckduckgo", count: results.length, results };
  } catch (err) {
    return {
      error: `web search unavailable: ${String((err as Error)?.message ?? err).slice(0, 120)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Page reader
// ---------------------------------------------------------------------------

export type ReadPageResult =
  | { url: string; title: string; byline?: string; text: string; truncated: boolean }
  | { error: string };

/**
 * The model picks the URLs, so treat every fetch as untrusted: only plain
 * http(s), and never anything that resolves into the local network (Ollama,
 * Supabase CLI, this very server). Hostname-level checks only — good enough
 * for a local single-user app.
 */
function blockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

export async function readPage(
  rawUrl: string,
  opts: { signal?: AbortSignal; maxChars?: number } = {},
): Promise<ReadPageResult> {
  const maxChars = Math.min(opts.maxChars ?? MAX_PAGE_CHARS, 16_000);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: "invalid url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "only http(s) urls" };
  }
  if (blockedHost(url.hostname)) return { error: "url not allowed" };

  let res: Response;
  try {
    res = await fetch(url, {
      signal: withDeadline(PAGE_TIMEOUT_MS, opts.signal),
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; Grapevine/1.0; local events agent)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.8",
      },
      redirect: "follow",
    });
  } catch (err) {
    return { error: `fetch failed: ${String((err as Error)?.message ?? err).slice(0, 120)}` };
  }
  if (!res.ok) return { error: `http ${res.status}` };
  const type = res.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml|text\/plain/.test(type)) {
    return { error: `unsupported content-type: ${type.split(";")[0] || "unknown"}` };
  }

  const html = (await res.text()).slice(0, MAX_HTML_BYTES);
  if (type.includes("text/plain")) {
    const text = html.replace(/\s+/g, " ").trim().slice(0, maxChars);
    return { url: res.url, title: url.hostname, text, truncated: html.length > maxChars };
  }

  try {
    const dom = new JSDOM(html, { url: res.url });
    const article = new Readability(dom.window.document).parse();
    const raw = (article?.textContent ?? dom.window.document.body?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!raw) return { error: "no readable text on page" };
    return {
      url: res.url,
      title: article?.title || dom.window.document.title || url.hostname,
      ...(article?.byline ? { byline: article.byline } : {}),
      text: raw.slice(0, maxChars),
      truncated: raw.length > maxChars,
    };
  } catch (err) {
    return { error: `parse failed: ${String((err as Error)?.message ?? err).slice(0, 120)}` };
  }
}
