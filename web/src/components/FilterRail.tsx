import { useMemo } from "react"
import { GemIcon, MegaphoneOffIcon, RadioIcon } from "lucide-react"
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

export function FilterRail() {
  const events = useGrapevine((s) => s.events)
  const filters = useGrapevine((s) => s.filters)
  const interests = useGrapevine((s) => s.interests)
  const now = useGrapevine((s) => s.now)
  const setFilters = useGrapevine((s) => s.setFilters)

  const visible = useMemo(
    () => visibleEvents(events, filters, interests, now),
    [events, filters, interests, now],
  )

  return (
    <aside className="glass absolute top-20 bottom-4 left-4 z-10 flex w-[340px] flex-col overflow-hidden rounded-xl">
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
          onValueChange={(v) =>
            setFilters({ categories: v as Category[] })
          }
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

      <Separator />

      <div className="flex items-baseline justify-between px-4 pt-2.5 pb-1">
        <span className="font-heading text-sm font-medium italic">
          Worth leaving the house for
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {visible.length}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-3 pt-1">
          {visible.map((e) => (
            <EventCard key={e.id} event={e} />
          ))}
          {!visible.length && (
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
