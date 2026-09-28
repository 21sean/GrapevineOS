import { useGrapevine } from "@/lib/store"
import type { FarmersFilter } from "@/lib/types"

export interface FilterToggle {
  key: "live" | "rare" | "free" | "hidePromoted"
  label: string
  /** Compact chip label for the phone dock, where it differs from `label`. */
  shortLabel: string
  hint?: string
  active: boolean
  toggle: () => void
}

// One thumb, three states: show all → only markets → no markets → …
const FARMERS_CYCLE: Record<FarmersFilter, FarmersFilter> = {
  any: "only",
  only: "hide",
  hide: "any",
}

/**
 * The quick filter controls both surfaces wire up (the desktop FilterRail's
 * switch rows and the MobileDock's chips): four boolean toggles (live / rare /
 * free / hide-promoted) plus the farmers-market tri-state. State, labels, and
 * the farmers cycle order live here once; each surface keeps its own look.
 */
export function useFilterToggles(): {
  toggles: FilterToggle[]
  farmers: {
    value: FarmersFilter
    cycle: () => void
    setValue: (v: FarmersFilter) => void
  }
} {
  const filters = useGrapevine((s) => s.filters)
  const setFilters = useGrapevine((s) => s.setFilters)

  const toggles: FilterToggle[] = [
    {
      key: "live",
      label: "Live now",
      shortLabel: "Live now",
      active: filters.liveOnly,
      toggle: () => setFilters({ liveOnly: !filters.liveOnly }),
    },
    {
      key: "rare",
      label: "Rare finds",
      shortLabel: "Rare finds",
      hint: "parades, races, one-offs",
      active: filters.rareOnly,
      toggle: () => setFilters({ rareOnly: !filters.rareOnly }),
    },
    {
      key: "free",
      label: "Free only",
      shortLabel: "Free",
      active: filters.freeOnly,
      toggle: () => setFilters({ freeOnly: !filters.freeOnly }),
    },
    {
      key: "hidePromoted",
      label: "Hide promoted",
      shortLabel: "Hide promoted",
      active: filters.hidePromoted,
      toggle: () => setFilters({ hidePromoted: !filters.hidePromoted }),
    },
  ]

  return {
    toggles,
    farmers: {
      value: filters.farmers,
      cycle: () => setFilters({ farmers: FARMERS_CYCLE[filters.farmers] }),
      setValue: (farmers) => setFilters({ farmers }),
    },
  }
}
