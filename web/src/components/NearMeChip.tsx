import { useState } from "react"
import { LocateIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Slider } from "@/components/ui/slider"
import { useGrapevine } from "@/lib/store"
import { NEAR_MINUTES_MAX, NEAR_MINUTES_MIN } from "@/lib/types"
import { cn } from "@/lib/utils"

const DEFAULT_MINUTES = 20
const STEP = 5

/**
 * "Near me" quick filter: only events within a chosen traffic-aware drive
 * time of the user (or the city center before geolocation lands). The chip
 * opens a popover with a minutes slider — filters.nearMinutes is the source
 * of truth; useNearZone (mounted in App) resolves it to an isochrone the
 * ranking filters against. Rendered by both the desktop rail and the phone
 * dock, styled by the same chip classes as the date chips beside it.
 */
export function NearMeChip({
  chipClass,
  activeClass,
}: {
  chipClass: string
  activeClass: string
}) {
  const nearMinutes = useGrapevine((s) => s.filters.nearMinutes)
  const setFilters = useGrapevine((s) => s.setFilters)
  const userPos = useGrapevine((s) => s.userPos)
  const [open, setOpen] = useState(false)
  // Live slider position while dragging; commits on release so a swipe
  // across the slider doesn't fire an isochrone fetch per pixel.
  const [draft, setDraft] = useState<number | null>(null)

  const active = nearMinutes !== null
  const shown = draft ?? nearMinutes ?? DEFAULT_MINUTES

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-pressed={active}
            aria-label="Filter to events near you"
            className={cn(chipClass, active && activeClass)}
          >
            <LocateIcon className="size-3.5" />
            {active ? `≤ ${nearMinutes} min` : "Near me"}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium">Near me</span>
              <span className="font-mono text-xs text-muted-foreground">
                ≤ {shown} min drive
              </span>
            </div>
            <Slider
              value={[shown]}
              min={NEAR_MINUTES_MIN}
              max={NEAR_MINUTES_MAX}
              step={STEP}
              aria-label="Max drive time in minutes"
              onValueChange={([v]) => setDraft(v)}
              onValueCommit={([v]) => {
                setDraft(null)
                setFilters({ nearMinutes: v })
              }}
            />
            <p className="text-xs text-muted-foreground">
              Traffic-aware drive time from{" "}
              {userPos ? "your location" : "the city center"}.
            </p>
            {active && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setFilters({ nearMinutes: null })
                  setOpen(false)
                }}
              >
                <XIcon data-icon="inline-start" />
                Show everywhere
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {active && (
        <button
          type="button"
          aria-label="Clear near-me filter"
          onClick={() => setFilters({ nearMinutes: null })}
          className={cn(chipClass, "px-1.5")}
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </>
  )
}
