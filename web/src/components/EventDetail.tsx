import {
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"
import {
  CalendarCheckIcon,
  CalendarPlusIcon,
  DownloadIcon,
  ExternalLinkIcon,
  EyeOffIcon,
  FootprintsIcon,
  MapPinIcon,
  NavigationIcon,
  RepeatIcon,
  Share2Icon,
  SparklesIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TriangleAlertIcon,
  VolumeXIcon,
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
import { VenueCard } from "@/components/venue/VenueCard"
import { useClock } from "@/hooks/useClock"
import { useConflicts } from "@/hooks/useConflicts"
import { useEta } from "@/hooks/useEta"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useVenue } from "@/hooks/useVenue"
import { api } from "@/lib/api"
import { selectTagAffinity } from "@/lib/derived"
import { scoreParts } from "@/lib/score"
import { useGrapevine } from "@/lib/store"
import { fmtTime, isLive, statusLabel } from "@/lib/time"
import { nextOccurrence, recurrenceSummary } from "@/lib/recurrence"
import {
  CATEGORY_META,
  REACTION_META,
  type CityEvent,
  type Reaction,
} from "@/lib/types"
import { cn, safeHttpUrl } from "@/lib/utils"

// Desktop panel width bounds; the default (448) lives in the store.
const DETAIL_MIN = 360
const DETAIL_MAX = 640

const REACTION_BUTTONS: { value: Reaction; icon: typeof ThumbsUpIcon }[] = [
  { value: "going", icon: FootprintsIcon },
  { value: "went", icon: ThumbsUpIcon },
  { value: "not_for_me", icon: ThumbsDownIcon },
]

/**
 * The feedback loop's input: one tap files "going" / "went, great" / "not
 * for me". Tapping the active one clears it. The score reacts instantly:
 * this event moves, and its tags teach the ranking about lookalikes.
 */
function ReactionRow({ eventId }: { eventId: string }) {
  const reaction = useGrapevine((s) => s.reactions[eventId])
  const setReaction = useGrapevine((s) => s.setReaction)
  const user = useGrapevine((s) => s.user)

  function pick(r: Reaction) {
    const next = reaction === r ? null : r
    setReaction(eventId, next)
    if (next) {
      toast.success(`Noted: ${REACTION_META[next].label}`, {
        description: `${REACTION_META[next].blurb}${user ? "" : ". Sign in to keep this across devices"}`,
      })
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        Your take
      </span>
      <div className="flex gap-2">
        {REACTION_BUTTONS.map(({ value, icon: Icon }) => (
          <Button
            key={value}
            variant={reaction === value ? "secondary" : "outline"}
            size="sm"
            aria-pressed={reaction === value}
            onClick={() => pick(value)}
            className={cn(
              "h-auto min-w-0 flex-1 flex-col gap-1 px-2 py-2 text-xs whitespace-normal sm:h-8 sm:flex-row sm:text-sm",
              reaction === value &&
                (value === "not_for_me"
                  ? "border-destructive/40 text-destructive"
                  : "border-live/40 text-live")
            )}
          >
            <Icon data-icon="inline-start" />
            {REACTION_META[value].label}
          </Button>
        ))}
      </div>
    </div>
  )
}

/**
 * What moved this event up or down the list, straight from the same parts
 * the ranking sums. The buzz baseline is on the stars already, so it is left
 * out; the rest are ordered by how much they mattered.
 */
function RankReasons({
  event,
  now,
  tz,
}: {
  event: CityEvent
  now: Date
  tz: string
}) {
  const interests = useGrapevine((s) => s.interests)
  const reactions = useGrapevine((s) => s.reactions)
  const tagAffinity = useGrapevine(selectTagAffinity)
  const parts = scoreParts(event, interests, now, tz, {
    reactions,
    tagAffinity,
  })
    .filter((p) => p.key !== "buzz")
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .slice(0, 4)
  if (!parts.length) return null

  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        Why it's ranked here
      </span>
      <ul className="flex flex-wrap gap-1.5">
        {parts.map((p) => (
          <li
            key={p.key}
            className={cn(
              "rounded-full border px-2 py-0.5 text-xs",
              p.points > 0
                ? "border-live/30 text-live"
                : "border-destructive/30 text-destructive"
            )}
          >
            {p.points > 0 ? "↑" : "↓"} {p.label}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function EventDetail() {
  // Subscribe to the selected event itself, not the whole list; unrelated
  // event refreshes and selections of other panels don't re-render this one.
  const event = useGrapevine((s) => s.events.find((e) => e.id === s.selectedId))
  const detailOpen = useGrapevine((s) => s.detailOpen)
  const setDetailOpen = useGrapevine((s) => s.setDetailOpen)
  const settings = useGrapevine((s) => s.settings)
  // Tick only while open: the countdown ("Starts in 12 min") should update
  // live, but a closed panel shouldn't re-render twice a minute.
  const now = useClock(detailOpen)
  const userPos = useGrapevine((s) => s.userPos)
  const upsertEvent = useGrapevine((s) => s.upsertEvent)
  const user = useGrapevine((s) => s.user)
  const calendar = useGrapevine((s) => s.calendar)
  const setCalendar = useGrapevine((s) => s.setCalendar)
  const hideEvent = useGrapevine((s) => s.hideEvent)
  const unhideEvent = useGrapevine((s) => s.unhideEvent)
  const detailWidth = useGrapevine((s) => s.detailWidth)
  const setDetailWidth = useGrapevine((s) => s.setDetailWidth)
  const select = useGrapevine((s) => s.select)
  const setSearchQuery = useGrapevine((s) => s.setSearchQuery)
  const muteVenue = useGrapevine((s) => s.muteVenue)
  const unmuteVenue = useGrapevine((s) => s.unmuteVenue)
  const muteSource = useGrapevine((s) => s.muteSource)
  const unmuteSource = useGrapevine((s) => s.unmuteSource)

  const [rating, setRating] = useState(false)
  const [calBusy, setCalBusy] = useState(false)
  const isMobile = useIsMobile()

  const eta = useEta(detailOpen ? event : null)
  // Only while open: the Places preview quota is 1,000 records a month, so a
  // venue lookup should cost something only when someone is actually looking.
  const venue = useVenue(detailOpen ? event : null)
  const tz = settings?.tz ?? "UTC"
  // Calendar clashes: other saved events and (when connected) Google busy
  // blocks that overlap this occurrence.
  const conflicts = useConflicts(event, detailOpen, now, tz)

  // Mirror the open event into ?event=<id> so the address bar is itself a
  // shareable deep link. App.tsx already restores it on load (the push
  // notification path). replaceState keeps Back for the map, not sheet history.
  const eventId = event?.id
  useEffect(() => {
    const url = new URL(window.location.href)
    const current = url.searchParams.get("event")
    const next = detailOpen && eventId ? eventId : null
    if (current === next) return
    if (next) url.searchParams.set("event", next)
    else url.searchParams.delete("event")
    window.history.replaceState(null, "", url)
  }, [detailOpen, eventId])

  if (!event) return null

  const meta = CATEGORY_META[event.category]
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
  // ticketUrl is LLM-extracted from untrusted sources; only link it if it's http(s).
  const ticketUrl = safeHttpUrl(event.ticketUrl)

  async function toggleCalendar() {
    if (!event) return
    if (!user) {
      toast("Sign in to save events to your calendar", {
        action: {
          label: "Sign in",
          onClick: () => useGrapevine.getState().setSignInOpen(true),
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
            ? "Google Calendar didn't sync, but it's still in your Grapevine feed"
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

  function muteVenueThis() {
    if (!event) return
    const venue = event.venue
    muteVenue(venue)
    select(null) // the event just left the map; don't strand its panel
    toast(`Muted venue: ${venue}`, {
      description: "Nothing from this venue on your map, list, or digest.",
      action: { label: "Undo", onClick: () => unmuteVenue(venue) },
    })
  }

  function muteSourceThis() {
    if (!event) return
    const source = event.source
    muteSource(source)
    select(null)
    toast(`Muted source: ${source}`, {
      description: "Nothing from this source on your map, list, or digest.",
      action: { label: "Undo", onClick: () => unmuteSource(source) },
    })
  }

  // "Want to go to this?": the ?event= deep link the push notifications
  // already use, handed to the native share sheet where there is one and the
  // clipboard everywhere else.
  async function shareEvent() {
    if (!event) return
    const url = new URL(window.location.origin + window.location.pathname)
    url.searchParams.set("event", event.id)
    const link = url.toString()
    const data = {
      title: event.title,
      text: `${event.title} at ${event.venue}`,
      url: link,
    }
    if (navigator.canShare?.(data)) {
      try {
        await navigator.share(data)
      } catch {
        // user closed the share sheet; not an error
      }
      return
    }
    try {
      await navigator.clipboard.writeText(link)
      toast.success("Link copied", {
        description: "Opens the map right on this event.",
      })
    } catch {
      toast.error("Couldn't copy the link", { description: link })
    }
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
        Math.max(DETAIL_MIN, startW + startX - ev.clientX)
      )
      setDetailWidth(next)
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

  const body = (
    <>
      {/* scraped og:image as a hero. Sources vary wildly (a tall gig poster,
          a wide logo banner, a landscape photo), so we letterbox: a blurred,
          zoomed copy fills the frame while the real image sits *contained* on
          top, whole and uncropped. The dominant color holds the space while it
          loads; a load failure collapses the whole banner. */}
      {event.imageUrl && (
        <div
          className="relative -mb-2 h-44 shrink-0 overflow-hidden"
          style={
            event.imageColor ? { backgroundColor: event.imageColor } : undefined
          }
        >
          <img
            src={event.imageUrl}
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-2xl"
          />
          <img
            src={event.imageUrl}
            alt=""
            onError={(e) => {
              e.currentTarget.parentElement!.style.display = "none"
            }}
            className="relative h-full w-full object-contain"
          />
          {/* top scrim keeps the share/hide/close controls legible over a
              light image; bottom scrim blends the hero into the sheet body */}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background/70 via-transparent to-transparent" />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-background/95 via-background/25 to-transparent" />
        </div>
      )}
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
            live && "border-live/30 bg-live/10"
          )}
        >
          <span className="flex items-center gap-2 text-sm">
            {live && (
              <span className="size-2 animate-pulse rounded-full bg-live" />
            )}
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

        {/* schedule clash with saved events / the connected Google Calendar */}
        {conflicts && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2">
            <span className="flex items-center gap-2 text-sm text-amber-200">
              <TriangleAlertIcon className="size-4 shrink-0" />
              Overlaps your calendar
            </span>
            <ul className="flex flex-col gap-1 pl-6">
              {conflicts.saved.map((c) => (
                <li key={c.event.id} className="text-xs text-amber-200/90">
                  <button
                    type="button"
                    onClick={() => select(c.event.id)}
                    className="text-left underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                  >
                    {c.event.title}
                  </button>{" "}
                  · {fmtTime(c.start, tz)} – {fmtTime(c.end, tz)}
                </li>
              ))}
              {conflicts.google.map((g) => (
                <li key={g.id} className="text-xs text-amber-200/70">
                  {g.title || "Busy"} · {fmtTime(g.start, tz)} –{" "}
                  {fmtTime(g.end, tz)} · Google Calendar
                </li>
              ))}
            </ul>
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
              <Badge
                key={t}
                variant="secondary"
                className="font-normal hover:bg-secondary/70"
                asChild
              >
                <button
                  type="button"
                  aria-label={`Search for ${t}`}
                  onClick={() => {
                    setSearchQuery(t)
                    setDetailOpen(false)
                  }}
                >
                  {t}
                </button>
              </Badge>
            ))}
          </div>
        )}

        <RankReasons event={event} now={now} tz={tz} />

        <ReactionRow eventId={event.id} />

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
              <span className="text-muted-foreground">
                {eta ? "Drive time unavailable" : "Checking traffic…"}
              </span>
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

        {/* what you're walking into: the venue's own hours, photos, access,
            and how busy it usually is at this event's hour */}
        <VenueCard
          venue={venue.data}
          loading={venue.loading}
          tz={tz}
          now={now}
          occurrence={occ}
        />

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
          {/* Apple Calendar has no write API; .ics import is the reliable path. */}
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

        {ticketUrl ? (
          <Button asChild className="w-full">
            <a href={ticketUrl} target="_blank" rel="noreferrer">
              Get tickets · {event.ticketProvider ?? "provider"} · {event.price}
              <ExternalLinkIcon data-icon="inline-end" />
            </a>
          </Button>
        ) : (
          <Alert>
            <AlertTitle>
              {event.free ? "Free · just show up" : event.price}
            </AlertTitle>
            <AlertDescription>
              No advance tickets needed for this one.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-xs text-muted-foreground">
            via {event.source} · {event.sourceKind}
          </span>
          {/* recurring-offender controls: silence the place or the source
              wholesale instead of hiding one occurrence at a time */}
          <div className="flex gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={muteVenueThis}>
                  <VolumeXIcon data-icon="inline-start" />
                  Mute venue
                </Button>
              </TooltipTrigger>
              <TooltipContent>Hide every event at {event.venue}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={muteSourceThis}>
                  <VolumeXIcon data-icon="inline-start" />
                  Mute source
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Hide every event from {event.source}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
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
          "glass gap-0 overflow-hidden",
          isMobile
            ? "max-h-[86svh] rounded-t-2xl border-b-0 bg-background/95 pb-[env(safe-area-inset-bottom)]"
            : "rounded-xl bg-background/70 data-[side=right]:inset-y-3 data-[side=right]:right-3 data-[side=right]:h-auto data-[side=right]:border"
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

        <div className="absolute top-3 right-3 z-20 flex items-center gap-0.5 rounded-full bg-background/40 p-0.5 backdrop-blur-sm">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={shareEvent}>
                <Share2Icon />
                <span className="sr-only">Share event</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Share a link to this event</TooltipContent>
          </Tooltip>
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
