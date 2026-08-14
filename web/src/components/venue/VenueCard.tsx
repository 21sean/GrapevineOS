import {
  AccessibilityIcon,
  ExternalLinkIcon,
  PhoneIcon,
  StoreIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { BusyTimes, type HourSpan } from "@/components/venue/BusyTimes"
import { openState, localWeekMinutes } from "@/lib/hours"
import type { VenueDetails } from "@/lib/types"
import { cn, safeHttpUrl } from "@/lib/utils"

/**
 * What Mapbox knows about the place an event is happening in: hours, photos,
 * accessibility, amenities, and typical busyness (Places API, public preview).
 *
 * Everything here is additive — each row only renders when Mapbox actually has
 * that field, so a venue with a bare record shows a couple of lines rather
 * than a scaffold of "Unknown". A venue with no record at all renders nothing,
 * and the detail panel reads exactly as it did before this existed.
 */
export function VenueCard({
  venue,
  loading,
  tz,
  now,
  occurrence,
  className,
}: {
  venue: VenueDetails | null
  loading: boolean
  /** App timezone, the fallback when Mapbox doesn't report the venue's own. */
  tz: string
  now: Date
  /** The occurrence being shown, so busyness can highlight its own hours. */
  occurrence: { start: string; end: string }
  className?: string
}) {
  if (loading) {
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }
  if (!venue) return null

  const zone = venue.tz ?? tz
  const open = venue.openingHours ? openState(venue.openingHours, zone, now) : null
  const website = safeHttpUrl(venue.website)

  // Map the occurrence onto the venue's own week for the busyness chart.
  const startLocal = localWeekMinutes(zone, new Date(occurrence.start))
  const endLocal = localWeekMinutes(zone, new Date(occurrence.end))
  const span: HourSpan | undefined = startLocal
    ? {
        from: Math.floor(startLocal.mins / 60),
        // Wall-clock end, not calendar end. A season-long run (the zoo's
        // Nighttime Zoo starts in July and ends in August) still means "half
        // three till nine, nightly", which is what the header already shows.
        // An end that isn't later in the day is a past-midnight event, so the
        // highlight runs to the end of the chart instead.
        to:
          endLocal && endLocal.mins > startLocal.mins
            ? Math.ceil(endLocal.mins / 60)
            : 24,
      }
    : undefined

  const subtitle = [venue.category, venue.priceLevel].filter(Boolean).join(" · ")

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border/60 bg-card/60 p-3",
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          The venue
        </span>
        {venue.popularity !== undefined && venue.popularity >= 0.7 && (
          <span className="text-xs text-muted-foreground">Well known locally</span>
        )}
      </div>

      {/* Photos come from the venue's own website, so they're a truer picture
          of the room than a promoter's event poster. Horizontal strip, because
          there are usually one or two and occasionally eight. */}
      {venue.photos.length > 0 && (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {venue.photos.map((p) => (
            <img
              key={p.url}
              src={p.url}
              alt=""
              loading="lazy"
              onError={(e) => {
                e.currentTarget.style.display = "none"
              }}
              className="h-24 w-32 shrink-0 rounded-md object-cover"
            />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-sm">
          <StoreIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">{venue.name}</span>
        </span>
        {subtitle && (
          <span className="pl-5 text-xs text-muted-foreground">{subtitle}</span>
        )}

        {venue.permanentlyClosed ? (
          <span className="pl-5 text-xs text-destructive">
            Mapbox lists this venue as permanently closed
          </span>
        ) : open ? (
          <span className="flex items-center gap-1.5 pl-5 text-xs">
            <span
              className={cn(
                "size-1.5 rounded-full",
                open.open ? "bg-live" : "bg-muted-foreground/50",
              )}
            />
            <span className={open.open ? "text-live" : "text-muted-foreground"}>
              {open.open
                ? open.at
                  ? `Open now · until ${open.at}`
                  : "Open now"
                : open.at
                  ? `Closed · opens ${open.laterInWeek ? "" : "at "}${open.at}`
                  : "Closed"}
            </span>
          </span>
        ) : (
          // Hours Mapbox gave us but shared/hours.ts couldn't parse: show them
          // verbatim rather than pretend we know whether the door is open.
          venue.openingHours && (
            <span className="pl-5 font-mono text-[11px] text-muted-foreground">
              {venue.openingHours}
            </span>
          )
        )}
      </div>

      {venue.activity && (
        <BusyTimes activity={venue.activity} day={startLocal?.day ?? 0} span={span} />
      )}

      {venue.accessibility.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <AccessibilityIcon className="size-3.5 shrink-0" />
            Accessibility
          </span>
          <ul className="flex flex-wrap gap-x-3 gap-y-0.5 pl-5">
            {venue.accessibility.map((a) => (
              <li key={a} className="text-xs text-muted-foreground">
                {a}
              </li>
            ))}
          </ul>
        </div>
      )}

      {venue.features.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {venue.features.map((f) => (
            <Badge key={f} variant="outline" className="font-normal">
              {f}
            </Badge>
          ))}
        </div>
      )}

      {(venue.phone || website) && (
        <div className="flex gap-2">
          {venue.phone && (
            <Button variant="outline" size="sm" className="flex-1" asChild>
              <a href={`tel:${venue.phone.replace(/[^\d+]/g, "")}`}>
                <PhoneIcon data-icon="inline-start" />
                Call
              </a>
            </Button>
          )}
          {website && (
            <Button variant="outline" size="sm" className="flex-1" asChild>
              <a href={website} target="_blank" rel="noreferrer">
                Venue site
                <ExternalLinkIcon data-icon="inline-end" />
              </a>
            </Button>
          )}
        </div>
      )}

      <span className="text-[10px] text-muted-foreground/70">
        Venue data from Mapbox Places
      </span>
    </div>
  )
}
