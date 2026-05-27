import { useMemo } from "react"
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
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
const CAROUSEL_MIN_W = 340
const CAROUSEL_MAX_W = 720

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
  const carouselMin = useGrapevine((s) => s.carouselMin)
  const carouselWidth = useGrapevine((s) => s.carouselWidth)
  const setCarouselMin = useGrapevine((s) => s.setCarouselMin)
  const setCarouselWidth = useGrapevine((s) => s.setCarouselWidth)

  const tour = useMemo(
    () => carouselEvents(events, filters, interests, now),
    [events, filters, interests, now],
  )

  const idx = tour.length ? carouselIdx % tour.length : 0
  const event = tour[idx]
  const eta = useEta(carouselOn ? event : null)

  // Drag the right edge to resize. The card is centered, so its width is twice
  // the pointer's distance from the viewport midline — the handle tracks the
  // cursor while both edges grow symmetrically.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const onMove = (ev: PointerEvent) => {
      const half = Math.abs(ev.clientX - window.innerWidth / 2)
      const max = Math.min(CAROUSEL_MAX_W, window.innerWidth - 32)
      setCarouselWidth(Math.min(max, Math.max(CAROUSEL_MIN_W, half * 2)))
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

  if (!event) return null

  const meta = CATEGORY_META[event.category]
  const live = isLive(event, now)

  const status = live ? (
    <>
      <span className="size-2 animate-pulse rounded-full bg-live" />
      <span className="text-live">Happening now</span>
    </>
  ) : (
    <span className="text-muted-foreground">Up next</span>
  )

  // Minimized: a compact pill that keeps the live status visible and expands
  // back to the full card on click.
  if (carouselMin) {
    return (
      <div className="glass absolute bottom-6 left-1/2 z-10 -translate-x-1/2 rounded-full">
        <button
          type="button"
          onClick={() => setCarouselMin(false)}
          aria-label="Expand happening-now panel"
          className="flex items-center gap-2.5 py-2 pr-3 pl-4 font-mono text-[11px] tracking-[0.18em] uppercase"
        >
          {status}
          <span className="text-muted-foreground">
            {idx + 1}/{tour.length}
          </span>
          <ChevronUpIcon className="size-4 text-muted-foreground" />
        </button>
      </div>
    )
  }

  return (
    <div
      style={{ width: carouselWidth }}
      className="glass absolute bottom-6 left-1/2 z-10 max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-xl"
    >
      <div className="flex flex-col gap-2 p-4 pb-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] uppercase">
            {status}
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
            <span className="mx-0.5 h-4 w-px bg-border/70" />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Minimize"
              onClick={() => setCarouselMin(true)}
            >
              <ChevronDownIcon />
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

      {/* drag the right edge to resize the card (grows from the center) */}
      <div
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        title="Drag to resize"
        className="group/resize absolute inset-y-0 right-0 z-30 flex w-2 cursor-ew-resize touch-none items-center justify-end"
      >
        <span className="h-8 w-1 rounded-full bg-border/80 transition-colors group-hover/resize:bg-ring" />
      </div>
    </div>
  )
}
