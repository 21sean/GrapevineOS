import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  EyeIcon,
  GemIcon,
  MegaphoneOffIcon,
  RadioIcon,
  SlidersHorizontalIcon,
  TicketIcon,
  Volume2Icon,
} from "lucide-react"
import { Separator } from "@/components/ui/separator"
import { DateQuickChips } from "@/components/DateFilters"
import { NearMeChip } from "@/components/NearMeChip"
import { EventCard } from "@/components/EventCard"
import {
  BuzzAndCategoryFilters,
  EventListEmpty,
  ListSearchSort,
} from "@/components/FilterRail"
import { useFilterToggles, type FilterToggle } from "@/hooks/useFilterToggles"
import { useOrderedEvents } from "@/hooks/useOrderedEvents"
import { activeFilterCount } from "@/lib/score"
import { useGrapevine } from "@/lib/store"
import { cn } from "@/lib/utils"

/**
 * Height of the dock's always-visible strip (grabber + heading + chip row),
 * excluding the home-indicator inset. The tour card parks just above it.
 */
export const DOCK_PEEK = 100

type Snap = "peek" | "half" | "full"

// Flicks faster than this (px/ms) jump a snap level regardless of distance.
const FLICK_V = 0.45
// Pointer travel below this is a tap, not a drag.
const DRAG_SLOP = 6

// Date quick filters restyled to match the dock's Chip buttons.
const DOCK_CHIP =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card/50 px-3 text-[13px] whitespace-nowrap transition-colors"
const DOCK_CHIP_ACTIVE = "border-wine/50 bg-wine/15 text-wine"

// The dock's look for the shared toggle descriptors (see useFilterToggles).
const CHIP_ICONS: Record<FilterToggle["key"], React.ReactNode> = {
  live: <RadioIcon className="size-3.5 text-live" />,
  rare: <GemIcon className="size-3.5 text-wine" />,
  free: <TicketIcon className="size-3.5 text-live" />,
  hidePromoted: <MegaphoneOffIcon className="size-3.5 text-muted-foreground" />,
}
const CHIP_ACTIVE: Record<FilterToggle["key"], string> = {
  live: "border-live/50 bg-live/15 text-live",
  rare: "border-wine/50 bg-wine/15 text-wine",
  free: "border-live/50 bg-live/15 text-live",
  hidePromoted: "border-foreground/30 bg-accent text-foreground",
}

function transformFor(snap: Snap) {
  if (snap === "full") return "translateY(0px)"
  if (snap === "half") return "translateY(52%)"
  return `translateY(calc(100% - ${DOCK_PEEK}px - env(safe-area-inset-bottom)))`
}

/**
 * Phone replacement for the desktop FilterRail: the event list lives in a
 * bottom sheet with three snap points (Apple Maps-style). Peek keeps the map
 * as the stage; drag up for the list, all the way for full browse.
 */
