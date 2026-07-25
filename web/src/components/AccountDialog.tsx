import { useEffect, useMemo, useState } from "react"
import {
  BellIcon,
  HeartIcon,
  LogOutIcon,
  MapPinIcon,
  NewspaperIcon,
  PinIcon,
  PinOffIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  VolumeXIcon,
  XIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { CalendarSync } from "@/components/account/CalendarSync"
import { InboxHistory } from "@/components/account/InboxHistory"
import { SectionHeader } from "@/components/account/SectionHeader"
import { useClock } from "@/hooks/useClock"
import { usePush } from "@/hooks/usePush"
import { api } from "@/lib/api"
import { selectVisible } from "@/lib/derived"
import { nextOccurrence } from "@/lib/recurrence"
import { interestTerms } from "@/lib/score"
import { useGrapevine } from "@/lib/store"
import { dayLabel, hasEnded, isLive } from "@/lib/time"
import {
  CATEGORY_META,
  DEFAULT_FILTERS,
  type CityEvent,
  type IngestRecord,
  type User,
} from "@/lib/types"
import { cn } from "@/lib/utils"

export function AccountDialog({
  user,
  open,
  onOpenChange,
}: {
  user: User
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const events = useGrapevine((s) => s.events)
  const visible = useGrapevine(selectVisible)
  const filters = useGrapevine((s) => s.filters)
  const interests = useGrapevine((s) => s.interests)
  const settings = useGrapevine((s) => s.settings)
  // Frozen while the dialog is closed — no tick re-renders in the background.
  const now = useClock(open)
  const select = useGrapevine((s) => s.select)
  const setFilters = useGrapevine((s) => s.setFilters)
  const setInterestsOpen = useGrapevine((s) => s.setInterestsOpen)
  const setAdminOpen = useGrapevine((s) => s.setAdminOpen)
  const signOut = useGrapevine((s) => s.signOut)
  const pinnedIds = useGrapevine((s) => s.pinnedIds)
  const togglePin = useGrapevine((s) => s.togglePin)
  const setCalendarOpen = useGrapevine((s) => s.setCalendarOpen)
  const mutedVenues = useGrapevine((s) => s.mutedVenues)
  const mutedSources = useGrapevine((s) => s.mutedSources)
  const unmuteVenue = useGrapevine((s) => s.unmuteVenue)
  const unmuteSource = useGrapevine((s) => s.unmuteSource)

  const [history, setHistory] = useState<IngestRecord[] | null>(null)
  const [historyError, setHistoryError] = useState(false)

  // Web Push state for THIS browser (subscriptions are per-device).
  const { pushState, pushBusy, togglePush } = usePush(open)

  useEffect(() => {
    if (!open) return
    api
      .ingestHistory()
      .then((h) => {
        setHistory(h)
        setHistoryError(false)
      })
      .catch(() => setHistoryError(true))
  }, [open])

  const tz = settings?.tz ?? "America/Los_Angeles"

  const stats = useMemo(() => {
    const upcoming = events.filter((e) => !hasEnded(e, now, tz))
    return {
      onMap: visible.length,
      boosted: upcoming.filter((e) =>
        interestTerms(e).some((t) => interests.loves.includes(t)),
      ).length,
      hidden: upcoming.filter((e) =>
        interestTerms(e).some((t) => interests.avoids.includes(t)),
      ).length,
    }
  }, [events, visible, interests, now, tz])

  // Resolve pinned ids to live events (dropping any since deleted).
  const pinnedEvents = useMemo(
    () =>
      pinnedIds
        .map((id) => events.find((e) => e.id === id))
        .filter((e): e is CityEvent => Boolean(e)),
    [pinnedIds, events],
  )

  const filtersDefault =
    JSON.stringify(filters) === JSON.stringify(DEFAULT_FILTERS)

  const memberSince = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(new Date(user.createdAt))

  /** Close this dialog, then run an action that opens something else. */
  const handOff = (action: () => void) => {
    onOpenChange(false)
    action()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        {/* identity */}
        <DialogHeader className="shrink-0 gap-3 p-4">
          <div className="flex items-center gap-4">
            <img
              src={user.picture}
              alt=""
              referrerPolicy="no-referrer"
              className="size-14 rounded-full ring-2 ring-live/40 ring-offset-2 ring-offset-popover"
            />
            <div className="min-w-0">
              <p className="font-mono text-[10px] tracking-[0.18em] text-live/90 uppercase">
                Member since {memberSince}
              </p>
              <DialogTitle className="mt-1 font-heading text-2xl font-semibold tracking-tight">
                {user.name}
              </DialogTitle>
              <DialogDescription className="mt-0.5 truncate">
                {user.email}
              </DialogDescription>
            </div>
          </div>

          {/* tonight, in numbers */}
          <div className="grid grid-cols-3 divide-x divide-border rounded-lg border bg-muted/30">
            <Stat value={stats.onMap} label="on your map" />
            <Stat
              value={stats.boosted}
              label="boosted for you"
              className={stats.boosted > 0 ? "text-live" : undefined}
            />
            <Stat
              value={stats.hidden}
              label="hidden by avoids"
              className={stats.hidden > 0 ? "text-destructive" : undefined}
            />
          </div>
        </DialogHeader>

        <Separator className="shrink-0" />

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {/* pinned */}
          <section>
            <SectionHeader
              icon={<PinIcon className="size-3.5" />}
              title="Pinned"
              action={
                pinnedEvents.length > 0 ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    {pinnedEvents.length}
                  </span>
                ) : undefined
              }
            />
            {pinnedEvents.length > 0 ? (
              <div className="mt-2 flex flex-col divide-y divide-border overflow-hidden rounded-lg border">
                {pinnedEvents.map((e) => {
                  const ended = hasEnded(e, now, tz)
                  const on = isLive(e, now, tz)
                  return (
                    <div
                      key={e.id}
                      className="flex items-center justify-between gap-2 pr-1.5 pl-3"
                    >
                      <button
                        type="button"
                        onClick={() => handOff(() => select(e.id))}
                        className="flex min-w-0 flex-1 items-baseline gap-2 py-2.5 text-left outline-none focus-visible:underline"
                      >
                        <span
                          className={cn(
                            "truncate text-[13px] font-medium",
                            ended &&
                              "text-muted-foreground line-through decoration-border",
                          )}
                        >
                          {e.title}
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                          {on ? (
                            <>
                              <span className="size-1.5 animate-pulse rounded-full bg-live" />
                              <span className="text-live">live</span>
                            </>
                          ) : ended ? (
                            "ended"
                          ) : (
                            dayLabel(nextOccurrence(e, now, tz).start, tz, now)
                          )}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label="Unpin event"
                        onClick={() => togglePin(e.id)}
                        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <PinOffIcon className="size-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                Nothing pinned yet. Tap the pin on any event to keep it on top
                of your list.
              </p>
            )}
          </section>

          {/* calendar sync */}
          <CalendarSync
            onOpenCalendar={() => handOff(() => setCalendarOpen(true))}
          />

          {/* notifications (per-browser Web Push) */}
          <section>
            <SectionHeader
              icon={<BellIcon className="size-3.5" />}
              title="Notifications"
            />
            {pushState && !pushState.supported ? (
              <p className="mt-2 text-xs text-muted-foreground">
                This browser doesn't support Web Push notifications.
              </p>
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                <label className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-2">
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">
                      Event reminders
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      A nudge 45 minutes before a saved event starts
                    </span>
                  </span>
                  <Switch
                    checked={!!pushState?.reminders}
                    disabled={!pushState || pushBusy}
                    onCheckedChange={(v) => void togglePush("reminders", v)}
                  />
                </label>
                <label className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-2">
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">
                      Leave-by alerts
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      "Time to leave" with live traffic, for events you're
                      going to
                    </span>
                  </span>
                  <Switch
                    checked={!!pushState?.leaveBy}
                    disabled={!pushState || pushBusy}
                    onCheckedChange={(v) => void togglePush("leaveBy", v)}
                  />
                </label>
                <label className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-2">
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">
                      Weekly digest
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      "Your week" top picks, Sunday evening
                    </span>
                  </span>
                  <Switch
                    checked={!!pushState?.weeklyDigest}
                    disabled={!pushState || pushBusy}
                    onCheckedChange={(v) => void togglePush("weeklyDigest", v)}
                  />
                </label>
                <label className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-2">
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">
                      Rare finds
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      The moment a rare one-off matching your "more like this"
                      picks lands
                    </span>
                  </span>
                  <Switch
                    checked={!!pushState?.rareFinds}
                    disabled={!pushState || pushBusy}
                    onCheckedChange={(v) => void togglePush("rareFinds", v)}
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  Notifications are per-browser. Reminders follow your saved
                  events; leave-by alerts time the drive (with traffic) to
                  anything you saved or marked "going", from your last known
                  spot; the digest and rare finds are ranked by your interests
                  and reactions.
                </p>
              </div>
            )}
          </section>

          {/* taste */}
          <section>
            <SectionHeader
              icon={<HeartIcon className="size-3.5" />}
              title="Your taste"
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  className="-my-1 h-7 text-xs"
                  onClick={() => handOff(() => setInterestsOpen(true))}
                >
                  Edit
                </Button>
              }
            />
            {interests.loves.length || interests.avoids.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {interests.loves.map((t) => (
                  <Badge
                    key={t}
                    variant="outline"
                    className="border-live/50 text-live"
                  >
                    {t}
                  </Badge>
                ))}
                {interests.avoids.map((t) => (
                  <Badge
                    key={t}
                    variant="outline"
                    className="border-destructive/50 text-destructive line-through"
                  >
                    {t}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                Nothing picked yet. The feed ranks on buzz alone. Pick a few
                interests and the map re-ranks around them.
              </p>
            )}
          </section>

          {/* muted venues & sources */}
          {(mutedVenues.length > 0 || mutedSources.length > 0) && (
            <section>
              <SectionHeader
                icon={<VolumeXIcon className="size-3.5" />}
                title="Muted"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {mutedVenues.map((v) => (
                  <MutedBadge
                    key={`v-${v}`}
                    label={v}
                    icon={<MapPinIcon className="size-3" />}
                    onRemove={() => unmuteVenue(v)}
                  />
                ))}
                {mutedSources.map((v) => (
                  <MutedBadge
                    key={`s-${v}`}
                    label={v}
                    icon={<NewspaperIcon className="size-3" />}
                    onRemove={() => unmuteSource(v)}
                  />
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Events from muted venues and sources stay off your map, list,
                digest, and alerts.
              </p>
            </section>
          )}

          {/* filters */}
          <section>
            <SectionHeader
              icon={<SlidersHorizontalIcon className="size-3.5" />}
              title="Filters"
              action={
                !filtersDefault && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-my-1 h-7 text-xs"
                    onClick={() => setFilters(DEFAULT_FILTERS)}
                  >
                    <RotateCcwIcon data-icon="inline-start" />
                    Reset
                  </Button>
                )
              }
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {filtersDefault ? (
                <p className="text-xs text-muted-foreground">
                  Defaults. Everything gets through except promoted junk.
                </p>
              ) : (
                <>
                  {filters.liveOnly && <Badge variant="secondary">Live only</Badge>}
                  {filters.rareOnly && <Badge variant="secondary">Rare finds</Badge>}
                  {filters.hidePromoted && (
                    <Badge variant="secondary">Hiding promoted</Badge>
                  )}
                  {filters.minRating > 0 && (
                    <Badge variant="secondary">
                      Buzz {filters.minRating.toFixed(1)}+
                    </Badge>
                  )}
                  {filters.categories.map((c) => (
                    <Badge key={c} variant="secondary" className="gap-1.5">
                      <span
                        className="size-2 rounded-full"
                        style={{ background: CATEGORY_META[c].color }}
                      />
                      {CATEGORY_META[c].label}
                    </Badge>
                  ))}
                  {filters.hideCategories.map((c) => (
                    <Badge key={`hide-${c}`} variant="secondary" className="gap-1.5">
                      <span
                        className="size-2 rounded-full opacity-40"
                        style={{ background: CATEGORY_META[c].color }}
                      />
                      No {CATEGORY_META[c].label.toLowerCase()}
                    </Badge>
                  ))}
                </>
              )}
            </div>
          </section>

          {/* inbox history */}
          <InboxHistory
            history={history}
            historyError={historyError}
            events={events}
            tz={tz}
            now={now}
            onSelect={(id) => handOff(() => select(id))}
            onOpenAdmin={() => handOff(() => setAdminOpen(true))}
          />
        </div>

        <DialogFooter className="mx-0 mb-0 shrink-0 items-center gap-3 rounded-b-xl sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Interests and filters sync to this account.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void signOut()
              onOpenChange(false)
            }}
          >
            <LogOutIcon data-icon="inline-start" />
            Sign out
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MutedBadge({
  label,
  icon,
  onRemove,
}: {
  label: string
  icon: React.ReactNode
  onRemove: () => void
}) {
  return (
    <Badge variant="outline" className="gap-1 pr-1 text-muted-foreground">
      {icon}
      <span className="max-w-40 truncate">{label}</span>
      <button
        type="button"
        aria-label={`Unmute ${label}`}
        onClick={onRemove}
        className="flex size-4 items-center justify-center rounded-full transition-colors hover:bg-accent hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </Badge>
  )
}

function Stat({
  value,
  label,
  className,
}: {
  value: number
  label: string
  className?: string
}) {
  return (
    <div className="flex flex-col items-center gap-0.5 px-2 py-2.5">
      <span className={cn("font-mono text-xl leading-none", className)}>
        {value}
      </span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  )
}
