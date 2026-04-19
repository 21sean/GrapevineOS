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
  const select = useGrapevine((s) => s.select)

  const live = isLive(event, now)
  const meta = CATEGORY_META[event.category]

  return (
    <button
      type="button"
      onClick={() => select(event.id)}
      className={cn(
        "flex w-full flex-col gap-1.5 rounded-lg border border-transparent bg-card/50 p-3 text-left transition-colors hover:bg-accent",
        selectedId === event.id && "border-ring/60 bg-accent",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm leading-snug font-medium">{event.title}</span>
        {live && (
          <Badge className="shrink-0 bg-live font-mono text-[10px] text-live-foreground">
            LIVE
          </Badge>
        )}
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
    </button>
  )
}
