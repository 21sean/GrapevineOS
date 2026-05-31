import { useState } from "react"
import {
  CalendarCheckIcon,
  CalendarPlusIcon,
  DownloadIcon,
  ExternalLinkIcon,
  MapPinIcon,
  NavigationIcon,
  SparklesIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { StarRating } from "@/components/StarRating"
import { useEta } from "@/hooks/useEta"
import { useIsMobile } from "@/hooks/useIsMobile"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import { fmtTime, isLive, statusLabel } from "@/lib/time"
import { CATEGORY_META } from "@/lib/types"

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

  const [rating, setRating] = useState(false)
  const [calBusy, setCalBusy] = useState(false)
  const isMobile = useIsMobile()

  const event = events.find((e) => e.id === selectedId)
  const eta = useEta(detailOpen ? event : null)
  if (!event) return null

  const meta = CATEGORY_META[event.category]
  const tz = settings?.tz ?? "UTC"
  const live = isLive(event, now)

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

  return (
    <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
      {/* Phones get an iOS-style bottom sheet; desktop keeps the side panel. */}
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={
          isMobile
            ? "max-h-[86svh] gap-0 overflow-y-auto overscroll-contain rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
            : "w-full gap-0 overflow-y-auto sm:max-w-md"
        }
      >
        {isMobile && (
          <div
            aria-hidden
            className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/40"
          />
        )}
        <SheetHeader className="gap-2">
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
          <div className="flex items-center justify-between rounded-lg bg-card/60 px-3 py-2">
            <span className="flex items-center gap-2 text-sm">
              {live && <span className="size-2 animate-pulse rounded-full bg-live" />}
              {statusLabel(event, tz, now)}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {fmtTime(event.start, tz)} – {fmtTime(event.end, tz)}
            </span>
          </div>

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
            <Button variant="outline" size="sm" asChild>
              <a href={`/api/events/${event.id}/ics`} download>
                <DownloadIcon data-icon="inline-start" />
                .ics
              </a>
            </Button>
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
      </SheetContent>
    </Sheet>
  )
}
