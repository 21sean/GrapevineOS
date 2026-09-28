import { useMemo, useState } from "react"
import {
  ClipboardPasteIcon,
  GlobeIcon,
  InboxIcon,
  MailIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { SectionHeader } from "@/components/account/SectionHeader"
import { nextOccurrence } from "@/lib/recurrence"
import { dayLabel, hasEnded, isLive, relativeTime } from "@/lib/time"
import type { CityEvent, IngestRecord } from "@/lib/types"

/**
 * "From your inbox": the ingest history panel of the account dialog: every
 * newsletter/search/paste that produced events, searchable once it's long
 * enough to hunt in. The parent owns the fetch (so history survives
 * open/close); the search box state lives here and resets with each mount.
 */
export function InboxHistory({
  history,
  historyError,
  events,
  tz,
  now,
  onSelect,
  onOpenAdmin,
}: {
  history: IngestRecord[] | null
  historyError: boolean
  events: CityEvent[]
  tz: string
  now: Date
  onSelect: (id: string) => void
  onOpenAdmin: () => void
}) {
  const [query, setQuery] = useState("")

  // Ended events are history, not plans: drop them, and drop a record
  // entirely once nothing in it is still upcoming. Records that never
  // produced events stay visible as pipeline feedback.
  const fresh = useMemo(() => {
    if (!history) return null
    const out: IngestRecord[] = []
    for (const r of history) {
      const evs = r.events.filter((snap) => {
        const live = events.find((e) => e.id === snap.id)
        return live && !hasEnded(live, now, tz)
      })
      if (evs.length > 0 || r.events.length === 0)
        out.push({ ...r, events: evs })
    }
    return out
  }, [history, events, now, tz])

  // Only bother with a search field once the inbox is long enough to hunt in.
  const totalEvents = useMemo(
    () => (fresh ?? []).reduce((n, r) => n + r.events.length, 0),
    [fresh]
  )
  const searchable = totalEvents > 5

  // Filter by newsletter name, subject, or any event title. A metadata hit
  // keeps the whole record; otherwise we narrow to the matching events.
  const shownRecords = useMemo(() => {
    if (!fresh) return []
    const q = query.trim().toLowerCase()
    if (!q) return fresh
    const out: IngestRecord[] = []
    for (const r of fresh) {
      const metaHit =
        r.source.toLowerCase().includes(q) ||
        !!r.subject?.toLowerCase().includes(q)
      const evs = metaHit
        ? r.events
        : r.events.filter((e) => e.title.toLowerCase().includes(q))
      if (metaHit || evs.length > 0) out.push({ ...r, events: evs })
    }
    return out
  }, [fresh, query])

  return (
    <section>
      <SectionHeader
        icon={<InboxIcon className="size-3.5" />}
        title="From your inbox"
        action={
          fresh && fresh.length > 0 ? (
            <span className="font-mono text-xs text-muted-foreground">
              {fresh.length}
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
        {fresh && fresh.length === 0 && (
          <div className="flex flex-col items-start gap-2 py-1">
            <p className="text-xs text-muted-foreground">
              {history && history.length > 0
                ? "Nothing current from your inbox; everything already came and went. New newsletters land here on their own."
                : "No newsletters yet. Paste one into the ingest pipeline, or deploy the email worker and they'll land here on their own."}
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="h-7 text-xs"
              onClick={onOpenAdmin}
            >
              <ClipboardPasteIcon data-icon="inline-start" />
              Paste a newsletter
            </Button>
          </div>
        )}
        {fresh && fresh.length > 0 && (
          <div className="overflow-hidden rounded-lg border">
            {searchable && (
              <div className="relative border-b border-border">
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
            {/* Native scroll with the bound on the scroller itself. The account
                dialog's body is a content-sized scroll region, not a
                definite-height flex parent, so a flex-1 child (or a Radix
                ScrollArea viewport) collapses to zero here; an explicit
                max-height always clips and scrolls. */}
            <div className="scroll-thin max-h-72 overflow-y-auto overscroll-contain">
              {shownRecords.length > 0 ? (
                <div className="flex flex-col divide-y divide-border">
                  {shownRecords.map((r) => (
                    <IngestRow
                      key={r.id}
                      record={r}
                      events={events}
                      tz={tz}
                      now={now}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              ) : (
                <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                  No inbox events match “{query}”.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
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
  const KindIcon =
    record.kind === "email"
      ? MailIcon
      : record.kind === "search"
        ? GlobeIcon
        : ClipboardPasteIcon
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
          {relativeTime(record.receivedAt, now)}
        </span>
      </div>
      {record.events.length ? (
        <div className="flex flex-col">
          {/* the parent already dropped ended/vanished events, so every
              surviving snapshot maps to a live, upcoming event */}
          {record.events.map((snap) => {
            const live = events.find((e) => e.id === snap.id)
            if (!live) return null
            const isOn = isLive(live, now, tz)
            return (
              <button
                key={snap.id}
                type="button"
                onClick={() => onSelect(live.id)}
                className="flex items-baseline justify-between gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="truncate text-xs">{snap.title}</span>
                <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                  {isOn ? (
                    <>
                      <span className="size-1.5 animate-pulse rounded-full bg-live" />
                      <span className="text-live">live</span>
                    </>
                  ) : (
                    dayLabel(nextOccurrence(live, now, tz).start, tz, now)
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
