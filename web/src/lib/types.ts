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

// Domain shapes shared with the server: one definition for both runtimes.
// Everything that crosses the wire lives in shared/types.ts; this file adds
// only what the browser alone needs (icons, colors, list orderings).
export * from "../../../shared/types"
import type { Category, Reaction } from "../../../shared/types"

// ---------- reactions (the per-user feedback loop) ----------

export const REACTION_META: Record<Reaction, { label: string; blurb: string }> = {
  going: { label: "Going", blurb: "boosts this and events like it" },
  went: { label: "Went — great", blurb: "teaches your taste" },
  not_for_me: { label: "Not for me", blurb: "sinks this and events like it" },
}

export interface CategoryMeta {
  label: string
  color: string
  icon: LucideIcon
}

/** Calendar-salmon for booked events' markers, matching Apple Maps' calendar POIs. */
export const BOOKED_COLOR = "#f5828c"

export const CATEGORY_META: Record<Category, CategoryMeta> = {
  music: { label: "Music", color: "#c08bfa", icon: Music },
  food: { label: "Food & drink", color: "#f5a356", icon: UtensilsCrossed },
  sports: { label: "Active", color: "#7fcb74", icon: Bike },
  arts: { label: "Arts", color: "#f27d9d", icon: Palette },
  market: { label: "Markets", color: "#56c7ac", icon: ShoppingBag },
  festival: { label: "Festivals", color: "#edbe54", icon: PartyPopper },
  community: { label: "Community", color: "#8fa3bf", icon: Users },
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

// ---------- the event list ----------

/** Orderings for the event list; "relevance" is the personal buzz score. */
export type SortKey = "relevance" | "date" | "price-asc" | "price-desc" | "alpha"

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "relevance", label: "Relevance" },
  { value: "date", label: "Date" },
  { value: "price-asc", label: "Price: low to high" },
  { value: "price-desc", label: "Price: high to low" },
  { value: "alpha", label: "Alphabetical" },
]

/** A farmers market carries this tag; the "Farmers markets" filter keys off it. */
export const FARMERS_MARKET_TAG = "farmers market"
