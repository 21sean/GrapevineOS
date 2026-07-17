/**
 * Domain types shared verbatim by the server and the web client. Both
 * runtimes re-export this module from their local `types` files, so the
 * client/server wire shapes can no longer drift apart silently — a field
 * added here shows up (and typechecks) on both sides at once.
 *
 * Keep this file self-contained: it is included by two TypeScript projects
 * with different module resolutions, so it must not import anything.
 */

const CATEGORY_IDS = [
  "music",
  "food",
  "sports",
  "arts",
  "market",
  "festival",
  "community",
] as const;

export type Category = (typeof CATEGORY_IDS)[number];

export const CATEGORIES: Category[] = [...CATEGORY_IDS];

export type Rarity = "common" | "notable" | "rare";

export interface CityEvent {
  id: string;
  title: string;
  description: string;
  category: Category;
  tags: string[];
  venue: string;
  address?: string;
  lng: number;
  lat: number;
  start: string; // ISO 8601 with offset — anchor (first/next) occurrence
  end: string;
  /**
   * RFC 5545 RRULE (no "RRULE:" prefix), e.g. "FREQ=WEEKLY;BYDAY=SA", when the
   * event repeats. Absent/undefined means a one-off. `start`/`end` are the
   * anchor occurrence + duration that the rule expands forward.
   */
  recurrence?: string;
  price: string; // "Free", "$15", "$40+"
  free: boolean;
  ticketUrl?: string;
  ticketProvider?: string;
  source: string;
  sourceKind: "newsletter" | "manual" | "seed" | "search";
  /** Page the event was verified against — set by web discovery only. */
  sourceUrl?: string;
  rating: number; // 1–5 local-buzz score
  ratingRationale?: string;
  promoted: boolean; // paid/sponsored spam detection
  rarity: Rarity;
  /** og:image scraped from the ticket/source page at ingest (see images.ts). */
  imageUrl?: string;
  /** Dominant color of that image, "#rrggbb" — the paint-before-load fallback. */
  imageColor?: string;
}

/** Per-user feedback on one event — the signal that teaches the ranking. */
export type Reaction = "going" | "went" | "not_for_me";

export const REACTIONS: Reaction[] = ["going", "went", "not_for_me"];

/**
 * An LLM engine: the local Ollama model or a subscription-authed CLI. This
 * tuple is the single provider registry — the CLI subset, settings coercion,
 * and the web client's provider pickers all derive from it.
 */
const LLM_PROVIDER_IDS = ["ollama", "claude", "codex", "gemini", "copilot"] as const;

export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

export const LLM_PROVIDERS: LlmProviderId[] = [...LLM_PROVIDER_IDS];

/** The subscription-authed CLI engines — every provider except local Ollama. */
export type CliProviderId = Exclude<LlmProviderId, "ollama">;

export const CLI_PROVIDER_IDS: CliProviderId[] = LLM_PROVIDERS.filter(
  (p): p is CliProviderId => p !== "ollama",
);

export function isLlmProviderId(v: unknown): v is LlmProviderId {
  return typeof v === "string" && (LLM_PROVIDERS as string[]).includes(v);
}

export interface Settings {
  city: string;
  center: [number, number];
  tz: string;
  model: string;
  ollamaUrl: string;
  /** Who answers chat: the local Ollama agent or a subscription-authed CLI. */
  chatProvider: LlmProviderId;
  /** Who runs newsletter extraction and buzz ratings (default: ollama). */
  extractProvider: LlmProviderId;
}

export interface Source {
  id: string;
  name: string;
  address: string; // the per-source inbox at your domain
  kind: string;
  note: string;
  active: boolean;
}

/**
 * One newsletter/email run through the extraction pipeline. Kept as a log so
 * the app can show where its events came from and when.
 */
export interface IngestRecord {
  id: string;
  receivedAt: string; // ISO 8601
  source: string; // inbox tag ("sdtoday"), "manual", or "web-search"
  kind: "email" | "manual" | "search";
  subject?: string; // inbound emails: subject; search runs: the query
  extracted: number;
  added: number;
  /** Snapshot of what landed, so history survives event edits/deletes. */
  events: { id: string; title: string; start: string }[];
}

/**
 * One saved web search the discovery scheduler re-runs. Each run searches the
 * open web, reads the top result pages, extracts event candidates, and adds
 * only the ones verification confirmed against the source page.
 */
export interface DiscoverySearch {
  id: string;
  query: string;
  cadenceHours: number; // hours between runs (1–336)
  active: boolean;
  createdAt: string; // ISO 8601
  lastRunAt?: string; // ISO 8601 — unset until the first run
  lastStatus?: string; // short human summary of the last run
}

/** One row in the Ask Grapevine history panel. */
export interface ChatThreadMeta {
  id: string; // the LangGraph thread id the client minted
  title: string; // first user message, truncated
  provider: string; // who answered: ollama model path or a CLI provider
  updatedAt: string; // ISO 8601 — last exchange
}

/** One persisted chat message (only user/assistant text, never tool frames). */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string; // ISO 8601
}
