import { PinIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { StarRating } from "@/components/StarRating"
import { useGrapevine } from "@/lib/store"
import { isLive, timeRange } from "@/lib/time"
import { CATEGORY_META, type CityEvent } from "@/lib/types"
import { cn } from "@/lib/utils"

export function EventCard({ event }: { event: CityEvent }) {
  const now = useGrapevine((s) => s.now)
  const settings = useGrapevine((s) => s.settings)
  const selectedId = useGrapevine((s) => s.selectedId)
  const detailOpen = useGrapevine((s) => s.detailOpen)
  const select = useGrapevine((s) => s.select)
  const pinnedIds = useGrapevine((s) => s.pinnedIds)
  const togglePin = useGrapevine((s) => s.togglePin)

  const live = isLive(event, now)
  const meta = CATEGORY_META[event.category]
  // Highlight only while the detail is actually open, so closing it clears the
  // card the same moment it clears the map marker.
  const active = detailOpen && selectedId === event.id
  const pinned = pinnedIds.includes(event.id)

  return (
    // A card-as-button (rather than a real <button>) so the pin toggle can be a
    // real nested <button> without nesting interactive elements illegally.
    <div
      role="button"
      tabIndex={0}
      onClick={() => select(event.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return // let the pin button handle its own keys
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          select(event.id)
        }
      }}
      className={cn(
        "group relative flex w-full cursor-pointer flex-col gap-1.5 rounded-lg border border-transparent bg-card/50 p-3 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        active && "border-ring/60 bg-accent",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm leading-snug font-medium">{event.title}</span>
        <div className="flex shrink-0 items-center gap-1">
          {live && (
            <Badge className="bg-live font-mono text-[10px] text-live-foreground">
              LIVE
            </Badge>
          )}
          <button
            type="button"
            aria-label={pinned ? "Unpin event" : "Pin to top"}
            aria-pressed={pinned}
            onClick={(e) => {
              e.stopPropagation()
              togglePin(event.id)
            }}
            className={cn(
              "-my-1 -mr-1 flex size-6 items-center justify-center rounded-md transition hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              pinned
                ? "text-wine"
                : "text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            )}
          >
            <PinIcon className={cn("size-3.5", pinned && "fill-current")} />
          </button>
        </div>
      </div>

      <span className="font-mono text-xs text-muted-foreground">
        {timeRange(event, settings?.tz ?? "UTC", now)} · {event.venue}
      </span>

      <div className="flex items-center gap-2">
        <StarRating rating={event.rating} />
        <span
          className="inline-flex items-center gap-1 text-xs text-muted-foreground"
          style={{ color: meta.color }}
        >
          <span
            className="size-1.5 rounded-full"
            style={{ background: meta.color }}
          />
          {meta.label}
        </span>
        {event.rarity === "rare" && (
          <Badge variant="outline" className="font-mono text-[10px] text-wine">
            RARE
          </Badge>
        )}
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {event.price}
        </span>
      </div>
    </div>
  )
}
