import { useMemo } from "react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { StarRating } from "@/components/StarRating"
import { useEta } from "@/hooks/useEta"
import { carouselEvents } from "@/lib/score"
import { useGrapevine } from "@/lib/store"
import { isLive, timeRange } from "@/lib/time"
import { CATEGORY_META } from "@/lib/types"

export const CAROUSEL_MS = 9000

export function CarouselOverlay() {
  const events = useGrapevine((s) => s.events)
  const filters = useGrapevine((s) => s.filters)
  const interests = useGrapevine((s) => s.interests)
  const now = useGrapevine((s) => s.now)
  const settings = useGrapevine((s) => s.settings)
  const carouselOn = useGrapevine((s) => s.carouselOn)
  const carouselIdx = useGrapevine((s) => s.carouselIdx)
  const setCarousel = useGrapevine((s) => s.setCarousel)
  const advanceCarousel = useGrapevine((s) => s.advanceCarousel)
  const select = useGrapevine((s) => s.select)

  const tour = useMemo(
    () => carouselEvents(events, filters, interests, now),
    [events, filters, interests, now],
  )

  const idx = tour.length ? carouselIdx % tour.length : 0
  const event = tour[idx]
  const eta = useEta(carouselOn ? event : null)

  if (!event) return null

  const meta = CATEGORY_META[event.category]
  const live = isLive(event, now)

  return (
    <div className="glass absolute bottom-6 left-1/2 z-10 w-[440px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-xl">
      <div className="flex flex-col gap-2 p-4 pb-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] uppercase">
            {live ? (
              <>
                <span className="size-2 animate-pulse rounded-full bg-live" />
                <span className="text-live">Happening now</span>
              </>
            ) : (
              <span className="text-muted-foreground">Up next</span>
            )}
            <span className="text-muted-foreground">
              {idx + 1}/{tour.length}
            </span>
          </span>
          <span className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous event"
              onClick={() =>
                advanceCarousel((idx - 1 + tour.length) % tour.length)
              }
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={carouselOn ? "Pause tour" : "Resume tour"}
              onClick={() => setCarousel(!carouselOn)}
            >
              {carouselOn ? <PauseIcon /> : <PlayIcon />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next event"
              onClick={() => advanceCarousel((idx + 1) % tour.length)}
            >
              <ChevronRightIcon />
            </Button>
          </span>
        </div>

        <button
          type="button"
          className="text-left"
          onClick={() => select(event.id)}
        >
          <h2 className="font-heading text-2xl leading-tight font-semibold hover:underline">
            {event.title}
          </h2>
        </button>

        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: meta.color }}
          />
          <span className="truncate">{event.venue}</span>
          <span className="shrink-0 font-mono text-xs">
            {timeRange(event, settings?.tz ?? "UTC", now)}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <StarRating rating={event.rating} showNumber />
          <span className="font-mono text-xs text-muted-foreground">
            {eta?.minutes != null ? `${eta.minutes} min away · ` : ""}
            {event.price}
          </span>
        </div>
      </div>

      {carouselOn && (
        <div
          key={`${event.id}-${carouselIdx}`}
          className="h-0.5 bg-live/90 motion-reduce:hidden"
          style={{ animation: `gv-progress ${CAROUSEL_MS}ms linear forwards` }}
        />
      )}
    </div>
  )
}
