import { NewspaperIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { StarRating } from "@/components/StarRating"
import { selectWeekPicks } from "@/lib/derived"
import { useGrapevine } from "@/lib/store"
import { nextOccurrence } from "@/lib/recurrence"
import { dayLabel, fmtTime } from "@/lib/time"
import { CATEGORY_META } from "@/lib/types"

/**
 * "Your week in San Diego" — the newsletter, inverted: instead of a newsletter
 * becoming pins on a map, the map's events rank themselves into a personal
 * digest. Top picks per day for the next 7 days, scored by buzz + interests +
 * everything the feedback loop has learned. Same data the Sunday push teases.
 */
export function WeekDigest() {
  const weekOpen = useGrapevine((s) => s.weekOpen)
  const setWeekOpen = useGrapevine((s) => s.setWeekOpen)
  const days = useGrapevine(selectWeekPicks)
  const city = useGrapevine((s) => s.settings?.city)
  const tz = useGrapevine((s) => s.settings?.tz) ?? "UTC"
  const now = useGrapevine((s) => s.now)
  const select = useGrapevine((s) => s.select)
  const interests = useGrapevine((s) => s.interests)
  const reactionCount = useGrapevine((s) => Object.keys(s.reactions).length)

  const untuned = !interests.loves.length && !reactionCount

  return (
    <Dialog open={weekOpen} onOpenChange={setWeekOpen}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 gap-1 p-4 pb-3">
          <p className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-live/90 uppercase">
            <NewspaperIcon className="size-3.5" />
            Personal digest
          </p>
          <DialogTitle className="font-heading text-2xl font-semibold tracking-tight">
            Your week in {city?.split(",")[0] ?? "town"}
          </DialogTitle>
          <DialogDescription>
            {untuned
              ? "Top-buzz picks for the next 7 days. Pick interests or react to events and this reranks around you."
              : "Ranked by your interests and reactions — the more you react, the sharper it gets."}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 px-4 pb-5">
            {days.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Nothing on the vine for the next 7 days.
              </p>
            )}
            {days.map(({ day, events }) => (
              <section key={day}>
                <h3 className="mb-1.5 font-heading text-sm font-medium italic">
                  {dayLabel(nextOccurrence(events[0], now, tz).start, tz, now)}
                </h3>
                <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border">
                  {events.map((e) => {
                    const occ = nextOccurrence(e, now, tz)
                    const meta = CATEGORY_META[e.category]
                    return (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => {
                          setWeekOpen(false)
                          select(e.id)
                        }}
                        className="flex items-center gap-3 p-2.5 text-left transition-colors outline-none hover:bg-accent focus-visible:bg-accent"
                      >
                        {e.imageUrl ? (
                          <img
                            src={e.imageUrl}
                            alt=""
                            loading="lazy"
                            onError={(ev) =>
                              (ev.currentTarget.style.visibility = "hidden")
                            }
                            className="size-12 shrink-0 rounded-md object-cover"
                            style={{
                              backgroundColor:
                                e.imageColor ?? `${meta.color}33`,
                            }}
                          />
                        ) : (
                          <span
                            aria-hidden
                            className="flex size-12 shrink-0 items-center justify-center rounded-md"
                            style={{ backgroundColor: `${meta.color}26` }}
                          >
                            <span
                              className="size-2 rounded-full"
                              style={{ background: meta.color }}
                            />
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium">
                            {e.title}
                          </span>
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">
                            {fmtTime(occ.start, tz)} · {e.venue}
                          </span>
                          <span className="mt-0.5 flex items-center gap-2">
                            <StarRating rating={e.rating} />
                            {e.free ? (
                              <Badge
                                variant="outline"
                                className="border-live/50 px-1.5 font-mono text-[9px] text-live"
                              >
                                FREE
                              </Badge>
                            ) : (
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {e.price}
                              </span>
                            )}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
