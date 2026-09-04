import { useCallback, useEffect, useState } from "react"
import {
  CalendarClockIcon,
  GlobeIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { StarRating } from "@/components/StarRating"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import {
  CATEGORY_META,
  type DiscoveryRunResult,
  type DiscoverySearch,
} from "@/lib/types"

const CADENCES = [
  { hours: 6, label: "Every 6 hours" },
  { hours: 12, label: "Twice a day" },
  { hours: 24, label: "Daily" },
  { hours: 72, label: "Every 3 days" },
  { hours: 168, label: "Weekly" },
]

const cadenceLabel = (hours: number) =>
  CADENCES.find((c) => c.hours === hours)?.label ?? `Every ${hours}h`

/**
 * Admin → Discover: build events from an AI web search. A run searches the
 * web, reads the top pages, extracts candidates, and verifies each one
 * against its source page — the preview shows what passed (with evidence)
 * and what got rejected (with the reason). Saved searches re-run themselves
 * on the server on a cadence.
 */
export function DiscoveryTab() {
  const refreshEvents = useGrapevine((s) => s.refreshEvents)
  const settings = useGrapevine((s) => s.settings)

  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [run, setRun] = useState<DiscoveryRunResult | null>(null)
  const [included, setIncluded] = useState<Set<string>>(new Set())

  const [searches, setSearches] = useState<DiscoverySearch[] | null>(null)
  const [cadence, setCadence] = useState(24)
  const [runningId, setRunningId] = useState<string | null>(null)

  const refreshSearches = useCallback(() => {
    api
      .discoverySearches()
      .then((r) => setSearches(r.searches))
      .catch(() => setSearches([]))
  }, [])

  useEffect(refreshSearches, [refreshSearches])

  async function preview() {
    setBusy(true)
    setRun(null)
    try {
      const res = await api.discoveryRun(query, true)
      setRun(res)
      setIncluded(new Set(res.verified.map((c) => c.event.id)))
      if (res.error) toast.error("Search failed", { description: res.error })
      else if (!res.verified.length)
        toast.info("Nothing verifiable found", {
          description: `${res.extracted} candidates extracted, none passed verification`,
        })
    } catch (err) {
      toast.error("Discovery failed", {
        description: String(err).slice(0, 180),
      })
    } finally {
      setBusy(false)
    }
  }

  async function commit() {
    if (!run) return
    const chosen = run.verified
      .filter((c) => included.has(c.event.id))
      .map((c) => c.event)
    try {
      const res = await api.commitEvents(chosen)
      await refreshEvents()
      toast.success(
        `Added ${res.added} event${res.added === 1 ? "" : "s"} to the map`
      )
      setRun(null)
      setQuery("")
    } catch (err) {
      toast.error("Couldn't save events", {
        description: String(err).slice(0, 140),
      })
    }
  }

  async function addSchedule() {
    try {
      await api.addDiscoverySearch(query, cadence)
      toast.success(
        `Scheduled: “${query.trim()}” ${cadenceLabel(cadence).toLowerCase()}`
      )
      refreshSearches()
    } catch (err) {
      toast.error("Couldn't schedule search", {
        description: String(err).slice(0, 140),
      })
    }
  }

  async function runNow(s: DiscoverySearch) {
    setRunningId(s.id)
    try {
      const res = await api.runDiscoverySearch(s.id)
      await refreshEvents()
      if (res.error)
        toast.error(`“${s.query}” failed`, { description: res.error })
      else
        toast.success(
          `“${s.query}”: ${res.added} new event${res.added === 1 ? "" : "s"}`,
          {
            description: `${res.extracted} extracted, ${res.verified.length} verified`,
          }
        )
    } catch (err) {
      toast.error("Run failed", { description: String(err).slice(0, 140) })
    } finally {
      setRunningId(null)
      refreshSearches()
    }
  }

  const canQuery = query.trim().length >= 3

  return (
    <div className="flex flex-col gap-5">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="discovery-query">
            Search the web for events
          </FieldLabel>
          <div className="flex gap-2">
            <Input
              id="discovery-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='e.g. "live jazz this month" or "night markets"'
              onKeyDown={(e) => {
                if (e.key === "Enter" && canQuery && !busy) void preview()
              }}
            />
            <Button onClick={preview} disabled={busy || !canQuery}>
              {busy ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SearchIcon data-icon="inline-start" />
              )}
              {busy ? "Verifying…" : "Preview"}
            </Button>
          </div>
          <FieldDescription>
            Searches near {settings?.city ?? "your city"}, reads the top pages,
            and verifies every candidate against its source before anything can
            land on the map. Takes a minute or two.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="discovery-cadence">
            …or run it on a schedule
          </FieldLabel>
          <div className="flex gap-2">
            <Select
              value={String(cadence)}
              onValueChange={(v) => setCadence(Number(v))}
            >
              <SelectTrigger id="discovery-cadence" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CADENCES.map((c) => (
                  <SelectItem key={c.hours} value={String(c.hours)}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              onClick={addSchedule}
              disabled={!canQuery}
            >
              <PlusIcon data-icon="inline-start" />
              Schedule
            </Button>
          </div>
          <FieldDescription>
            The server re-runs it and adds verified events automatically.
          </FieldDescription>
        </Field>
      </FieldGroup>

      {run && (run.verified.length > 0 || run.rejected.length > 0) && (
        <>
          <Separator />
          <div className="flex flex-col gap-3">
            <span className="text-sm text-muted-foreground">
              Read {run.pagesRead.length} page
              {run.pagesRead.length === 1 ? "" : "s"} · {run.extracted}{" "}
              extracted · {run.verified.length} verified · {run.rejected.length}{" "}
              rejected
            </span>

            {run.verified.map((c) => (
              <div
                key={c.event.id}
                className="flex items-start gap-3 rounded-lg border p-3"
              >
                <Switch
                  checked={included.has(c.event.id)}
                  onCheckedChange={(on) => {
                    setIncluded((prev) => {
                      const next = new Set(prev)
                      if (on) next.add(c.event.id)
                      else next.delete(c.event.id)
                      return next
                    })
                  }}
                  aria-label={`Include ${c.event.title}`}
                />
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-medium">{c.event.title}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {new Date(c.event.start).toLocaleString()} · {c.event.venue}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="secondary"
                      style={{ color: CATEGORY_META[c.event.category]?.color }}
                    >
                      {CATEGORY_META[c.event.category]?.label ??
                        c.event.category}
                    </Badge>
                    <Badge variant="outline" className="text-live">
                      {c.verdict === "corrected"
                        ? "verified (corrected)"
                        : "verified"}{" "}
                      {Math.round(c.confidence * 100)}%
                    </Badge>
                    {c.corroborations >= 2 && (
                      <Badge variant="outline">
                        {c.corroborations} sources
                      </Badge>
                    )}
                    <StarRating rating={c.event.rating} showNumber />
                    <span className="font-mono text-xs text-muted-foreground">
                      {c.event.price}
                    </span>
                  </div>
                  {c.evidence && (
                    <span className="text-xs text-muted-foreground italic">
                      “{c.evidence}”
                    </span>
                  )}
                  <a
                    href={c.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2"
                  >
                    <GlobeIcon className="size-3" />
                    {hostOf(c.sourceUrl)}
                  </a>
                </div>
              </div>
            ))}

            {run.verified.length > 0 && (
              <Button onClick={commit} disabled={included.size === 0}>
                <PlusIcon data-icon="inline-start" />
                Add {included.size} to the map
              </Button>
            )}

            {run.rejected.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  {run.rejected.length} rejected by verification
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  {run.rejected.map((c, i) => (
                    <div
                      key={`${c.event.id}-${i}`}
                      className="rounded-lg border border-dashed p-2.5 opacity-70"
                    >
                      <span className="text-sm">{c.event.title}</span>
                      <div className="font-mono text-xs text-muted-foreground">
                        {c.reason} · {hostOf(c.sourceUrl)}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </>
      )}

      <Separator />

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="flex items-center gap-2 font-heading text-base font-semibold">
            <CalendarClockIcon className="size-4" />
            Scheduled searches
          </h3>
          <p className="text-sm text-muted-foreground">
            Re-run on the server; verified finds land on the map automatically
            and show up in ingest history as “search”.
          </p>
        </div>

        {!searches && <Spinner className="mx-auto" />}
        {searches?.length === 0 && (
          <p className="text-sm text-muted-foreground italic">
            None yet — type a query above and hit Schedule.
          </p>
        )}
        {searches?.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-3 rounded-lg border p-3"
          >
            <Switch
              checked={s.active}
              onCheckedChange={async (on) => {
                try {
                  await api.patchDiscoverySearch(s.id, { active: on })
                } catch {
                  toast.error("Couldn't update search")
                } finally {
                  refreshSearches()
                }
              }}
              aria-label={`${s.active ? "Pause" : "Resume"} ${s.query}`}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{s.query}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {cadenceLabel(s.cadenceHours)}
                {s.lastRunAt
                  ? ` · last run ${new Date(s.lastRunAt).toLocaleString()}`
                  : " · never run"}
                {s.lastStatus ? ` · ${s.lastStatus}` : ""}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Run ${s.query} now`}
              disabled={runningId !== null}
              onClick={() => runNow(s)}
            >
              {runningId === s.id ? <Spinner /> : <PlayIcon />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${s.query}`}
              onClick={async () => {
                try {
                  await api.deleteDiscoverySearch(s.id)
                  toast.success("Scheduled search deleted")
                } catch {
                  toast.error("Couldn't delete search")
                } finally {
                  refreshSearches()
                }
              }}
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}
