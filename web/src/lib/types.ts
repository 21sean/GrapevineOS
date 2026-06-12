import {
  Music,
  UtensilsCrossed,
  Bike,
  Palette,
  ShoppingBag,
  PartyPopper,
  Users,
  type LucideIcon,
} from "lucide-react"

export type Category =
  | "music"
  | "food"
  | "sports"
  | "arts"
  | "market"
  | "festival"
  | "community"

export type Rarity = "common" | "notable" | "rare"

export interface CityEvent {
  id: string
  title: string
  description: string
  category: Category
  tags: string[]
  venue: string
  address?: string
  lng: number
  lat: number
  start: string
  end: string
  /** RFC 5545 RRULE (e.g. "FREQ=WEEKLY;BYDAY=SA") when the event repeats;
   * absent for one-offs. start/end are the anchor occurrence + duration. */
  recurrence?: string
  price: string
  free: boolean
  ticketUrl?: string
  ticketProvider?: string
  source: string
  sourceKind: "newsletter" | "manual" | "seed"
  rating: number
  ratingRationale?: string
  promoted: boolean
  rarity: Rarity
}

export interface Settings {
  city: string
  center: [number, number]
  tz: string
  model: string
  ollamaUrl: string
  /** Who answers chat: the local Ollama agent or a subscription-authed CLI. */
  chatProvider: ChatProviderId
}

export type ChatProviderId = "ollama" | "claude" | "codex" | "gemini"

/** One row from GET /api/providers — a locally installed, OAuth-authed CLI. */
export interface CliProviderStatus {
  id: Exclude<ChatProviderId, "ollama">
  name: string
  vendor: string
  logo: string
  bin: string
  installHint: string
  loginHint: string
  loginNote: string
  installed: boolean
  version: string | null
  authed: boolean
  authKind: "subscription" | "api-key" | null
}

export interface McpInfo {
  url: string
  transport: string
  keyRequired: boolean
}

export interface Source {
  id: string
  name: string
  address: string
  kind: string
  note: string
  active: boolean
}

export interface CategoryMeta {
  label: string
  color: string
  icon: LucideIcon
}

export const CATEGORY_META: Record<Category, CategoryMeta> = {
  music: { label: "Music", color: "#c08bfa", icon: Music },
  food: { label: "Food & drink", color: "#f5a356", icon: UtensilsCrossed },
  sports: { label: "Active", color: "#7fcb74", icon: Bike },
  arts: { label: "Arts", color: "#f27d9d", icon: Palette },
  market: { label: "Markets", color: "#56c7ac", icon: ShoppingBag },
  festival: { label: "Festivals", color: "#edbe54", icon: PartyPopper },
  community: { label: "Community", color: "#8fa3bf", icon: Users },
}

export const CATEGORIES = Object.keys(CATEGORY_META) as Category[]

/** Interest vocabulary shown in the pillbox selector; event tags draw from it. */
export const INTEREST_TOPICS = [
  "live music",
  "jazz",
  "edm",
  "comedy",
  "theater",
  "art",
  "immersive",
  "markets",
  "vintage",
  "food trucks",
  "coffee",
  "beer",
  "running",
  "yoga",
  "wellness",
  "outdoors",
  "beach",
  "water",
  "baseball",
  "family",
  "fireworks",
  "parade",
  "nightlife",
  "dancing",
  "networking",
  "history",
] as const

export interface Interests {
  loves: string[]
  avoids: string[]
}

/** One newsletter/email run through the extraction pipeline (server log). */
export interface IngestRecord {
  id: string
  receivedAt: string
  source: string
  kind: "email" | "manual"
  subject?: string
  extracted: number
  added: number
  events: { id: string; title: string; start: string }[]
}

export interface User {
  id: string
  email: string
  name: string
  picture: string
  createdAt: string
  lastLoginAt: string
  prefs?: { filters?: Filters; interests?: Interests; pinnedIds?: string[] }
}

/** Server view of the signed-in user's calendar sync state. */
export interface CalendarStatus {
  signedIn: boolean
  google: boolean // Google Calendar connected (tokens on file)
  synced: string[] // event ids saved to "my calendar"
  feedUrl: string | null // personal ICS feed — subscribe from Apple Calendar
}

// ---------- in-app Google Calendar (the month/agenda popup) ----------

/** Event colors ("etiquette"), mapped server-side onto Google colorIds. */
export const ETIQUETTE_COLORS = [
  "sky",
  "amber",
  "violet",
  "rose",
  "emerald",
  "orange",
] as const

export type Etiquette = (typeof ETIQUETTE_COLORS)[number]

