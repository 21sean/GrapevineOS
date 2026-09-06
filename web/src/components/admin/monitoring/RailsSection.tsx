// Guardrail decisions: one card per rail with its score histogram (the
// previous window ghosted behind it), drift against that window, block
// counts and latency, plus the review queue where an operator labels
// individual decisions to build the calibration set.

import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react"
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronRightIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import type {
  GuardrailDashboard,
  GuardrailLabel,
  GuardrailRail,
  GuardrailRailStats,
  GuardrailScan,
  GuardrailWindow,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { Stat } from "@/components/admin/monitoring/primitives"
import {
  num,
  pct,
  when,
  type ScanQueue,
} from "@/components/admin/monitoring/shared"

const RAIL_LABEL: Record<GuardrailRail, { title: string; blurb: string }> = {
  input: {
    title: "Input rail",
    blurb: "Every message a person types, before the agent sees it.",
  },
  content: {
    title: "Content rail",
    blurb: "Web text the agent fetched, before it enters the context.",
  },
  output: {
    title: "Output rail",
    blurb: "The persona scrubber on the streamed reply. Regex, no scores.",
  },
}

const DRIFT_STYLE: Record<
  GuardrailRailStats["driftVerdict"],
  { text: string; label: string }
> = {
  stable: { text: "text-chart-3", label: "stable" },
  moderate: { text: "text-chart-2", label: "moved a little" },
  significant: { text: "text-destructive", label: "moved" },
  unknown: { text: "text-muted-foreground", label: "not enough history" },
}

const LABEL_META: Record<
  GuardrailLabel,
  { label: string; tone: string; Icon: typeof CheckIcon }
> = {
  correct: { label: "right call", tone: "text-chart-3", Icon: CheckIcon },
  false_positive: {
    label: "false positive",
    tone: "text-destructive",
    Icon: XIcon,
  },
  false_negative: {
    label: "missed one",
    tone: "text-chart-2",
    Icon: AlertTriangleIcon,
  },
}

/**
 * The score histogram, with the threshold drawn on it. Log-scaled heights:
 * real traffic is overwhelmingly benign, so on a linear scale the first
 * bucket is the whole chart and the tail — the part an operator is actually
 * looking for — is one pixel tall.
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
  const height = (n: number) =>
    n === 0 ? 0 : Math.max(3, (Math.log1p(n) / Math.log1p(max)) * 100)
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
      <div className="relative flex h-24 items-end gap-px">
        {w.buckets.map((b, i) => {
          const over = b.lo >= threshold
          const baseN = baseline?.buckets[i]?.n ?? 0
          return (
            // h-full is load-bearing: the bars are percentage-height, and a
            // percentage against an auto-height flex item resolves to 0 —
            // which is an invisible histogram, not an error.
            <div
              key={b.lo}
              className="group relative flex h-full flex-1 items-end justify-center"
            >
              {/* The previous window, behind — a ghost outline so a shift in
                  shape is visible without a second chart to compare against. */}
              {baseline && baseN > 0 && (
                <div
                  aria-hidden
                  className="absolute bottom-0 w-full rounded-t-[2px] border border-dashed border-muted-foreground/35"
                  style={{
                    height: `${Math.max(3, (Math.log1p(baseN) / Math.log1p(baseMax)) * 100)}%`,
                  }}
                />
              )}
              <div
                className={cn(
                  "w-full rounded-t-[2px] transition-opacity",
                  over ? "bg-destructive/70" : "bg-chart-3/60",
                  b.n === 0 && "bg-transparent"
                )}
                style={{ height: `${height(b.n)}%` }}
              />
              <span className="pointer-events-none absolute -top-6 left-1/2 z-10 hidden -translate-x-1/2 rounded bg-popover px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-popover-foreground shadow group-hover:block">
                {b.lo.toFixed(2)}–{b.hi.toFixed(2)}: {b.n}
              </span>
            </div>
          )
        })}
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

