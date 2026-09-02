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
  /** What the injection rails do with a message at or over the threshold. */
  guardMode: GuardrailMode;
  /** MALICIOUS probability at which the rails act, 0-1. */
  guardThreshold: number;
  /**
   * Domain the email worker's catch-all accepts (INBOX_DOMAIN on the server).
   * Read-only: reported by GET /api/settings, ignored on PUT.
   */
  inboxDomain?: string;
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

/**
 * Reasoning-effort tiers the Claude Code CLI accepts via `--effort` (maps to
 * Anthropic's internal thinking-budget). Only the `claude` chat provider
 * honours this; the others ignore it.
 */
export const CHAT_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ChatEffort = (typeof CHAT_EFFORT_LEVELS)[number];

export function isChatEffort(v: unknown): v is ChatEffort {
  return typeof v === "string" && (CHAT_EFFORT_LEVELS as readonly string[]).includes(v);
}

/**
 * Per-turn token + cost telemetry from a CLI provider. Currently only Claude
 * Code reports it (the `usage` block + `total_cost_usd` in its
 * `--output-format json` envelope); the other CLIs and the local Ollama agent
 * leave it undefined. Surfaced under the assistant reply when present.
 */
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  /** The model the CLI actually billed (its resolved id, not our request). */
  model?: string;
}

/**
 * Venue intelligence for one event's location, from the Mapbox Places API
 * (public preview). A trimmed projection of the Place record: only the fields
 * the detail panel actually renders cross the wire.
 *
 * `openingHours` stays as the raw OSM string rather than a baked "open now"
 * boolean — the server caches the record for hours, so the client evaluates it
 * against its own clock via shared/hours.ts (see the note there).
 */
export interface VenueDetails {
  mapboxId: string;
  name: string;
  address?: string;
  /** Human-readable primary category, e.g. "Bar", "Live Music Venue". */
  category?: string;
  categories: string[];
  phone?: string;
  website?: string;
  /** OSM-format `opening_hours`, verbatim. Evaluate with shared/hours.ts. */
  openingHours?: string;
  /** IANA zone the hours are expressed in; falls back to the app's tz. */
  tz?: string;
  /** 0-1, "relative popularity based on signals across the web". */
  popularity?: number;
  /** "Cheap" | "Moderate" | "Expensive", when Mapbox has it. */
  priceLevel?: string;
  photos: VenuePhoto[];
  /** Accessibility accommodations that are true for this venue. */
  accessibility: string[];
  /** Notable amenities: wi-fi, outdoor seating, and the like. */
  features: string[];
  /**
   * Hourly busyness, 0-100, keyed "mon".."sun" with 24 entries each (local
   * time). Only present for venues with enough activity data.
   */
  activity?: Record<string, number[]>;
  permanentlyClosed?: boolean;
}

