import { useEffect, useMemo, useState } from "react"
import {
  ClipboardPasteIcon,
  HeartIcon,
  InboxIcon,
  LogOutIcon,
  MailIcon,
  PinIcon,
  PinOffIcon,
  RotateCcwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
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
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { matchesFilters } from "@/lib/score"
import { useGrapevine } from "@/lib/store"
import { dayLabel, hasEnded, isLive } from "@/lib/time"
import {
  CATEGORY_META,
  DEFAULT_FILTERS,
  type CityEvent,
  type IngestRecord,
} from "@/lib/types"
import { cn } from "@/lib/utils"

export function AccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const user = useGrapevine((s) => s.user)
  const events = useGrapevine((s) => s.events)
  const filters = useGrapevine((s) => s.filters)
  const interests = useGrapevine((s) => s.interests)
  const settings = useGrapevine((s) => s.settings)
  const now = useGrapevine((s) => s.now)
  const select = useGrapevine((s) => s.select)
  const setFilters = useGrapevine((s) => s.setFilters)
  const setInterestsOpen = useGrapevine((s) => s.setInterestsOpen)
  const setAdminOpen = useGrapevine((s) => s.setAdminOpen)
  const signOut = useGrapevine((s) => s.signOut)
  const pinnedIds = useGrapevine((s) => s.pinnedIds)
  const togglePin = useGrapevine((s) => s.togglePin)

  const [history, setHistory] = useState<IngestRecord[] | null>(null)
  const [historyError, setHistoryError] = useState(false)
  const [query, setQuery] = useState("")

  // Fresh search each time the dialog opens (render-phase reset, per React docs).
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setQuery("")
  }

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

  const stats = useMemo(() => {
    const upcoming = events.filter((e) => !hasEnded(e, now))
    const terms = (e: CityEvent) => [
      ...e.tags.map((t) => t.toLowerCase()),
      e.category,
    ]
    return {
      onMap: events.filter((e) => matchesFilters(e, filters, interests, now))
        .length,
      boosted: upcoming.filter((e) =>
        terms(e).some((t) => interests.loves.includes(t)),
      ).length,
      hidden: upcoming.filter((e) =>
        terms(e).some((t) => interests.avoids.includes(t)),
      ).length,
    }
  }, [events, filters, interests, now])

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

  // Only bother with a search field once the inbox is long enough to hunt in.
  const totalEvents = useMemo(
    () => (history ?? []).reduce((n, r) => n + r.events.length, 0),
    [history],
  )
  const searchable = totalEvents > 5

  // Filter by newsletter name, subject, or any event title. A metadata hit
  // keeps the whole record; otherwise we narrow to the matching events.
  const shownRecords = useMemo(() => {
    if (!history) return []
    const q = query.trim().toLowerCase()
    if (!q) return history
    const out: IngestRecord[] = []
    for (const r of history) {
      const metaHit =
        r.source.toLowerCase().includes(q) ||
        !!r.subject?.toLowerCase().includes(q)
      const evs = metaHit
        ? r.events
        : r.events.filter((e) => e.title.toLowerCase().includes(q))
      if (metaHit || evs.length > 0) out.push({ ...r, events: evs })
    }
    return out
  }, [history, query])

  if (!user) return null

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
                {user.email} · Google
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
                  const ended = hasEnded(e, now)
                  const on = isLive(e, now)
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
                            dayLabel(
                              e.start,
                              settings?.tz ?? "America/Los_Angeles",
                              now,
                            )
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
                </>
              )}
            </div>
          </section>

          {/* inbox history */}
          <section>
            <SectionHeader
              icon={<InboxIcon className="size-3.5" />}
              title="From your inbox"
              action={
                history && history.length > 0 ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    {history.length}
                  </span>
                ) : undefined
              }
            />
            <div className="mt-2">
              {!history && !historyError && (
                <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                  <Spinner className="size-3.5" /> Loading history…
                </div>
              )}
              {historyError && (
                <p className="py-2 text-xs text-muted-foreground">
                  Couldn't load ingest history. Is the API running?
                </p>
              )}
              {history && history.length === 0 && (
                <div className="flex flex-col items-start gap-2 py-1">
                  <p className="text-xs text-muted-foreground">
                    No newsletters yet. Paste one into the ingest pipeline, or
                    deploy the email worker and they'll land here on their own.
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handOff(() => setAdminOpen(true))}
                  >
                    <ClipboardPasteIcon data-icon="inline-start" />
                    Paste a newsletter
                  </Button>
                </div>
              )}
              {history && history.length > 0 && (
                <div className="flex max-h-72 flex-col overflow-hidden rounded-lg border">
                  {searchable && (
                    <div className="relative shrink-0 border-b border-border">
                      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                      <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search your inbox…"
                        className="h-9 w-full bg-transparent pr-8 pl-8 text-xs outline-none placeholder:text-muted-foreground"
                      />
                      {query && (
                        <button
                          type="button"
                          onClick={() => setQuery("")}
                          aria-label="Clear search"
                          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                        >
                          <XIcon className="size-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                  <ScrollArea className="min-h-0 flex-1">
                    {shownRecords.length > 0 ? (
                      <div className="flex flex-col divide-y divide-border">
                        {shownRecords.map((r) => (
                          <IngestRow
                            key={r.id}
                            record={r}
                            events={events}
                            tz={settings?.tz ?? "America/Los_Angeles"}
                            now={now}
                            onSelect={(id) => handOff(() => select(id))}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                        No inbox events match “{query}”.
                      </p>
                    )}
                  </ScrollArea>
                </div>
              )}
            </div>
          </section>
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

function SectionHeader({
  icon,
  title,
  action,
}: {
  icon: React.ReactNode
  title: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex h-7 items-center justify-between">
      <span className="flex items-center gap-2 font-heading text-sm font-medium italic">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </span>
      {action}
    </div>
  )
}

/** "2h ago" / "yesterday" / "Jun 12" — coarse on purpose, it's a log. */
function timeAgo(iso: string, now: Date): string {
  const mins = Math.round((now.getTime() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return "yesterday"
  if (days < 7) return `${days}d ago`
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(iso))
}

function IngestRow({
  record,
  events,
  tz,
  now,
  onSelect,
}: {
  record: IngestRecord
  events: CityEvent[]
  tz: string
  now: Date
  onSelect: (id: string) => void
}) {
  const KindIcon = record.kind === "email" ? MailIcon : ClipboardPasteIcon
  return (
    <div className="flex flex-col gap-1 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-[13px]">
          <KindIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">{record.source}</span>
          {record.subject && (
            <span className="truncate text-xs text-muted-foreground">
              {record.subject}
            </span>
          )}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {timeAgo(record.receivedAt, now)}
        </span>
      </div>
      {record.events.length ? (
        <div className="flex flex-col">
          {record.events.map((snap) => {
            const live = events.find((e) => e.id === snap.id)
            const ended = live ? hasEnded(live, now) : true
            const isOn = live ? isLive(live, now) : false
            return (
              <button
                key={snap.id}
                type="button"
                disabled={!live || ended}
                onClick={() => live && onSelect(live.id)}
                className={cn(
                  "flex items-baseline justify-between gap-2 rounded-md px-1.5 py-1 text-left outline-none",
                  live && !ended
                    ? "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    : "cursor-default",
                )}
              >
                <span
                  className={cn(
                    "truncate text-xs",
                    (!live || ended) && "text-muted-foreground line-through decoration-border",
                  )}
                >
                  {snap.title}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                  {isOn ? (
                    <>
                      <span className="size-1.5 animate-pulse rounded-full bg-live" />
                      <span className="text-live">live</span>
                    </>
                  ) : ended || !live ? (
                    "ended"
                  ) : (
                    dayLabel(snap.start, tz, now)
                  )}
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <p className="pl-[22px] text-xs text-muted-foreground italic">
          {record.extracted > 0
            ? `${record.extracted} extracted, all already on the map`
            : "no events found in this one"}
        </p>
      )}
    </div>
  )
}