function RailCard({
  rail,
  threshold,
}: {
  rail: GuardrailRailStats
  threshold: number
}) {
  const meta = RAIL_LABEL[rail.rail]
  const w = rail.recent
  const drift = DRIFT_STYLE[rail.driftVerdict]

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">{meta.title}</span>
          <span className="text-xs text-muted-foreground">{meta.blurb}</span>
        </div>
        <Badge
          variant="secondary"
          className="shrink-0 font-mono text-[10px] font-normal"
        >
          {w.n.toLocaleString()} scans
        </Badge>
      </div>

      {w.scored > 0 && (
        <Histogram window={w} threshold={threshold} baseline={rail.baseline} />
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Stat
          label="blocked"
          value={w.blocked.toLocaleString()}
          hint={w.n ? pct(w.blocked / w.n) : undefined}
          tone={w.blocked ? "text-destructive" : undefined}
        />
        {w.scored > 0 ? (
          <>
            <Stat label="p50" value={num(w.p50)} hint="median score" />
            <Stat label="p95" value={num(w.p95)} />
            <Stat
              label="max"
              value={num(w.max)}
              hint={`${w.meanMs.toFixed(0)} ms mean`}
            />
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
          {w.wouldBlock === 1 ? "" : "s"} scored over the threshold and were let
          through. That is what <span className="font-mono">on</span> would
          start blocking.
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
            scan.blocked
              ? "text-destructive"
              : scan.wouldBlock
                ? "text-chart-2"
                : "text-muted-foreground"
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
          {scan.blocked
            ? "blocked"
            : scan.wouldBlock
              ? "would block"
              : "allowed"}{" "}
          · {when(scan.at)}
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

export function RailsSection({
  rails,
  scans,
  setScans,
  queue,
  setQueue,
}: {
  rails: GuardrailDashboard | null
  scans: GuardrailScan[]
  setScans: Dispatch<SetStateAction<GuardrailScan[]>>
  queue: ScanQueue
  setQueue: (mode: ScanQueue) => void
}) {
  const label = useCallback(
    async (id: number, next: GuardrailLabel | null) => {
      // Optimistic: judging a queue of fifty is a rhythm, and a round trip
      // between every click breaks it.
      setScans((prev) =>
        prev.map((s) => (s.id === id ? { ...s, label: next } : s))
      )
      try {
        await api.labelGuardrailScan(id, next)
      } catch (err) {
        setScans((prev) =>
          prev.map((s) => (s.id === id ? { ...s, label: s.label } : s))
        )
        toast.error(String(err).slice(0, 160))
      }
    },
    [setScans]
  )

  return (
    <>
      {/* ---- rails ------------------------------------------------------- */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <h3 className="font-heading text-base font-semibold">Rails</h3>
          <p className="text-sm text-muted-foreground">
            Score distributions on everything the rails looked at — including
            what passed. The dashed ghost is the previous window; PSI says
            whether the shape moved.
          </p>
        </div>
        {!rails || rails.rails.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              Nothing recorded yet in this window.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Every rail decision is written from the next chat turn onward —
              send a message and come back.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {rails.rails.map((rail) => (
              <RailCard
                key={rail.rail}
                rail={rail}
                threshold={rails.threshold}
              />
            ))}
          </div>
        )}
      </div>

      {/* ---- review queue ------------------------------------------------ */}
      <details className="group rounded-lg border border-border/60 bg-card/40">
        <summary className="flex cursor-pointer list-none items-center gap-2.5 p-3 [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">Review queue</span>
            <span className="truncate text-xs text-muted-foreground">
              Judge individual rail decisions — labels become the calibration
              set.
            </span>
          </div>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
            {rails
              ? `${Object.values(rails.labelCounts).reduce((a, b) => a + b, 0)} judged`
              : ""}
          </span>
        </summary>
        <div className="flex flex-col gap-2.5 border-t border-border/60 p-3">
          <div className="flex gap-1.5">
            {(["unjudged", "blocked", "recent"] as const).map((mode) => (
              <Button
                key={mode}
                size="sm"
                variant={queue === mode ? "secondary" : "ghost"}
                className="h-7 px-2.5 text-[11px]"
                onClick={() => setQueue(mode)}
              >
                {mode}
              </Button>
            ))}
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
      </details>
    </>
  )
}
