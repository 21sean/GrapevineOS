import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronRightIcon,
  RefreshCwIcon,
  ShieldIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import {
  GUARDRAIL_MODES,
  type GuardrailDashboard,
  type GuardrailLabel,
  type GuardrailRail,
  type GuardrailRailStats,
  type GuardrailScan,
  type GuardrailSweepPoint,
  type GuardrailWindow,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Admin → Guardrails.
 *
 * The panel exists because of one gap: the rails scored every message and only
 * ever surfaced the ones they blocked. With no view of the scores on traffic
 * that passed, the threshold could not be tuned and a classifier drifting into
 * false positives looked exactly like a quiet week.
 *
 * So the page is ordered by the questions an operator actually asks, in order:
 *
 *   1. is the rail on, and is it actually working (it fails open)
 *   2. what does the score distribution look like, and has it moved
 *   3. what would a different threshold cost
 *   4. which specific decisions were wrong
 *
 * Nothing here computes a statistic of its own. The histogram and percentiles
 * come from one Postgres function, the drift and sweep from server/src/
 * guardrails/stats.ts. A dashboard that does its own maths eventually
 * disagrees with the thing it is reporting on, and then nobody can tell which
 * one is lying.
 */

const RAIL_LABEL: Record<GuardrailRail, { title: string; blurb: string }> = {
  input: {
    title: "Input rail",
    blurb: "Every message a person types, before the agent sees it.",
  },
  content: {
    title: "Content rail",
    blurb: "Web text the agent fetched, before it enters the model's context.",
  },
  output: {
    title: "Output rail",
    blurb: "The persona scrubber on the streamed reply. Deterministic, so no scores.",
  },
}

const DRIFT_STYLE: Record<GuardrailRailStats["driftVerdict"], { text: string; label: string }> = {
  stable: { text: "text-chart-3", label: "stable" },
  moderate: { text: "text-chart-2", label: "moved a little" },
  significant: { text: "text-destructive", label: "moved" },
  unknown: { text: "text-muted-foreground", label: "not enough history" },
}

const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 && v > 0 ? 1 : 0)}%`
const num = (v: number | null, digits = 3) => (v === null ? "—" : v.toFixed(digits))

function when(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

// ---------------------------------------------------------------------------

/** One number with a label under it. The strip along the top of the page. */
function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
        {label}
      </span>
      <span className={cn("font-mono text-lg leading-none", tone)}>{value}</span>
      {hint && <span className="truncate text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  )
}

/**
 * The score histogram, with the threshold drawn on it.
 *
 * Log-scaled heights: real traffic is overwhelmingly benign, so on a linear
 * scale the first bucket is the whole chart and every bucket that matters is
 * one pixel tall. The thing an operator is looking for here is the shape of
 * the tail, and a linear axis hides exactly that.
 */
function Histogram({
  window: w,
  threshold,
  baseline,
}: {
  window: GuardrailWindow
  threshold: number
  baseline: GuardrailWindow | null
}) {
  const max = Math.max(1, ...w.buckets.map((b) => b.n))
  const height = (n: number) => (n === 0 ? 0 : Math.max(3, (Math.log1p(n) / Math.log1p(max)) * 100))
  const baseMax = Math.max(1, ...(baseline?.buckets ?? []).map((b) => b.n))

  if (!w.scored) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground italic">
        No scored decisions in this window.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="relative flex h-28 items-end gap-px">
        {w.buckets.map((b, i) => {
          const over = b.lo >= threshold
          const baseN = baseline?.buckets[i]?.n ?? 0
          return (
            <div key={b.lo} className="group relative flex flex-1 items-end justify-center">
              {/* The previous window, behind — a ghost outline so a shift in
                  shape is visible without a second chart to compare against. */}
              {baseline && baseN > 0 && (
                <div
                  aria-hidden
                  className="absolute bottom-0 w-full rounded-t-[2px] border border-dashed border-muted-foreground/35"
                  style={{
                    height: `${baseN === 0 ? 0 : Math.max(3, (Math.log1p(baseN) / Math.log1p(baseMax)) * 100)}%`,
                  }}
                />
              )}
              <div
                className={cn(
                  "w-full rounded-t-[2px] transition-opacity",
                  over ? "bg-destructive/70" : "bg-chart-3/60",
                  b.n === 0 && "bg-transparent",
                )}
                style={{ height: `${height(b.n)}%` }}
              />
              <span className="pointer-events-none absolute -top-6 left-1/2 z-10 hidden -translate-x-1/2 rounded bg-popover px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-popover-foreground shadow group-hover:block">
                {b.lo.toFixed(2)}–{b.hi.toFixed(2)}: {b.n}
              </span>
            </div>
          )
        })}
        {/* Threshold line, positioned by score not by bucket index. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-foreground/60"
          style={{ left: `${threshold * 100}%` }}
        />
      </div>
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>0.0 benign</span>
        <span>threshold {threshold.toFixed(2)}</span>
        <span>1.0 malicious</span>
      </div>
    </div>
  )
}

function RailCard({ rail, threshold }: { rail: GuardrailRailStats; threshold: number }) {
  const meta = RAIL_LABEL[rail.rail]
  const w = rail.recent
  const drift = DRIFT_STYLE[rail.driftVerdict]
  const blockRate = w.n ? w.blocked / w.n : 0

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">{meta.title}</span>
          <span className="text-xs text-muted-foreground">{meta.blurb}</span>
        </div>
        <Badge variant="secondary" className="shrink-0 font-mono text-[10px] font-normal">
          {w.n.toLocaleString()} scans
        </Badge>
      </div>

      {w.scored > 0 && <Histogram window={w} threshold={threshold} baseline={rail.baseline} />}

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Stat
          label="blocked"
          value={w.blocked.toLocaleString()}
          hint={w.n ? pct(blockRate) : undefined}
          tone={w.blocked ? "text-destructive" : undefined}
        />
        {w.scored > 0 ? (
          <>
            <Stat label="p50" value={num(w.p50)} hint="median score" />
            <Stat label="p95" value={num(w.p95)} />
            <Stat label="max" value={num(w.max)} hint={`${w.meanMs.toFixed(0)} ms mean`} />
          </>
        ) : (
          <Stat
            label="latency"
            value={`${w.meanMs.toFixed(0)} ms`}
            hint="regex rail — no scores"
          />
        )}
      </div>

      {w.wouldBlock > 0 && (
        <p className="rounded-md bg-chart-2/10 px-2.5 py-2 text-xs text-chart-2">
          Observe mode: {w.wouldBlock.toLocaleString()} decision
          {w.wouldBlock === 1 ? "" : "s"} scored over the threshold and were let through anyway.
          That is what switching to <span className="font-mono">on</span> would start blocking.
        </p>
      )}

      {rail.baseline && (
        <div className="flex items-baseline gap-2 border-t border-border/50 pt-2 text-xs">
          <span className="text-muted-foreground">vs the window before:</span>
          <span className={cn("font-mono", drift.text)}>
            {drift.label}
            {rail.drift !== null && ` · PSI ${rail.drift.toFixed(3)}`}
          </span>
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            {rail.baseline.n.toLocaleString()} then / {w.n.toLocaleString()} now
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * What each candidate threshold would do.
 *
 * The block-rate column is measured over all traffic and needs no labels; the
 * precision/recall columns only exist once somebody has judged some decisions
 * in the queue below. Keeping them in one table with the labelled count stated
 * is deliberate: it is the difference between "this is what it costs" and
 * "this is what we think it catches".
 */
function SweepTable({
  points,
  current,
  best,
  onPick,
}: {
  points: GuardrailSweepPoint[]
  current: number
  best: number | null
  onPick: (t: number) => void
}) {
  // Around the current threshold, plus the best one — the whole table is 19
  // rows of mostly-identical numbers and nobody reads it.
  const shown = useMemo(() => {
    const near = points.filter((p) => Math.abs(p.threshold - current) <= 0.2)
    const bestPoint = best !== null ? points.filter((p) => p.threshold === best) : []
    const merged = [...new Set([...near, ...bestPoint])].sort((a, b) => a.threshold - b.threshold)
    return merged.length ? merged : points
  }, [points, current, best])

  if (!points.length) {
    return (
      <p className="text-xs text-muted-foreground italic">
        Not enough scored traffic yet to price a threshold change.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-left font-mono text-[11px]">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 font-normal">threshold</th>
            <th className="py-1 pr-3 font-normal">blocks</th>
            <th className="py-1 pr-3 font-normal">FP</th>
            <th className="py-1 pr-3 font-normal">FN</th>
            <th className="py-1 pr-3 font-normal">F1</th>
            <th className="py-1 font-normal"></th>
          </tr>
        </thead>
        <tbody>
          {shown.map((p) => {
            const isCurrent = Math.abs(p.threshold - current) < 1e-9
            return (
              <tr
                key={p.threshold}
                className={cn("border-t border-border/40", isCurrent && "bg-foreground/[0.04]")}
              >
                <td className="py-1 pr-3">
                  {p.threshold.toFixed(2)}
                  {isCurrent && <span className="ml-1 text-muted-foreground">now</span>}
                  {best !== null && Math.abs(p.threshold - best) < 1e-9 && !isCurrent && (
                    <span className="ml-1 text-chart-3">best F1</span>
                  )}
                </td>
                <td className="py-1 pr-3">{pct(p.blockRate)}</td>
                <td className={cn("py-1 pr-3", p.falsePositives && "text-destructive")}>
                  {p.falsePositives}
                </td>
                <td className="py-1 pr-3">{p.falseNegatives}</td>
                <td className="py-1 pr-3">{p.f1 === null ? "—" : p.f1.toFixed(2)}</td>
                <td className="py-1">
                  {!isCurrent && (
                    <button
                      type="button"
                      className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                      onClick={() => onPick(p.threshold)}
                    >
                      use
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const LABEL_META: Record<GuardrailLabel, { label: string; tone: string; Icon: typeof CheckIcon }> = {
  correct: { label: "right call", tone: "text-chart-3", Icon: CheckIcon },
  false_positive: { label: "false positive", tone: "text-destructive", Icon: XIcon },
  false_negative: { label: "missed one", tone: "text-chart-2", Icon: AlertTriangleIcon },
}

/** One recorded decision, with the three judgements an operator can make. */
function ScanRow({
  scan,
  onLabel,
}: {
  scan: GuardrailScan
  onLabel: (id: number, label: GuardrailLabel | null) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const text = scan.text ?? ""
  const long = text.length > 180

  return (
    <li className="flex flex-col gap-1.5 py-2">
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "font-mono text-xs",
            scan.blocked ? "text-destructive" : scan.wouldBlock ? "text-chart-2" : "text-muted-foreground",
          )}
        >
          {scan.score === null ? "regex" : scan.score.toFixed(3)}
        </span>
        <Badge variant="outline" className="text-[10px] font-normal">
          {scan.rail}
        </Badge>
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {scan.surface}
          {scan.pattern ? ` · ${scan.pattern}` : ""}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
          {scan.blocked ? "blocked" : scan.wouldBlock ? "would block" : "allowed"} · {when(scan.at)}
        </span>
      </div>

      <p className="text-xs leading-snug break-words whitespace-pre-wrap">
        {text ? (
          expanded || !long ? (
            text
          ) : (
            <>
              {text.slice(0, 180)}…{" "}
              <button
                type="button"
                className="text-muted-foreground underline underline-offset-2"
                onClick={() => setExpanded(true)}
              >
                more
              </button>
            </>
          )
        ) : (
          <span className="text-muted-foreground italic">
            text not stored (GUARDRAIL_STORE_TEXT=off)
          </span>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        {(Object.keys(LABEL_META) as GuardrailLabel[]).map((label) => {
          const meta = LABEL_META[label]
          const active = scan.label === label
          return (
            <Button
              key={label}
              size="sm"
              variant={active ? "secondary" : "ghost"}
              className={cn("h-6 px-2 text-[11px]", active && meta.tone)}
              onClick={() => onLabel(scan.id, active ? null : label)}
            >
              <meta.Icon data-icon="inline-start" className="size-3" />
              {meta.label}
            </Button>
          )
        })}
        {scan.label && (
          <button
            type="button"
            className="ml-1 text-[10px] text-muted-foreground underline underline-offset-2"
            onClick={() => onLabel(scan.id, null)}
          >
            clear
          </button>
        )}
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------

export function GuardrailsTab() {
  const [data, setData] = useState<GuardrailDashboard | null>(null)
  const [scans, setScans] = useState<GuardrailScan[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [windowDays, setWindowDays] = useState(7)
  const [queue, setQueue] = useState<"unjudged" | "blocked" | "recent">("unjudged")

  const loadScans = useCallback(
    (mode: typeof queue) =>
      api
        .guardrailScans(
          mode === "blocked"
            ? { blocked: true, order: "recent", limit: 50 }
            : mode === "recent"
              ? { order: "recent", limit: 50 }
              : { unlabelled: true, order: "score", limit: 50 },
        )
        .then((r) => setScans(r.scans))
        .catch((err) => setError(String(err).slice(0, 200))),
    [],
  )

  const load = useCallback(
    (days: number, mode: typeof queue) => {
      setBusy(true)
      return Promise.all([
        api.guardrails(days).then(setData),
        loadScans(mode),
      ])
        .catch((err) => setError(String(err).slice(0, 200)))
        .finally(() => setBusy(false))
    },
    [loadScans],
  )

  useEffect(() => {
    void load(windowDays, queue)
  }, [load, windowDays, queue])

  const label = useCallback(
    async (id: number, next: GuardrailLabel | null) => {
      // Optimistic: judging a queue of fifty is a rhythm, and a round trip
      // between every click breaks it.
      setScans((prev) => prev.map((s) => (s.id === id ? { ...s, label: next } : s)))
      try {
        await api.labelGuardrailScan(id, next)
      } catch (err) {
        setScans((prev) => prev.map((s) => (s.id === id ? { ...s, label: s.label } : s)))
        toast.error(String(err).slice(0, 160))
      }
    },
    [],
  )

  const retune = useCallback(
    async (patch: { mode?: GuardrailDashboard["mode"]; threshold?: number }) => {
      try {
        const res = await api.setGuardrailConfig(patch)
        setData((prev) => (prev ? { ...prev, mode: res.mode, threshold: res.threshold } : prev))
        toast.success(
          res.note ?? `Guardrails: ${res.mode} at ${res.threshold.toFixed(2)}`,
        )
        void load(windowDays, queue)
      } catch (err) {
        toast.error(String(err).slice(0, 160))
      }
    },
    [load, windowDays, queue],
  )

  if (error && !data) return <p className="text-sm text-destructive">{error}</p>
  if (!data) return <Spinner className="mx-auto" />

  const input = data.rails.find((r) => r.rail === "input")
  const totalRecent = data.rails.reduce((n, r) => n + r.recent.n, 0)
  const totalBlocked = data.rails.reduce((n, r) => n + r.recent.blocked, 0)
  const judged = Object.values(data.labelCounts).reduce((a, b) => a + b, 0)

  return (
    <div className="flex flex-col gap-5">
      {/* ---- state of the rails ----------------------------------------- */}
      <div className="flex flex-col gap-3 rounded-lg bg-card/60 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <ShieldIcon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                data.mode === "off"
                  ? "text-muted-foreground"
                  : data.classifierReady
                    ? "text-chart-3"
                    : "text-destructive",
              )}
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm">
                {data.mode === "off" ? (
                  <span className="text-muted-foreground">
                    Rails off — only the persona scrubber is running.
                  </span>
                ) : data.classifierReady ? (
                  <>
                    <span className="font-medium">{data.modelLabel}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {data.mode === "observe" ? "observing, blocking nothing" : "blocking"} at{" "}
                      {data.threshold.toFixed(2)}
                    </span>
                  </>
                ) : (
                  <span className="text-destructive">
                    {data.modelLabel} has not answered — the rails are failing open.
                  </span>
                )}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {data.total.toLocaleString()} decisions recorded
                {data.oldest ? ` since ${new Date(data.oldest).toLocaleDateString()}` : ""}
                {data.health.dropped > 0 && ` · ${data.health.dropped} dropped`}
              </span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {[7, 30, 90].map((d) => (
              <Button
                key={d}
                size="sm"
                variant={windowDays === d ? "secondary" : "ghost"}
                className="h-7 px-2 font-mono text-[11px]"
                onClick={() => setWindowDays(d)}
              >
                {d}d
              </Button>
            ))}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh"
              disabled={busy}
              onClick={() => void load(windowDays, queue)}
            >
              <RefreshCwIcon className={cn(busy && "animate-spin")} />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border/50 pt-3 sm:grid-cols-4">
          <Stat
            label={`last ${data.windowDays}d`}
            value={totalRecent.toLocaleString()}
            hint="decisions"
          />
          <Stat
            label="blocked"
            value={totalBlocked.toLocaleString()}
            hint={totalRecent ? pct(totalBlocked / totalRecent) : "—"}
            tone={totalBlocked ? "text-destructive" : undefined}
          />
          <Stat
            label="p95 input"
            value={num(input?.recent.p95 ?? null)}
            hint={`threshold ${data.threshold.toFixed(2)}`}
          />
          <Stat
            label="judged"
            value={String(judged)}
            hint={judged ? `${data.labelCounts.false_positive} false positive` : "none yet"}
          />
        </div>

        {/* mode switch */}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/50 pt-3">
          <span className="mr-1 text-xs text-muted-foreground">Mode</span>
          {GUARDRAIL_MODES.map((m) => (
            <Button
              key={m}
              size="sm"
              variant={data.mode === m ? "secondary" : "ghost"}
              className="h-7 px-2.5 font-mono text-[11px]"
              onClick={() => void retune({ mode: m })}
            >
              {m}
            </Button>
          ))}
          <span className="ml-2 text-[11px] text-muted-foreground">
            {data.mode === "observe"
              ? "Scoring everything, blocking nothing — this is how a candidate threshold gets measured before it is trusted."
              : data.mode === "off"
                ? "The classifier is not running. The persona rail is regex and stays on regardless."
                : "Messages at or over the threshold are refused."}
          </span>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      {/* ---- distribution per rail --------------------------------------- */}
      {data.rails.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Nothing recorded yet in this window.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Every rail decision is written from the next chat turn onward — send a message and
            come back.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {data.rails.map((rail) => (
            <RailCard key={rail.rail} rail={rail} threshold={data.threshold} />
          ))}
        </div>
      )}

      <Separator />

      {/* ---- what a different threshold would cost ------------------------ */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <h3 className="font-heading text-base font-semibold">Threshold</h3>
          <p className="text-sm text-muted-foreground">
            What each candidate would do to the input rail. The blocks column is measured over
            all traffic; the rest needs decisions judged below, and says so when there aren't
            enough.
          </p>
        </div>
        {data.sweep.note && (
          <p className="rounded-md bg-chart-2/10 px-2.5 py-2 text-xs text-chart-2">
            {data.sweep.note}
          </p>
        )}
        <SweepTable
          points={data.sweep.points}
          current={data.threshold}
          best={data.sweep.bestF1}
          onPick={(t) => void retune({ threshold: t })}
        />
        <p className="text-[11px] text-muted-foreground">
          Calibration against the labelled attack corpus lives in Admin → Evals (
          <span className="font-mono">guardrails-calibration</span>), which answers the same
          question offline and does not need any traffic at all.
        </p>
      </div>

      <Separator />

      {/* ---- the review queue -------------------------------------------- */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="font-heading text-base font-semibold">Review</h3>
            <p className="text-sm text-muted-foreground">
              Highest-scoring decisions nobody has judged. Both mistakes live at this end: the
              loudest thing that was allowed, and the quietest thing that was blocked.
            </p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            {(
              [
                ["unjudged", "unjudged"],
                ["blocked", "blocked"],
                ["recent", "recent"],
              ] as const
            ).map(([mode, label]) => (
              <Button
                key={mode}
                size="sm"
                variant={queue === mode ? "secondary" : "ghost"}
                className="h-7 px-2.5 text-[11px]"
                onClick={() => setQueue(mode)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>

        {scans.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground italic">
            Nothing to review here.
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {scans.map((scan) => (
              <ScanRow key={scan.id} scan={scan} onLabel={label} />
            ))}
          </ul>
        )}
      </div>

      {/* ---- how to read this -------------------------------------------- */}
      <details className="group rounded-lg border border-border/60 bg-card/40">
        <summary className="flex cursor-pointer list-none items-center gap-2.5 p-3 [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">How to read this</span>
            <span className="truncate text-xs text-muted-foreground">
              What the numbers mean and what they deliberately do not.
            </span>
          </div>
        </summary>
        <div className="flex flex-col gap-3 border-t border-border/60 p-3 text-xs leading-snug text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Every decision is recorded</span>, not
            just the blocks. That is the point of the page: without the scores on traffic that
            passed, the block count is the only observable, and a classifier drifting into false
            positives looks exactly like a quiet week.
          </p>
          <p>
            <span className="font-medium text-foreground">PSI</span> is the population stability
            index between this window and the one before it — the standard "has this
            distribution moved" measure. Under 0.1 is noise, 0.1–0.25 is worth a look, over 0.25
            is a real shift. It is reported as null until both windows have enough scans to say
            anything.
          </p>
          <p>
            <span className="font-medium text-foreground">The rails fail open.</span> A classifier
            that will not load lets everything through, which produces exactly the same empty
            chart as a quiet day. The banner at the top says which one you are looking at.
          </p>
          <p>
            <span className="font-medium text-foreground">The output rail has no scores.</span> It
            is a regex scrubber over the streamed reply, so it reports trips and latency and
            contributes nothing to the percentiles — averaging a deterministic rail into a
            probabilistic one would make both numbers meaningless.
          </p>
          <p>
            <span className="font-medium text-foreground">Scanned text is stored</span> so a false
            positive can be read and judged, bounded by{" "}
            <span className="font-mono">GUARDRAIL_RETENTION_DAYS</span> (default 30) and deleted
            with the account. <span className="font-mono">GUARDRAIL_STORE_TEXT=off</span> keeps
            the distribution and drops the corpus.
          </p>
        </div>
      </details>
    </div>
  )
}
