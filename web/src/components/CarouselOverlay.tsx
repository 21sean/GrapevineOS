import { useRef } from "react"
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
import { DOCK_PEEK } from "@/components/MobileDock"
import { useEta } from "@/hooks/useEta"
import { useIsMobile } from "@/hooks/useIsMobile"
import { selectTour } from "@/lib/derived"
import { useGrapevine } from "@/lib/store"
import { isLive, timeRange } from "@/lib/time"
import { CATEGORY_META } from "@/lib/types"
import { cn } from "@/lib/utils"

export const CAROUSEL_MS = 9000
const CAROUSEL_MIN_W = 340
const CAROUSEL_MAX_W = 720

// Phones: the card rides just above the dock's peek strip.
const MOBILE_BOTTOM = `calc(env(safe-area-inset-bottom) + ${DOCK_PEEK + 12}px)`
// Horizontal travel that commits a swipe to the next/previous stop.
const SWIPE_COMMIT = 48

export function CarouselOverlay() {
  const carouselOn = useGrapevine((s) => s.carouselOn)
  const carouselIdx = useGrapevine((s) => s.carouselIdx)
  const setCarousel = useGrapevine((s) => s.setCarousel)
  const advanceCarousel = useGrapevine((s) => s.advanceCarousel)
  const select = useGrapevine((s) => s.select)
  const carouselMin = useGrapevine((s) => s.carouselMin)
  const carouselWidth = useGrapevine((s) => s.carouselWidth)
  const setCarouselMin = useGrapevine((s) => s.setCarouselMin)
  const setCarouselWidth = useGrapevine((s) => s.setCarouselWidth)

  const isMobile = useIsMobile()
  const dockState = useGrapevine((s) => s.dockState)

  // Shared with the map and App; keeps its reference across clock ticks that
  // don't change the tour, so this card doesn't re-render for them.
  const tour = useGrapevine(selectTour)

  const idx = tour.length ? carouselIdx % tour.length : 0
  const event = tour[idx]
  const eta = useEta(carouselOn ? event : null)
  // Derived primitives instead of the raw clock: a tick re-renders the card
  // only when the live flag or the printed time range actually changes.
  const live = useGrapevine((s) =>
    event ? isLive(event, s.now, s.settings?.tz ?? "UTC") : false
  )
  const range = useGrapevine((s) =>
    event ? timeRange(event, s.settings?.tz ?? "UTC", s.now) : ""
  )

  // Touch: a horizontal flick on the card is the mobile prev/next. The card
  // follows the finger (damped) for feedback, then springs back.
  const cardRef = useRef<HTMLDivElement>(null)
  const swipe = useRef<{
    pointerId: number
    x: number
    y: number
    dx: number
    active: boolean
  } | null>(null)

  const onSwipeStart = (e: React.PointerEvent) => {
    if (!isMobile) return
    swipe.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      dx: 0,
      active: false,
    }
  }

  const onSwipeMove = (e: React.PointerEvent) => {
    const s = swipe.current
    const el = cardRef.current
    if (!s || !el || e.pointerId !== s.pointerId) return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    if (!s.active) {
      if (Math.abs(dx) < 10) return
      if (Math.abs(dx) < Math.abs(dy) * 1.2) {
        swipe.current = null // reads as a vertical gesture, not ours
        return
      }
      s.active = true
      // capture retargets the gesture (and its click) away from the title
      // button, so a swipe never also opens the detail sheet
      try {
        e.currentTarget.setPointerCapture(s.pointerId)
      } catch {
        // pointer already gone; keep tracking without capture
      }
      el.style.transitionDuration = "0ms"
    }
    s.dx = dx
    const damped = Math.max(-84, Math.min(84, dx * 0.45))
    el.style.transform = `translateX(${damped}px)`
  }

  const onSwipeEnd = (e: React.PointerEvent) => {
    const s = swipe.current
    const el = cardRef.current
    if (!s || e.pointerId !== s.pointerId) return
    swipe.current = null
    if (!el) return
    el.style.transitionDuration = ""
    el.style.transform = ""
    if (s.active && Math.abs(s.dx) > SWIPE_COMMIT && tour.length > 1) {
      advanceCarousel(
        s.dx < 0
          ? (idx + 1) % tour.length
          : (idx - 1 + tour.length) % tour.length
      )
    }
  }

  // Drag the right edge to resize. The card is centered, so its width is twice
  // the pointer's distance from the viewport midline; the handle tracks the
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
      window.removeEventListener("pointercancel", onUp)
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
    }
    document.body.style.userSelect = "none"
    document.body.style.cursor = "ew-resize"
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
  }

  if (!event) return null
  // With the dock raised, the list is the focus; the tour card would just
  // sit behind the sheet fighting it for the map.
  if (isMobile && dockState !== "peek") return null

  const meta = CATEGORY_META[event.category]

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
      <div
        style={isMobile ? { bottom: MOBILE_BOTTOM } : undefined}
        className={cn(
          "glass absolute left-1/2 z-10 -translate-x-1/2 rounded-full",
          !isMobile && "bottom-6"
        )}
      >
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
      ref={cardRef}
      style={isMobile ? { bottom: MOBILE_BOTTOM } : { width: carouselWidth }}
      onPointerDown={onSwipeStart}
      onPointerMove={onSwipeMove}
      onPointerUp={onSwipeEnd}
      onPointerCancel={onSwipeEnd}
      className={cn(
        "glass absolute z-10 overflow-hidden rounded-xl",
        isMobile
          ? "inset-x-3 touch-none transition-transform duration-200 select-none"
          : "bottom-6 left-1/2 max-w-[calc(100vw-2rem)] -translate-x-1/2"
      )}
    >
      {/* scraped artwork as a dimmed backdrop; dominant color while it loads */}
      {event.imageUrl && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={
            event.imageColor
              ? { backgroundColor: `${event.imageColor}40` }
              : undefined
          }
        >
          <img
            src={event.imageUrl}
            alt=""
            onError={(e) => (e.currentTarget.style.display = "none")}
            className="h-full w-full object-cover opacity-25"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-background/85 via-background/50 to-background/30" />
        </div>
      )}
      <div className="relative flex flex-col gap-2 p-4 pb-3">
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
          <h2 className="font-heading text-xl leading-tight font-semibold hover:underline sm:text-2xl">
            {event.title}
          </h2>
        </button>

        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: meta.color }}
          />
          <span className="truncate">{event.venue}</span>
          <span className="shrink-0 font-mono text-xs">{range}</span>
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
          className="relative h-0.5 bg-live/90 motion-reduce:hidden"
          style={{ animation: `gv-progress ${CAROUSEL_MS}ms linear forwards` }}
        />
      )}

      {/* drag the right edge to resize the card (grows from the center);
          pointless under a thumb, so desktop only */}
      {!isMobile && (
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
      )}
    </div>
  )
}