export interface VenuePhoto {
  url: string;
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// Evals — the quality gate behind Admin → Monitoring (server/src/evals)
// ---------------------------------------------------------------------------

/**
 * What a suite needs before it can run. `offline` suites are pure functions
 * over frozen fixtures: no network, no model, no database, same answer every
 * time. `model` suites need the local guardrails ONNX weights on disk, so
 * they can be legitimately unavailable rather than failing. `judge` suites are
 * graded by an LLM (DeepEval metrics against a local Ollama judge): they need
 * a running model, they cost real inference time, and they are the only kind
 * whose threshold is meaningfully below 1 -- a judge that agreed with itself
 * every single time would not be measuring anything.
 */
export type EvalKind = "offline" | "model" | "judge";

/** `skipped` is deliberately not a failure — an unrunnable check is unknown. */
export type EvalStatus = "pass" | "fail" | "skipped";

export interface EvalCaseResult {
  id: string;
  name: string;
  status: EvalStatus;
  /** Compact "what we actually got". Never a stack trace, never a secret. */
  detail: string;
  /** Why the case exists — the regression it guards against. */
  note?: string;
  ms: number;
}

export interface EvalSuiteResult {
  id: string;
  title: string;
  what: string;
  kind: EvalKind;
  status: EvalStatus;
  /** passed / (passed + failed). Skipped cases are excluded from the ratio. */
  score: number;
  /** Score the suite must reach to pass. 1 means every case must pass. */
  threshold: number;
  passed: number;
  failed: number;
  skipped: number;
  ms: number;
  /** Set when the whole suite could not run (a dependency is unavailable). */
  skipReason?: string;
  cases: EvalCaseResult[];
}

export interface EvalRun {
  id: string;
  startedAt: string; // ISO 8601
  ms: number;
  status: EvalStatus;
  passed: number;
  failed: number;
  skipped: number;
  suites: EvalSuiteResult[];
  /**
   * Fingerprint of the case set that ran. A run whose hash differs from the
   * baseline's changed the questions, so its score is not comparable — that
   * is a rewrite, not a regression.
   */
  caseSetHash: string;
  /** "suite/case" ids that failed here and passed in the last comparable run. */
  regressions?: string[];
  /** "suite/case" ids that pass here and failed in the last comparable run. */
  fixes?: string[];
}

export interface EvalSuiteInfo {
  id: string;
  title: string;
  what: string;
  kind: EvalKind;
  threshold: number;
  caseCount: number;
  /** Human reason the suite cannot run right now, if it cannot. */
  unavailable?: string;
}

/**
 * A seeded example user. Personas are fixtures, not accounts: they never
 * touch auth, never write to the database, and exist so personalization can
 * be asserted against a person with a stated taste instead of a vibe.
 */
export interface EvalPersona {
  id: string;
  name: string;
  /** One line: who they are and what they'd ask for. */
  blurb: string;
  initials: string;
  /** Category id that tints the persona card, for a bit of visual identity. */
  tint: Category;
  loves: string[];
  avoids: string[];
  homeLabel: string;
  /** Reactions this persona has already left, in plain language. */
  history: { title: string; reaction: Reaction }[];
  /** The promises the persona's cases enforce, for the panel to list. */
  checks: string[];
}

export interface EvalCatalog {
  suites: EvalSuiteInfo[];
  personas: EvalPersona[];
  lastRun: EvalRun | null;
  /** The frozen instant every offline suite evaluates at. */
  fixtureNow: string;
  /** Size of the frozen event catalog the persona suites search. */
  fixtureEvents: number;
  /** True when an eval run is already in flight (runs are serialized). */
  running: boolean;
}

/** One line of the NDJSON stream a run emits. */
export type EvalFrame =
  | { type: "suite-start"; id: string; title: string; total: number }
  | { type: "case"; suite: string; result: EvalCaseResult }
  | { type: "suite-done"; result: EvalSuiteResult }
  | { type: "done"; run: EvalRun }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Guardrail telemetry — the observability behind Admin → Monitoring
// (server/src/guardrails, server/src/agent/telemetry.ts)
// ---------------------------------------------------------------------------

/**
 * What the injection rails do with text at or over the threshold.
 *
 * `observe` is the one that matters for tuning: it scores and records
 * everything and blocks nothing, so a candidate threshold can be measured
 * against real traffic before it is switched on. Retuning by flipping a
 * number on production and waiting for complaints is not tuning.
 */
export type GuardrailMode = "on" | "observe" | "off";

export const GUARDRAIL_MODES: GuardrailMode[] = ["on", "observe", "off"];

export function isGuardrailMode(v: unknown): v is GuardrailMode {
  return typeof v === "string" && (GUARDRAIL_MODES as string[]).includes(v);
}

/**
 * `input` is the user's own message, `content` is untrusted web text on its
 * way into the model's context, `output` is the deterministic persona
 * scrubber on the streamed reply. They fail differently and are tuned
 * separately, so nothing here ever pools them.
 */
export type GuardrailRail = "input" | "content" | "output";

export const GUARDRAIL_RAILS: GuardrailRail[] = ["input", "content", "output"];

/**
 * Where a scan happened. A union for the call sites that exist, plus string
 * so a new one records as itself instead of failing an insert — an unfamiliar
 * surface showing up in the panel is the correct way to learn about it.
 */
export type GuardrailSurface =
  | "chat"
  | "chat-cli"
  | "search_web"
  | "read_page"
  | "discovery"
  | "warmup"
  | "unknown"
  | (string & {});

/** Operator triage. Labelled rows are the calibration set the sweep scores. */
export type GuardrailLabel = "correct" | "false_positive" | "false_negative";

export const GUARDRAIL_LABELS: GuardrailLabel[] = [
  "correct",
  "false_positive",
  "false_negative",
];

export function isGuardrailLabel(v: unknown): v is GuardrailLabel {
  return typeof v === "string" && (GUARDRAIL_LABELS as string[]).includes(v);
}

/** One recorded decision, as the review queue renders it. */
export interface GuardrailScan {
  id: number;
  at: string; // ISO 8601
  rail: GuardrailRail;
  surface: GuardrailSurface;
  /** Null on the output rail, which is regex and has no score to report. */
  score: number | null;
  threshold: number | null;
  blocked: boolean;
  /** Observe mode: over threshold, deliberately allowed through. */
  wouldBlock: boolean;
  ms: number;
  chars: number;
  /** Truncated at write time; absent when GUARDRAIL_STORE_TEXT=off. */
  text: string | null;
  /** Output rail: which persona pattern fired. */
  pattern: string | null;
  provider: string | null;
  label: GuardrailLabel | null;
}

/** One histogram bucket: how many scans landed here, and how many blocked. */
export interface GuardrailBucket {
  /** Inclusive lower edge of the score range. */
  lo: number;
  hi: number;
  n: number;
  blocked: number;
}

/** One rail's distribution over one window. */
export interface GuardrailWindow {
  n: number;
  blocked: number;
  /** Observe-mode scans that would have blocked. */
  wouldBlock: number;
  /** Rows carrying a score — the output rail contributes none. */
  scored: number;
  meanMs: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  buckets: GuardrailBucket[];
}

/**
 * One rail, with the window before last for comparison. `drift` is the
 * population stability index between them — the standard "has this
 * distribution moved" number, not a bespoke one.
 */
export interface GuardrailRailStats {
  rail: GuardrailRail;
  recent: GuardrailWindow;
  baseline: GuardrailWindow | null;
  /** PSI vs the baseline window; null when there isn't enough history. */
  drift: number | null;
  /** How to read that number, in words. */
  driftVerdict: "stable" | "moderate" | "significant" | "unknown";
}

/** One day of one rail, for the trend lines. */
export interface GuardrailDay {
  day: string; // YYYY-MM-DD
  rail: GuardrailRail;
  n: number;
  blocked: number;
  p95: number | null;
}

/**
 * One candidate threshold, scored against the labelled set. This is the table
 * that answers "what should the threshold be" with something other than a
 * shrug: at each candidate, how much traffic it blocks, and — where an
 * operator has labelled the outcome — how many of those calls were wrong.
 */
export interface GuardrailSweepPoint {
  threshold: number;
  /** Share of all scored traffic this threshold would block, 0-1. */
  blockRate: number;
  /** Labelled-set confusion at this threshold. */
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface GuardrailSweep {
  points: GuardrailSweepPoint[];
  /** Threshold with the best F1 on the labelled set, when there is one. */
  bestF1: number | null;
  /** Labelled rows the sweep was computed from. */
  labelled: number;
  /** Why the sweep is empty or weak, when it is. */
  note?: string;
}

/** Write-queue health. A rising `dropped` means the numbers above are partial. */
export interface GuardrailTelemetryHealth {
  queued: number;
  written: number;
  dropped: number;
  storingText: boolean;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Conversation evals — past Ask Grapevine threads graded by the local judge
// (server/src/evals/conversation-judge.ts, Admin → Monitoring)
// ---------------------------------------------------------------------------

/**
 * The three-way read of an overall score. Not two-way on purpose: a judge is
 * a noisy instrument, and forcing its middle band into pass/fail would turn
 * measurement noise into red rows people learn to ignore.
 */
export type ConversationVerdict = "pass" | "borderline" | "fail";

/** One graded metric from the judge, with the reason it gave. */
export interface ConversationEvalScore {
  metric: string;
  /** 0-1, from the DeepEval metric. */
  score: number;
  reason: string | null;
}

/** One judged pass over a whole persisted thread. */
export interface ConversationEval {
  threadId: string;
  at: string; // ISO 8601
  /** The Ollama judge that scored it — a score needs its instrument named. */
  model: string;
  /** Mean of the metric scores. */
  overall: number;
  verdict: ConversationVerdict;
  scores: ConversationEvalScore[];
  /** Judge wall time. */
  ms: number;
}

/** Guardrail decisions recorded while one thread ran. */
export interface ConversationRailSummary {
  scans: number;
  blocked: number;
  /** Observe mode: over threshold, deliberately allowed through. */
  wouldBlock: number;
  maxScore: number | null;
}

/** One row of the past-conversations table on Admin → Monitoring. */
export interface ConversationMonitorRow {
  id: string;
  title: string;
  provider: string;
  updatedAt: string; // ISO 8601
  /** Persisted messages, user and assistant together. */
  turns: number;
  rails: ConversationRailSummary;
  /** Newest eval, or null when nobody has judged this thread yet. */
  eval: ConversationEval | null;
}

/** Everything the rails half of Admin → Monitoring renders, in one response. */
export interface GuardrailDashboard {
  mode: GuardrailMode;
  threshold: number;
  /** The classifier behind the input and content rails. */
  model: string;
  modelLabel: string;
  /** False when the classifier failed to load and the rails are failing open. */
  classifierReady: boolean;
  windowDays: number;
  /** Rows in the table, all time. */
  total: number;
  oldest: string | null;
  rails: GuardrailRailStats[];
  daily: GuardrailDay[];
  sweep: GuardrailSweep;
  labelCounts: Record<GuardrailLabel, number>;
  health: GuardrailTelemetryHealth;
}
