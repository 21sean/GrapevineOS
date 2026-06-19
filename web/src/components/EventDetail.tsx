import { useState, type PointerEvent as ReactPointerEvent } from "react"
import {
  CalendarCheckIcon,
  CalendarPlusIcon,
  DownloadIcon,
  ExternalLinkIcon,
  EyeOffIcon,
  MapPinIcon,
  NavigationIcon,
  RepeatIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { StarRating } from "@/components/StarRating"
import { useEta } from "@/hooks/useEta"
import { useIsMobile } from "@/hooks/useIsMobile"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import { fmtTime, isLive, statusLabel } from "@/lib/time"
import { nextOccurrence, recurrenceSummary } from "@/lib/recurrence"
import { CATEGORY_META } from "@/lib/types"
import { cn } from "@/lib/utils"

// Desktop panel width bounds; the default (448) lives in the store.
const DETAIL_MIN = 360
const DETAIL_MAX = 640

export function EventDetail() {
  const events = useGrapevine((s) => s.events)
  const selectedId = useGrapevine((s) => s.selectedId)
  const detailOpen = useGrapevine((s) => s.detailOpen)
  const setDetailOpen = useGrapevine((s) => s.setDetailOpen)
  const settings = useGrapevine((s) => s.settings)
  const now = useGrapevine((s) => s.now)
  const userPos = useGrapevine((s) => s.userPos)
  const upsertEvent = useGrapevine((s) => s.upsertEvent)
  const user = useGrapevine((s) => s.user)
  const calendar = useGrapevine((s) => s.calendar)
  const setCalendar = useGrapevine((s) => s.setCalendar)
  const hideEvent = useGrapevine((s) => s.hideEvent)
  const unhideEvent = useGrapevine((s) => s.unhideEvent)
  const detailWidth = useGrapevine((s) => s.detailWidth)
  const setDetailWidth = useGrapevine((s) => s.setDetailWidth)

  const [rating, setRating] = useState(false)
  const [calBusy, setCalBusy] = useState(false)
  const isMobile = useIsMobile()

  const event = events.find((e) => e.id === selectedId)
  const eta = useEta(detailOpen ? event : null)
  if (!event) return null

  const meta = CATEGORY_META[event.category]
  const tz = settings?.tz ?? "UTC"
  const live = isLive(event, now, tz)
  const occ = nextOccurrence(event, now, tz)
  const repeats = recurrenceSummary(event.recurrence)

  async function recheckBuzz() {
    if (!event) return
    setRating(true)
    try {
      upsertEvent(await api.rate(event.id))
      toast.success("Buzz re-checked with the local model")
    } catch (err) {
      toast.error("Couldn't reach the model", {
        description: String(err).slice(0, 140),
      })
    } finally {
      setRating(false)
    }
  }

  const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${event.lat},${event.lng}`
  const saved = calendar?.synced.includes(event.id) ?? false

  async function toggleCalendar() {
    if (!event) return
    if (!user) {
      toast("Sign in to save events to your calendar", {
        action: {
          label: "Sign in",
          onClick: () => {
            window.location.href = "/auth/google"
          },
        },
      })
      return
    }
    setCalBusy(true)
    try {
      if (saved) {
        setCalendar(await api.calendarRemove(event.id))
        toast.success("Removed from your calendar", {
          description: calendar?.google
            ? "Deleted from Google Calendar too"
            : undefined,
        })
      } else {
        const res = await api.calendarAdd(event.id)
        setCalendar(res)
        toast.success("Added to your calendar", {
          description: res.warning
            ? "Google Calendar didn't sync — it's still in your Grapevine feed"
            : res.googleSynced
              ? "Synced to your Google Calendar"
              : "Connect Google Calendar in your account to sync",
        })
      }
    } catch (err) {
      toast.error("Calendar update failed", {
        description: String(err).slice(0, 140),
      })
    } finally {
      setCalBusy(false)
    }
  }

  function hideThis() {
    if (!event) return
    // the store closes this panel when the selected event is hidden
    hideEvent(event.id)
    toast(`Hidden: ${event.title}`, {
      description: "It won't show on the map or in the list.",
      action: { label: "Undo", onClick: () => unhideEvent(event.id) },
    })
  }

  // Drag the left edge to resize; width persists (device-local). Same
  // mechanics and handle as the FilterRail's right edge.
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = detailWidth
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(
        DETAIL_MAX,
        Math.max(DETAIL_MIN, startW + startX - ev.clientX),
      )
      setDetailWidth(next)
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

  const body = (
    <>
      <SheetHeader className="gap-2 pr-16">
        <span
          className="font-mono text-[11px] tracking-[0.18em] uppercase"
          style={{ color: meta.color }}
        >
          {meta.label} · {event.rarity}
        </span>
        <SheetTitle className="font-heading text-2xl leading-tight font-semibold">
          {event.title}
        </SheetTitle>
        <SheetDescription className="flex items-center gap-1.5">
          <MapPinIcon className="size-3.5 shrink-0" />
          {event.venue}
          {event.address ? `, ${event.address}` : ""}
        </SheetDescription>
      </SheetHeader>

      <div className="flex flex-col gap-4 px-4 pb-6">
        <div
          className={cn(
            "flex items-center justify-between rounded-lg border border-border/60 bg-card/60 px-3 py-2",
            // live events warm to lantern-gold, same signal as the map markers
            live && "border-live/30 bg-live/10",
          )}
        >
          <span className="flex items-center gap-2 text-sm">
            {live && <span className="size-2 animate-pulse rounded-full bg-live" />}
            {statusLabel(event, tz, now)}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {fmtTime(occ.start, tz)} – {fmtTime(occ.end, tz)}
          </span>
        </div>

        {repeats && (
          <div className="-mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <RepeatIcon className="size-3.5" />
            <span>{repeats} · next occurrence shown</span>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <StarRating rating={event.rating} showNumber />
            <Button
              variant="ghost"
              size="sm"
              onClick={recheckBuzz}
              disabled={rating}
            >
              {rating ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SparklesIcon data-icon="inline-start" />
              )}
              Re-check buzz
            </Button>
          </div>
          {event.ratingRationale && (
            <blockquote className="border-l-2 border-wine/60 pl-3 text-sm text-muted-foreground italic">
              “{event.ratingRationale}”
            </blockquote>
          )}
          {event.promoted && (
            <Badge variant="destructive" className="w-fit">
              Detected as promoted
            </Badge>
          )}
        </div>

        <p className="text-sm leading-relaxed">{event.description}</p>

        {event.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {event.tags.map((t) => (
              <Badge key={t} variant="secondary" className="font-normal">
                {t}
              </Badge>
            ))}
          </div>
        )}

        <Separator />

        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm">
            <NavigationIcon className="size-4 text-muted-foreground" />
            {eta?.minutes != null ? (
              <span>
                <span className="font-mono">{eta.minutes} min</span> drive ·{" "}
                <span className="font-mono">{eta.km} km</span>
              </span>
            ) : (
              <span className="text-muted-foreground">Checking traffic…</span>
            )}
          </span>
          <Button variant="outline" size="sm" asChild>
            <a href={gmaps} target="_blank" rel="noreferrer">
              Directions
              <ExternalLinkIcon data-icon="inline-end" />
            </a>
          </Button>
        </div>
        <span className="-mt-3 text-xs text-muted-foreground">
          Traffic-aware, from {userPos ? "your location" : "the city center"}
        </span>

        <div className="flex gap-2">
          <Button
            variant={saved ? "secondary" : "outline"}
            size="sm"
            className="flex-1"
            onClick={toggleCalendar}
            disabled={calBusy}
          >
            {calBusy ? (
              <Spinner data-icon="inline-start" />
            ) : saved ? (
              <CalendarCheckIcon data-icon="inline-start" />
            ) : (
              <CalendarPlusIcon data-icon="inline-start" />
            )}
            {saved ? "On your calendar" : "Add to calendar"}
          </Button>
          {/* Apple Calendar has no write API — .ics import is the reliable path. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" asChild>
                <a href={`/api/events/${event.id}/ics`} download>
                  <DownloadIcon data-icon="inline-start" />
                  .ics
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>For Apple Calendar and others</TooltipContent>
          </Tooltip>
        </div>

        {event.ticketUrl ? (
          <Button asChild className="w-full">
            <a href={event.ticketUrl} target="_blank" rel="noreferrer">
              Get tickets · {event.ticketProvider ?? "provider"} · {event.price}
              <ExternalLinkIcon data-icon="inline-end" />
            </a>
          </Button>
        ) : (
          <Alert>
            <AlertTitle>{event.free ? "Free · just show up" : event.price}</AlertTitle>
            <AlertDescription>
              No advance tickets needed for this one.
            </AlertDescription>
          </Alert>
        )}

        <span className="font-mono text-xs text-muted-foreground">
          via {event.source} · {event.sourceKind}
        </span>
      </div>
    </>
  )

  return (
    <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
      {/* Phones get an iOS-style bottom sheet; desktop floats a resizable
          glass panel over the map, matching the rail and tour card. */}
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        showCloseButton={false}
        style={
          isMobile
            ? undefined
            : { width: detailWidth, maxWidth: "min(40rem, calc(100vw - 2rem))" }
        }
        className={cn(
          "glass gap-0 bg-background/70 overflow-hidden",
          isMobile
            ? "max-h-[86svh] rounded-t-2xl border-b-0 pb-[env(safe-area-inset-bottom)]"
            : "rounded-xl data-[side=right]:inset-y-3 data-[side=right]:right-3 data-[side=right]:h-auto data-[side=right]:border",
        )}
      >
        {/* category wash: the panel is lit by the same hue as its map marker */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-28"
          style={{
            background: `linear-gradient(to bottom, color-mix(in oklab, ${meta.color} 15%, transparent), transparent)`,
          }}
        />
        {isMobile && (
          <div
            aria-hidden
            className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/40"
          />
        )}
        {isMobile ? (
          <div className="relative min-h-0 overflow-y-auto overscroll-contain">
            {body}
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">{body}</ScrollArea>
        )}

        <div className="absolute top-3 right-3 z-20 flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={hideThis}>
                <EyeOffIcon />
                <span className="sr-only">Hide event</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Hide this event</TooltipContent>
          </Tooltip>
          <SheetClose asChild>
            <Button variant="ghost" size="icon-sm">
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </SheetClose>
        </div>

        {!isMobile && (
          // drag the left edge to resize the panel
          <div
            onPointerDown={startResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize event details"
            title="Drag to resize"
            className="group/resize absolute inset-y-0 left-0 z-30 flex w-2 cursor-ew-resize touch-none items-center"
          >
            <span className="h-10 w-1 rounded-full bg-border/80 transition-colors group-hover/resize:bg-ring" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
