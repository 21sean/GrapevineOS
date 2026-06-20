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
  sourceKind: "newsletter" | "manual" | "seed";
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
}

export interface Settings {
  city: string;
  center: [number, number];
  tz: string;
  model: string;
  ollamaUrl: string;
  /** Who answers chat: the local Ollama agent or a subscription-authed CLI. */
  chatProvider: "ollama" | "claude" | "codex" | "gemini";
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
  source: string; // inbox tag ("sdtoday") or "manual"
  kind: "email" | "manual";
  subject?: string; // inbound emails only
  extracted: number;
  added: number;
  /** Snapshot of what landed, so history survives event edits/deletes. */
  events: { id: string; title: string; start: string }[];
}

/** Per-account copies of the browser preferences, synced when signed in. */
export interface UserPrefs {
  filters?: unknown;
  interests?: unknown;
  pinnedIds?: unknown;
  hiddenIds?: unknown;
}

/** OAuth tokens from the incremental Google Calendar consent (auth.ts). */
export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms when accessToken dies
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
  id: string;
  googleId: string; // Google `sub` claim — stable per account
  email: string;
  name: string;
  picture: string;
  createdAt: string;
  lastLoginAt: string;
  prefs?: UserPrefs;
  google?: GoogleTokens; // present once Google Calendar is connected
  feedToken?: string; // unguessable path segment for the personal ICS feed
}

export interface Session {
  tokenHash: string; // sha256 of the cookie value — raw tokens aren't stored
  userId: string;
  expiresAt: number;
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
