export type Category =
  | "music"
  | "food"
  | "sports"
  | "arts"
  | "market"
  | "festival"
  | "community";

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

export interface ReactionEntry {
  eventId: string;
  reaction: Reaction;
}

/** One browser that enabled Web Push for a user. */
export interface PushSub {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  reminders: boolean;
  weeklyDigest: boolean;
  /** Traffic-aware "time to leave" alerts for going/saved events. */
  leaveBy: boolean;
}

/** An LLM engine: the local Ollama model or a subscription-authed CLI. */
export type LlmProviderId = "ollama" | "claude" | "codex" | "gemini" | "copilot";

export const LLM_PROVIDERS: LlmProviderId[] = [
  "ollama",
  "claude",
  "codex",
  "gemini",
  "copilot",
];

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

/** Per-account copies of the browser preferences, synced when signed in. */
export interface UserPrefs {
  filters?: unknown;
  interests?: unknown;
  pinnedIds?: unknown;
  hiddenIds?: unknown;
}

/**
 * Google Calendar connection metadata. The refresh token itself lives in
 * Supabase Vault (encrypted at rest) and is only read through the
 * google_calendar_get RPC; this is the non-secret shape rows join with.
 */
export interface GoogleCalendarGrant {
  scope: string;
}

/**
 * One event a user saved to their calendar. googleEventId is set once the
 * entry has been pushed to their Google Calendar; the ICS feed serves the
 * same set to Apple Calendar and friends.
 */
export interface CalendarEntry {
  userId: string;
  eventId: string;
  googleEventId?: string;
  addedAt: string; // ISO 8601
}

export interface User {
  id: string; // auth.users.id — Supabase Auth is the identity source
  email: string;
  name: string;
  picture: string;
  createdAt: string;
  lastLoginAt: string;
  prefs?: UserPrefs;
  googleCalendar?: GoogleCalendarGrant; // present once Google Calendar is connected
  feedToken?: string; // unguessable path segment for the personal ICS feed
  /** Last coarse position (~110 m grid) the browser reported — the origin for
   * leave-by ETAs. Absent until the user grants geolocation while signed in. */
  lastPos?: { lng: number; lat: number; at: string };
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

export const CATEGORIES: Category[] = [
  "music",
  "food",
  "sports",
  "arts",
  "market",
  "festival",
  "community",
];