export function MobileDock() {
  const dockState = useGrapevine((s) => s.dockState)
  const setDockState = useGrapevine((s) => s.setDockState)
  const filters = useGrapevine((s) => s.filters)
  const { toggles } = useFilterToggles()
  const detailOpen = useGrapevine((s) => s.detailOpen)
  const hiddenCount = useGrapevine((s) => s.hiddenIds.length)
  const clearHidden = useGrapevine((s) => s.clearHidden)
  const mutedCount = useGrapevine(
    (s) => s.mutedVenues.length + s.mutedSources.length
  )
  const clearMuted = useGrapevine((s) => s.clearMuted)

  const { visible, ordered } = useOrderedEvents()
  const [filtersOpen, setFiltersOpen] = useState(false)

  const dockRef = useRef<HTMLDivElement>(null)
  // Invisible probe whose height is env(safe-area-inset-bottom) — the only
  // reliable way to get the inset as a number for the drag math.
  const safeProbeRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    pointerId: number
    startY: number
    startVisible: number
    height: number
    peekPx: number
    moved: boolean
    lastY: number
    lastT: number
    v: number
  } | null>(null)

  // Picking an event opens the detail sheet over everything; tuck the dock
  // back down so closing the detail lands on the map with the marker in view.
  useEffect(() => {
    if (detailOpen) setDockState("peek")
  }, [detailOpen, setDockState])

  useLayoutEffect(() => {
    const el = dockRef.current
    if (el) el.style.transform = transformFor(dockState)
  }, [dockState])

  const snapTo = (snap: Snap) => {
    const el = dockRef.current
    if (!el) return
    el.style.transitionDuration = ""
    el.style.transform = transformFor(snap)
    setDockState(snap)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return
    const el = dockRef.current
    if (!el) return
    const height = el.offsetHeight
    drag.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startVisible: window.innerHeight - el.getBoundingClientRect().top,
      height,
      peekPx: DOCK_PEEK + (safeProbeRef.current?.offsetHeight ?? 0),
      moved: false,
      lastY: e.clientY,
      lastT: e.timeStamp,
      v: 0,
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    const el = dockRef.current
    if (!d || !el || e.pointerId !== d.pointerId) return
    const dy = e.clientY - d.startY
    if (!d.moved) {
      if (Math.abs(dy) < DRAG_SLOP) return
      d.moved = true
      // capture retargets the rest of the gesture (and its click) to the
      // header, so a drag that starts on a chip never also toggles it
      try {
        e.currentTarget.setPointerCapture(d.pointerId)
      } catch {
        // pointer already gone — keep tracking without capture
      }
      el.style.transitionDuration = "0ms"
    }
    const dt = e.timeStamp - d.lastT
    if (dt > 0) d.v = (e.clientY - d.lastY) / dt
    d.lastY = e.clientY
    d.lastT = e.timeStamp
    const visiblePx = Math.min(
      d.height,
      Math.max(d.peekPx, d.startVisible - dy)
    )
    el.style.transform = `translateY(${d.height - visiblePx}px)`
  }

  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    drag.current = null
    if (!d.moved) return // plain tap — leave it to click handlers
    const visiblePx = Math.min(
      d.height,
      Math.max(d.peekPx, d.startVisible - (e.clientY - d.startY))
    )
    const halfPx = d.height * 0.48
    let next: Snap
    if (d.v < -FLICK_V) {
      next = visiblePx >= halfPx ? "full" : "half" // flung upward
    } else if (d.v > FLICK_V) {
      next = visiblePx <= halfPx ? "peek" : "half" // flung downward
    } else {
      const gaps: [Snap, number][] = [
        ["peek", Math.abs(visiblePx - d.peekPx)],
        ["half", Math.abs(visiblePx - halfPx)],
        ["full", Math.abs(visiblePx - d.height)],
      ]
      gaps.sort((a, b) => a[1] - b[1])
      next = gaps[0][0]
    }
    snapTo(next)
  }

  const filterCount = activeFilterCount(filters)

  return (
    <aside
      ref={dockRef}
      aria-label="Events"
      style={{ transform: transformFor(dockState) }}
      className="glass absolute inset-x-0 top-[calc(max(env(safe-area-inset-top),0.75rem)+3.75rem)] bottom-0 z-[15] flex flex-col overflow-hidden rounded-t-2xl border-b-0 pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] transition-transform duration-[420ms] ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform"
    >
      <div
        ref={safeProbeRef}
        aria-hidden
        className="pointer-events-none absolute h-[env(safe-area-inset-bottom)] w-px opacity-0"
      />

      {/* Drag surface: everything above the list moves the sheet. */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="shrink-0 select-none"
      >
        <div className="flex touch-none justify-center pt-2 pb-1">
          <button
            type="button"
            aria-label={
              dockState === "peek" ? "Expand event list" : "Collapse event list"
            }
            onClick={() => snapTo(dockState === "peek" ? "half" : "peek")}
            className="flex h-4 w-14 items-center justify-center"
          >
            <span className="h-1 w-10 rounded-full bg-muted-foreground/40" />
          </button>
        </div>

        <div className="flex h-6 touch-none items-baseline justify-between px-4">
          <span className="font-heading text-sm font-medium italic">
            Worth leaving the house for
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {visible.length}
          </span>
        </div>

        {/* Quick filters ride in the peek strip, one thumb-tap away.
            Free-only and farmers markets live in the Filters panel. */}
        <div className="flex touch-pan-x [scrollbar-width:none] gap-2 overflow-x-auto px-4 py-2 [&::-webkit-scrollbar]:hidden">
          {toggles
            .filter((t) => t.key !== "free")
            .map((t) => (
              <Chip
                key={t.key}
                active={t.active}
                activeClass={CHIP_ACTIVE[t.key]}
                onClick={t.toggle}
              >
                {CHIP_ICONS[t.key]}
                {t.shortLabel}
              </Chip>
            ))}
          {/* Today / Tomorrow / Weekend / range picker — the phone finally
              gets the date window the agent could always set */}
          <DateQuickChips
            chipClass={DOCK_CHIP}
            activeClass={DOCK_CHIP_ACTIVE}
          />
          {/* drive-time radius from wherever the user is standing */}
          <NearMeChip chipClass={DOCK_CHIP} activeClass={DOCK_CHIP_ACTIVE} />
          <Chip
            active={filtersOpen}
            activeClass="border-foreground/30 bg-accent text-foreground"
            onClick={() => {
              setFiltersOpen((o) => !o)
              // opening the tuning panel from peek would leave it below the
              // fold — bring the sheet up with it
              if (!filtersOpen && dockState === "peek") snapTo("half")
            }}
          >
            <SlidersHorizontalIcon className="size-3.5 text-muted-foreground" />
            Filters
            {filterCount > 0 && (
              <span className="rounded-full bg-wine/20 px-1.5 py-px font-mono text-[10px] text-wine">
                {filterCount}
              </span>
            )}
          </Chip>
        </div>
      </div>

      {filtersOpen && (
        <div className="animate-in px-4 pb-3 duration-150 fade-in-0 slide-in-from-top-1">
          <BuzzAndCategoryFilters />
        </div>
      )}

      <Separator />

      <div className="shrink-0 px-3 pt-2">
        <ListSearchSort />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="flex flex-col gap-2 p-3 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          {ordered.map((e) => (
            <EventCard key={e.id} event={e} />
          ))}
          {!ordered.length && <EventListEmpty />}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={clearHidden}
              className="mt-1 flex items-center justify-center gap-1.5 rounded-md py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <EyeIcon className="size-3.5" />
              Restore {hiddenCount} hidden event{hiddenCount === 1 ? "" : "s"}
            </button>
          )}
          {mutedCount > 0 && (
            <button
              type="button"
              onClick={clearMuted}
              className="mt-1 flex items-center justify-center gap-1.5 rounded-md py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Volume2Icon className="size-3.5" />
              {mutedCount === 1
                ? "Unmute 1 venue or source"
                : `Unmute ${mutedCount} venues & sources`}
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}

function Chip({
  active,
  activeClass,
  onClick,
  children,
}: {
  active: boolean
  activeClass: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card/50 px-3 text-[13px] whitespace-nowrap transition-colors",
        active && activeClass
      )}
    >
      {children}
    </button>
  )
}
