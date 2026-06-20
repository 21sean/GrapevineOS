import { memo } from "react"
import { EyeOffIcon, PinIcon, RepeatIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { StarRating } from "@/components/StarRating"
import { useGrapevine } from "@/lib/store"
import { recurrenceSummary } from "@/lib/recurrence"
import { isLive, timeRange } from "@/lib/time"
import { CATEGORY_META, type CityEvent } from "@/lib/types"
import { cn } from "@/lib/utils"

// memo + per-card derived subscriptions: selecting, pinning, or a clock tick
// re-renders only the card whose *own* pixels change, not the whole list.
// Every selector below returns a primitive, so zustand's Object.is check
// swallows store writes that don't move this card.
export const EventCard = memo(function EventCard({
  event,
}: {
  event: CityEvent
}) {
  const select = useGrapevine((s) => s.select)
  const togglePin = useGrapevine((s) => s.togglePin)
  const hideEvent = useGrapevine((s) => s.hideEvent)
  const unhideEvent = useGrapevine((s) => s.unhideEvent)

  const live = useGrapevine((s) =>
    isLive(event, s.now, s.settings?.tz ?? "UTC")
  )
  const range = useGrapevine((s) =>
    timeRange(event, s.settings?.tz ?? "UTC", s.now)
  )
  // Highlight only while the detail is actually open, so closing it clears the
  // card the same moment it clears the map marker.
  const active = useGrapevine((s) => s.detailOpen && s.selectedId === event.id)
  const pinned = useGrapevine((s) => s.pinnedIds.includes(event.id))

  const repeats = recurrenceSummary(event.recurrence)
  const meta = CATEGORY_META[event.category]

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
        "group relative flex w-full cursor-pointer gap-2.5 rounded-lg border border-transparent bg-card/50 p-3 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        active && "border-ring/60 bg-accent"
      )}
    >
      {/* scraped og:image; the dominant color paints while (or if never) loading */}
      {event.imageUrl && (
        <img
          src={event.imageUrl}
          alt=""
          loading="lazy"
          onError={(e) => (e.currentTarget.style.display = "none")}
          className="size-14 shrink-0 self-center rounded-md object-cover"
          style={{ backgroundColor: event.imageColor ?? `${meta.color}33` }}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm leading-snug font-medium">
            {event.title}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {live && (
              <Badge className="bg-live font-mono text-[10px] text-live-foreground">
                LIVE
              </Badge>
            )}
            <button
              type="button"
              aria-label="Hide event"
              onClick={(e) => {
                e.stopPropagation()
                hideEvent(event.id)
                toast(`Hidden: ${event.title}`, {
                  description: "It won't show on the map or in the list.",
                  action: {
                    label: "Undo",
                    onClick: () => unhideEvent(event.id),
                  },
                })
              }}
              // gv-pin-btn: index.css keeps this visible on touch screens,
              // where the hover reveal can never fire
              className="gv-pin-btn -my-1 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <EyeOffIcon className="size-3.5" />
            </button>
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
                  : "gv-pin-btn text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
              )}
            >
              <PinIcon className={cn("size-3.5", pinned && "fill-current")} />
            </button>
          </div>
        </div>

        <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
          {repeats && (
            <RepeatIcon
              className="size-3 shrink-0"
              aria-label={`Repeats: ${repeats}`}
            />
          )}
          <span className="truncate">
            {range} · {event.venue}
          </span>
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
            <Badge
              variant="outline"
              className="font-mono text-[10px] text-wine"
            >
              RARE
            </Badge>
          )}
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {event.price}
          </span>
        </div>
      </div>
    </div>
  )
})
