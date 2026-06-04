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