/** Dark-theme tints for event chips/cards + the etiquette picker swatches. */
export const ETIQUETTE_META: Record<
  Etiquette,
  { dot: string; chip: string; swatch: string }
> = {
  sky: {
    dot: "bg-sky-400",
    chip: "border-sky-400/25 bg-sky-400/15 text-sky-200",
    swatch: "border-sky-400",
  },
  amber: {
    dot: "bg-amber-400",
    chip: "border-amber-400/25 bg-amber-400/15 text-amber-200",
    swatch: "border-amber-400",
  },
  violet: {
    dot: "bg-violet-400",
    chip: "border-violet-400/25 bg-violet-400/15 text-violet-200",
    swatch: "border-violet-400",
  },
  rose: {
    dot: "bg-rose-400",
    chip: "border-rose-400/25 bg-rose-400/15 text-rose-200",
    swatch: "border-rose-400",
  },
  emerald: {
    dot: "bg-emerald-400",
    chip: "border-emerald-400/25 bg-emerald-400/15 text-emerald-200",
    swatch: "border-emerald-400",
  },
  orange: {
    dot: "bg-orange-400",
    chip: "border-orange-400/25 bg-orange-400/15 text-orange-200",
    swatch: "border-orange-400",
  },
}

/** Coerce whatever color string the server sends into a known etiquette. */
export function asEtiquette(c: string): Etiquette {
  return (ETIQUETTE_COLORS as readonly string[]).includes(c)
    ? (c as Etiquette)
    : "sky"
}

export interface GcalAttendee {
  email: string
  displayName?: string
  responseStatus: string // needsAction | accepted | declined | tentative
  organizer: boolean
  self: boolean
}

/** One event from the user's primary Google Calendar, server-shaped. */
export interface GcalEvent {
  id: string
  title: string
  description: string
  location: string
  start: string // ISO datetime, or YYYY-MM-DD when allDay
  end: string // exclusive end date when allDay (Google convention)
  allDay: boolean
  color: string
  htmlLink: string
  canEdit: boolean
  guestsCanModify: boolean
  organizerEmail: string
  attendees: GcalAttendee[]
  recurringEventId?: string
  /** Set when this Google event is a synced Grapevine save. */
  grapevineEventId?: string
}

/** Fields PATCH/POST /api/calendar/google/events accepts. */
export interface GcalEventPatch {
  title?: string
  description?: string
  location?: string
  start?: string
  end?: string
  allDay?: boolean
  color?: string
  guestsCanModify?: boolean
  attendees?: { email: string; displayName?: string; responseStatus?: string }[]
}

// ---------- chat history (Ask Grapevine, signed-in users) ----------

export interface ChatThreadMeta {
  id: string
  title: string
  provider: string
  updatedAt: string
}

export interface ChatMessageRec {
  role: "user" | "assistant"
  content: string
  createdAt: string
}

/** A raw newsletter sitting in Cloudflare KV, as shown in the admin inbox. */
export interface InboxEmail {
  key: string
  source: string
  from: string
  subject: string
  receivedAt: string
  chars: number
  processed: boolean
}

export interface Filters {
  categories: Category[] // empty = all
  liveOnly: boolean
  rareOnly: boolean
  farmersOnly: boolean // only weekly farmers markets
  hidePromoted: boolean
  minRating: number
}

export const DEFAULT_FILTERS: Filters = {
  categories: [],
  liveOnly: false,
  rareOnly: false,
  farmersOnly: false,
  hidePromoted: true,
  minRating: 0,
}

/** A farmers market carries this tag; the "Farmers markets" filter keys off it. */
export const FARMERS_MARKET_TAG = "farmers market"

// ---------- agent ("Ask Grapevine") ----------

/** Side-effects the agent asks the client to perform (or propose). */
export type AgentAction =
  | { kind: "highlight"; eventIds: string[]; fit?: boolean }
  | { kind: "proposeCalendar"; eventIds: string[]; note?: string }
  | {
      kind: "proposeInterests"
      addLoves: string[]
      addAvoids: string[]
      removeLoves: string[]
      removeAvoids: string[]
      reason: string
    }

/** One NDJSON line streamed from POST /api/agent/chat. */
export type AgentFrame =
  | { type: "status"; label: string }
  | { type: "delta"; text: string }
  | { type: "replace"; text: string }
  | { type: "tool"; name: string; label: string; state: "start" | "done"; detail?: string }
  | { type: "action"; action: AgentAction }
  | { type: "notice"; code: string; message: string }
  | { type: "done"; threadId?: string }
  | { type: "error"; message: string }
