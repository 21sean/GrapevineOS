import { useMemo, useState } from "react"
import {
  ChevronDownIcon,
  GemIcon,
  MegaphoneOffIcon,
  RadioIcon,
  SlidersHorizontalIcon,
} from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { EventCard } from "@/components/EventCard"
import { useGrapevine } from "@/lib/store"
import { visibleEvents } from "@/lib/score"
import { CATEGORIES, CATEGORY_META, type Category } from "@/lib/types"
import { cn } from "@/lib/utils"

const RAIL_MIN = 300
const RAIL_MAX = 560

export function FilterRail() {
  const events = useGrapevine((s) => s.events)
  const filters = useGrapevine((s) => s.filters)
  const interests = useGrapevine((s) => s.interests)
  const now = useGrapevine((s) => s.now)
  const setFilters = useGrapevine((s) => s.setFilters)
  const pinnedIds = useGrapevine((s) => s.pinnedIds)
  const railWidth = useGrapevine((s) => s.railWidth)
  const setRailWidth = useGrapevine((s) => s.setRailWidth)

  // Filters (buzz + categories) tuck into a disclosure that starts collapsed,
  // so the list gets the room by default.
  const [filtersOpen, setFiltersOpen] = useState(false)

  const visible = useMemo(
    () => visibleEvents(events, filters, interests, now),
    [events, filters, interests, now],
  )

  // Pinned events float to the top, keeping their buzz order among themselves.
  const ordered = useMemo(() => {
    if (pinnedIds.length === 0) return visible
    const pinned = new Set(pinnedIds)
    return [
      ...visible.filter((e) => pinned.has(e.id)),
      ...visible.filter((e) => !pinned.has(e.id)),
    ]
  }, [visible, pinnedIds])

  // Badge on the collapsed disclosure so active filters aren't invisible.
  const activeFilterCount =
    filters.categories.length + (filters.minRating > 0 ? 1 : 0)

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
          <ToggleRow
            icon={<RadioIcon className="size-3.5 text-live" />}
            label="Live now"
            checked={filters.liveOnly}
            onChange={(v) => setFilters({ liveOnly: v })}
          />
          <ToggleRow
            icon={<GemIcon className="size-3.5 text-wine" />}
            label="Rare finds"
            hint="parades, races, one-offs"
            checked={filters.rareOnly}
            onChange={(v) => setFilters({ rareOnly: v })}
          />
          <ToggleRow
            icon={<MegaphoneOffIcon className="size-3.5 text-muted-foreground" />}
            label="Hide promoted"
            checked={filters.hidePromoted}
            onChange={(v) => setFilters({ hidePromoted: v })}
          />
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
              {activeFilterCount > 0 && (
                <span className="rounded-full bg-wine/20 px-1.5 py-px font-mono text-[10px] text-wine">
                  {activeFilterCount}
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
            <div className="flex flex-col gap-3 duration-150 animate-in fade-in-0 slide-in-from-top-1">
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
                  {filters.minRating > 0
                    ? `${filters.minRating.toFixed(1)}+`
                    : "any"}
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

      <ScrollArea className="mr-1 min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-3 pt-1">
          {ordered.map((e) => (
            <EventCard key={e.id} event={e} />
          ))}
          {!ordered.length && (
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyTitle>Nothing gets through</EmptyTitle>
                <EmptyDescription>
                  Loosen a filter or lower the buzz bar. The grapevine is
                  quiet under these settings.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
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
