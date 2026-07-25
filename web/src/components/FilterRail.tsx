import { useState } from "react"
import {
  ArrowUpDownIcon,
  CalendarRangeIcon,
  ChevronDownIcon,
  EyeIcon,
  GemIcon,
  MegaphoneOffIcon,
  RadioIcon,
  RotateCcwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  SproutIcon,
  TicketIcon,
  Volume2Icon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { DateQuickChips } from "@/components/DateFilters"
import { NearMeChip } from "@/components/NearMeChip"
import { EventCard } from "@/components/EventCard"
import { useFilterToggles, type FilterToggle } from "@/hooks/useFilterToggles"
import { useOrderedEvents } from "@/hooks/useOrderedEvents"
import { activeFilterCount } from "@/lib/score"
import { useGrapevine } from "@/lib/store"
import {
  CATEGORIES,
  CATEGORY_META,
  DEFAULT_FILTERS,
  SORT_OPTIONS,
  type Category,
  type FarmersFilter,
  type SortKey,
} from "@/lib/types"
import { cn } from "@/lib/utils"

const FARMERS_OPTIONS: { value: FarmersFilter; label: string }[] = [
  { value: "any", label: "Show" },
  { value: "only", label: "Only" },
  { value: "hide", label: "Hide" },
]

// The rail's look for the shared toggle descriptors (see useFilterToggles).
const TOGGLE_ICONS: Record<FilterToggle["key"], React.ReactNode> = {
  live: <RadioIcon className="size-3.5 text-live" />,
  rare: <GemIcon className="size-3.5 text-wine" />,
  free: <TicketIcon className="size-3.5 text-live" />,
  hidePromoted: <MegaphoneOffIcon className="size-3.5 text-muted-foreground" />,
}

// Rail-sized chips for the date quick filters; the dock passes its own.
const RAIL_CHIP =
  "flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
const RAIL_CHIP_ACTIVE =
  "border-wine/50 bg-wine/15 text-wine hover:bg-wine/15 hover:text-wine"

const RAIL_MIN = 300
const RAIL_MAX = 560

export function FilterRail() {
  const filters = useGrapevine((s) => s.filters)
  const { toggles, farmers } = useFilterToggles()
  const railWidth = useGrapevine((s) => s.railWidth)
  const setRailWidth = useGrapevine((s) => s.setRailWidth)
  const hiddenCount = useGrapevine((s) => s.hiddenIds.length)
  const clearHidden = useGrapevine((s) => s.clearHidden)
  const mutedCount = useGrapevine((s) => s.mutedVenues.length + s.mutedSources.length)
  const clearMuted = useGrapevine((s) => s.clearMuted)

  // Filters (buzz + categories) tuck into a disclosure that starts collapsed,
  // so the list gets the room by default.
  const [filtersOpen, setFiltersOpen] = useState(false)

  const { visible, ordered } = useOrderedEvents()

  // Drag the right edge to resize; width persists (device-local).
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = railWidth
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(RAIL_MAX, Math.max(RAIL_MIN, startW + ev.clientX - startX))
      setRailWidth(next)
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
    }
    document.body.style.userSelect = "none"
    document.body.style.cursor = "ew-resize"
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  return (
    <aside
      style={{ width: railWidth }}
      className="glass absolute top-20 bottom-4 left-4 z-10 flex flex-col overflow-hidden rounded-xl"
    >
      <div className="flex flex-col gap-3 p-4 pb-3">
        <div className="flex flex-col gap-1.5">
          {/* farmers slots between the free and hide-promoted rows */}
          {toggles.slice(0, 3).map((t) => (
            <ToggleRow
              key={t.key}
              icon={TOGGLE_ICONS[t.key]}
              label={t.label}
              hint={t.hint}
              checked={t.active}
              onChange={t.toggle}
            />
          ))}
          <FarmersRow value={farmers.value} onChange={farmers.setValue} />
          {toggles.slice(3).map((t) => (
            <ToggleRow
              key={t.key}
              icon={TOGGLE_ICONS[t.key]}
              label={t.label}
              hint={t.hint}
              checked={t.active}
              onChange={t.toggle}
            />
          ))}
          {/* one-tap date windows; a custom range (agent- or picker-set)
              shows on the picker chip with its own clear button */}
          <div className="flex items-start gap-2 pt-0.5">
            <CalendarRangeIcon className="mt-[5px] size-3.5 shrink-0 text-muted-foreground" />
            <div className="flex flex-1 flex-wrap items-center gap-1.5">
              <DateQuickChips chipClass={RAIL_CHIP} activeClass={RAIL_CHIP_ACTIVE} />
              <NearMeChip chipClass={RAIL_CHIP} activeClass={RAIL_CHIP_ACTIVE} />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setFiltersOpen((o) => !o)}
            aria-expanded={filtersOpen}
            className="-mx-1 flex items-center justify-between gap-2 rounded-md px-1 py-0.5 text-sm transition-colors hover:text-foreground"
          >
            <span className="flex items-center gap-2">
              <SlidersHorizontalIcon className="size-3.5 text-muted-foreground" />
              Filters
              {activeFilterCount(filters) > 0 && (
                <span className="rounded-full bg-wine/20 px-1.5 py-px font-mono text-[10px] text-wine">
                  {activeFilterCount(filters)}
                </span>
              )}
            </span>
            <ChevronDownIcon
              className={cn(
                "size-4 text-muted-foreground transition-transform",
                filtersOpen && "rotate-180",
              )}
            />
          </button>

          {filtersOpen && (
            <div className="duration-150 animate-in fade-in-0 slide-in-from-top-1">
              <BuzzAndCategoryFilters />
            </div>
          )}
        </div>
      </div>

      <Separator />

      <div className="flex items-baseline justify-between px-4 pt-2.5 pb-1">
        <span className="font-heading text-sm font-medium italic">
          Worth leaving the house for
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {visible.length}
        </span>
      </div>

      <div className="px-3 py-1">
        <ListSearchSort />
      </div>

      <ScrollArea className="mr-1 min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-3 pt-1">
          {ordered.map((e) => (
            <EventCard key={e.id} event={e} />
          ))}
          {!ordered.length && <EventListEmpty />}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={clearHidden}
              className="mt-1 flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <EyeIcon className="size-3.5" />
              Restore {hiddenCount} hidden event{hiddenCount === 1 ? "" : "s"}
            </button>
          )}
          {mutedCount > 0 && (
            <button
              type="button"
              onClick={clearMuted}
              className="mt-1 flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Volume2Icon className="size-3.5" />
              {mutedCount === 1
                ? "Unmute 1 venue or source"
                : `Unmute ${mutedCount} venues & sources`}
            </button>
          )}
        </div>
      </ScrollArea>

      {/* drag the right edge to resize the panel */}
      <div
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize event list"
        title="Drag to resize"
        className="group/resize absolute inset-y-0 right-0 z-30 flex w-2 cursor-ew-resize touch-none items-center justify-end"
      >
        <span className="h-10 w-1 rounded-full bg-border/80 transition-colors group-hover/resize:bg-ring" />
      </div>
    </aside>
  )
}

/** Trigger stays narrow; the dropdown spells the full option out. */
const SORT_SHORT: Record<SortKey, string> = {
  relevance: "Relevance",
  date: "Date",
  "price-asc": "Price ↑",
  "price-desc": "Price ↓",
  alpha: "A–Z",
}

/**
 * Search box + sort picker for the event list, shared between the desktop
 * rail and the phone dock. Search narrows the list (and its count); sort
 * reorders it — "relevance" is the personal buzz score the list opens with.
 */
export function ListSearchSort() {
  const searchQuery = useGrapevine((s) => s.searchQuery)
  const setSearchQuery = useGrapevine((s) => s.setSearchQuery)
  const sortBy = useGrapevine((s) => s.sortBy)
  const setSortBy = useGrapevine((s) => s.setSortBy)

  return (
    <div className="flex items-center gap-2">
      <InputGroup className="flex-1">
        <InputGroupInput
          placeholder="Search events…"
          aria-label="Search events"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setSearchQuery("")
          }}
        />
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        {searchQuery !== "" && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label="Clear search"
              onClick={() => setSearchQuery("")}
            >
              <XIcon />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>

      <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortKey)}>
        <SelectTrigger size="sm" className="shrink-0" aria-label="Sort events">
          <ArrowUpDownIcon className="size-3.5 text-muted-foreground" />
          <SelectValue>{SORT_SHORT[sortBy]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {SORT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * Buzz threshold + category chips — the disclosure body, shared between the
 * desktop rail and the phone dock.
 */
export function BuzzAndCategoryFilters() {
  const filters = useGrapevine((s) => s.filters)
  const setFilters = useGrapevine((s) => s.setFilters)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          Buzz
        </span>
        <Slider
          value={[filters.minRating]}
          min={0}
          max={5}
          step={0.5}
          onValueChange={([v]) => setFilters({ minRating: v })}
        />
        <span className="w-9 text-right font-mono text-xs text-muted-foreground">
          {filters.minRating > 0 ? `${filters.minRating.toFixed(1)}+` : "any"}
        </span>
      </div>

      <ToggleGroup
        type="multiple"
        variant="outline"
        size="sm"
        className="flex-wrap justify-start"
        value={filters.categories}
        onValueChange={(v) => setFilters({ categories: v as Category[] })}
      >
        {CATEGORIES.map((c) => (
          <ToggleGroupItem
            key={c}
            value={c}
            aria-label={CATEGORY_META[c].label}
            className="gap-1.5 rounded-full px-3"
          >
            <span
              className="size-2 rounded-full"
              style={{ background: CATEGORY_META[c].color }}
            />
            {CATEGORY_META[c].label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}

/**
 * Farmers markets are a third of the catalog some weeks, so a plain "only"
 * switch isn't enough — this row shows them, tours only them, or mutes them.
 */
function FarmersRow({
  value,
  onChange,
}: {
  value: FarmersFilter
  onChange: (v: FarmersFilter) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2 text-sm">
        <SproutIcon
          className="size-3.5"
          style={{ color: CATEGORY_META.market.color }}
        />
        Farmers markets
      </span>
      <div className="flex rounded-md border border-border p-0.5">
        {FARMERS_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-[5px] px-2 py-0.5 text-xs text-muted-foreground transition-colors",
              value === o.value &&
                (o.value === "only"
                  ? "bg-[#56c7ac]/15 text-[#56c7ac]"
                  : "bg-accent text-foreground"),
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Empty state for the event list, shared between the desktop rail and the
 * phone dock. A dead end needs a way out: one tap clears the search when
 * that's what's narrowing, or resets the filters when they block everything.
 */
export function EventListEmpty() {
  const searchQuery = useGrapevine((s) => s.searchQuery)
  const setSearchQuery = useGrapevine((s) => s.setSearchQuery)
  const setFilters = useGrapevine((s) => s.setFilters)
  const searching = searchQuery.trim() !== ""

  return (
    <Empty className="py-10">
      <EmptyHeader>
        <EmptyTitle>{searching ? "No matches" : "Nothing gets through"}</EmptyTitle>
        <EmptyDescription>
          {searching
            ? `Nothing on the vine matches "${searchQuery.trim()}". Try another word or clear the search.`
            : "Loosen a filter or lower the buzz bar. The grapevine is quiet under these settings."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            searching ? setSearchQuery("") : setFilters(DEFAULT_FILTERS)
          }
        >
          {searching ? (
            <XIcon data-icon="inline-start" />
          ) : (
            <RotateCcwIcon data-icon="inline-start" />
          )}
          {searching ? "Clear search" : "Reset filters"}
        </Button>
      </EmptyContent>
    </Empty>
  )
}

function ToggleRow({
  icon,
  label,
  hint,
  checked,
  onChange,
}: {
  icon: React.ReactNode
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2">
      <span className="flex items-center gap-2 text-sm">
        {icon}
        {label}
        {hint && (
          <span className="text-xs text-muted-foreground">{hint}</span>
        )}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
