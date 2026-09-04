import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  GavelIcon,
  PlayIcon,
  RefreshCwIcon,
  ShieldIcon,
  SquareIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import {
  GUARDRAIL_MODES,
  type ConversationMonitorRow,
  type ConversationVerdict,
  type EvalCatalog,
  type EvalCaseResult,
  type EvalKind,
  type EvalRun,
  type EvalStatus,
  type EvalSuiteResult,
  type GuardrailDashboard,
  type GuardrailLabel,
  type GuardrailRail,
  type GuardrailRailStats,
  type GuardrailScan,
  type GuardrailWindow,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Admin → Monitoring. One panel for the whole quality loop, replacing the
 * separate Evals and Guardrails tabs.
 *
 * Ordered by the questions an operator asks, most-load-bearing first — the
 * standard shape of an LLM observability dashboard (headline numbers, a
 * trend, per-component breakdown, then the trace-level table everything
 * drills into):
 *
 *   1. is it green right now — pass rate, block rate, drift, in one strip
 *   2. what changed — regressions/fixes vs the last comparable run
 *   3. where — per-rail score distributions, per-suite results
 *   4. show me the actual conversations — every persisted thread with its
 *      guardrail decisions and its judge scores, one row each
 *
 * Nothing here computes a statistic of its own: eval numbers come from the
 * same registry the CLI gate reads, rail numbers from one Postgres function,
 * conversation rows from another. A dashboard with its own arithmetic
 * eventually disagrees with the gate, and then nobody can tell which is lying.
 *
 * Deliberately dropped from the old tabs: the threshold sweep (measured on
 * real traffic, the classifier's scores are bimodal with a dead band from
 * ~0.06 to ~0.6, so every threshold in it behaves identically), the persona
 * fixture cards, and the prose registers. Detail views belong behind clicks;
 * the front page is for numbers that change decisions.
 */

// ---------------------------------------------------------------------------
// shared meta
// ---------------------------------------------------------------------------

const STATUS_STYLE: Record<
  EvalStatus,
  { dot: string; text: string; bar: string; label: string }
> = {
  pass: {
    dot: "bg-chart-3",
    text: "text-chart-3",
    bar: "bg-chart-3",
    label: "passing",
  },
  fail: {
    dot: "bg-destructive",
    text: "text-destructive",
    bar: "bg-destructive",
    label: "failing",
  },
  skipped: {
    dot: "bg-chart-2",
    text: "text-chart-2",
    bar: "bg-chart-2",
    label: "skipped",
  },
}

const KIND_META: Record<EvalKind, { label: string; blurb: string }> = {
  offline: {
    label: "offline",
    blurb: "Pure functions over frozen fixtures. Milliseconds, deterministic.",
  },
  model: {
    label: "model",
    blurb: "Needs the local guardrail classifier on disk. Seconds.",
  },
  judge: {
    label: "judged",
    blurb: "Graded by an LLM judge on local Ollama. Minutes of GPU.",
  },
}

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

const VERDICT_STYLE: Record<
  ConversationVerdict,
  { dot: string; text: string; label: string }
> = {
  pass: { dot: "bg-chart-3", text: "text-chart-3", label: "pass" },
  borderline: { dot: "bg-chart-2", text: "text-chart-2", label: "borderline" },
  fail: { dot: "bg-destructive", text: "text-destructive", label: "fail" },
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

const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 && v > 0 ? 1 : 0)}%`
const num = (v: number | null, digits = 3) =>
  v === null ? "—" : v.toFixed(digits)
const seconds = (ms: number) =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)}s`

function when(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function StatusDot({
  status,
  className,
}: {
  status: EvalStatus
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        STATUS_STYLE[status].dot,
        className
      )}
    />
  )
}

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
      <span className={cn("font-mono text-lg leading-none", tone)}>
        {value}
      </span>
      {hint && (
        <span className="truncate text-[11px] text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
  )
}

/** A score against the bar it has to clear. Threshold drawn, not hidden. */
function ScoreBar({
  score,
  threshold,
  status,
}: {
  score: number
  threshold: number
  status: EvalStatus
}) {
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full", STATUS_STYLE[status].bar)}
        style={{ width: `${Math.max(0, Math.min(1, score)) * 100}%` }}
      />
      {threshold > 0 && threshold < 1 && (
        <div
          aria-hidden
          className="absolute inset-y-0 w-px bg-foreground/70"
          style={{ left: `${threshold * 100}%` }}
        />
      )}
    </div>
  )
}

/** Pass rate across recent runs. Trend is the question a single run can't answer. */
function Trend({ runs }: { runs: EvalRun[] }) {
  const points = runs
    .slice(0, 20)
    .reverse()
    .map((r) => {
      const judged = r.passed + r.failed
      return { rate: judged ? r.passed / judged : 0, run: r }
    })
  if (points.length < 2) return null
  return (
    <div
      className="flex h-8 items-end gap-0.5"
      aria-label="Pass rate across recent runs"
    >
      {points.map((p, i) => (
        <div
          key={p.run.id}
          title={`${when(p.run.startedAt)} · ${(p.rate * 100).toFixed(0)}% · ${p.run.failed} failing`}
          className={cn(
            "w-1.5 rounded-t-[1px]",
            p.run.failed > 0 ? "bg-destructive/70" : "bg-chart-3/60",
            i === points.length - 1 && "ring-1 ring-foreground/30"
          )}
          style={{ height: `${Math.max(8, p.rate * 100)}%` }}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// rails
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// suites
// ---------------------------------------------------------------------------

function CaseRow({
  result,
  slowest,
}: {
  result: EvalCaseResult
  slowest: number
}) {
  const Icon =
    result.status === "pass"
      ? CheckIcon
      : result.status === "fail"
        ? XIcon
        : CircleSlashIcon
  return (
    <li className="flex gap-2.5 py-1.5">
      <Icon
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          STATUS_STYLE[result.status].text
        )}
        aria-label={STATUS_STYLE[result.status].label}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm leading-snug">{result.name}</span>
        <span
          className={cn(
            "font-mono text-[11px] leading-snug break-words",
            result.status === "pass"
              ? "text-muted-foreground"
              : STATUS_STYLE[result.status].text
          )}
        >
          {result.detail}
        </span>
        {result.note && (
          <span className="text-xs leading-snug text-muted-foreground italic">
            {result.note}
          </span>
        )}
      </div>
      <span className="ml-auto flex shrink-0 flex-col items-end gap-1">
        <span className="font-mono text-[10px] text-muted-foreground">
          {result.ms}ms
        </span>
        {slowest > 250 && (
          <span
            aria-hidden
            className="h-0.5 rounded-full bg-muted-foreground/30"
            style={{ width: `${Math.max(2, (result.ms / slowest) * 28)}px` }}
          />
        )}
      </span>
    </li>
  )
}

function SuiteRow({
  suite,
  live,
  busy,
  onRun,
}: {
  suite: EvalCatalog["suites"][number]
  live?: EvalSuiteResult
  busy: boolean
  onRun: () => void
}) {
  const status: EvalStatus =
    live?.status ?? (suite.unavailable ? "skipped" : "pass")
  const cases = live?.cases ?? []
  const failing = cases.filter((c) => c.status !== "pass")
  const slowest = Math.max(0, ...cases.map((c) => c.ms))
  const total = live
    ? live.passed + live.failed + live.skipped
    : suite.caseCount

  return (
    <details className="group rounded-lg border border-border/60 bg-card/40 open:bg-card/60">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 p-3 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        {live ? (
          <StatusDot status={status} />
        ) : (
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-2 text-sm font-medium">
            {suite.title}
            <Badge
              variant="secondary"
              className="text-[10px] font-normal"
              title={KIND_META[suite.kind]?.blurb}
            >
              {KIND_META[suite.kind]?.label ?? suite.kind}
            </Badge>
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {suite.what}
          </span>
          {live && live.status !== "skipped" && (
            <ScoreBar
              score={live.score}
              threshold={live.threshold}
              status={status}
            />
          )}
        </div>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-right font-mono text-[11px] text-muted-foreground">
            {live ? (
              <>
                <span className={STATUS_STYLE[status].text}>
                  {(live.score * 100).toFixed(0)}%
                </span>
                <span className="ml-1.5">
                  {live.passed}/{total}
                </span>
                <br />
                <span>
                  {seconds(live.ms)}
                  {live.threshold < 1 &&
                    ` · bar ${(live.threshold * 100).toFixed(0)}%`}
                </span>
              </>
            ) : (
              `${suite.caseCount} cases`
            )}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Run ${suite.title}`}
            disabled={busy}
            onClick={(e) => {
              e.preventDefault()
              onRun()
            }}
          >
            <PlayIcon />
          </Button>
        </span>
      </summary>

      <div className="border-t border-border/60 px-3 pt-2 pb-3">
        {suite.unavailable && (
          <p className="mb-2 rounded-md bg-chart-2/10 px-2.5 py-2 text-xs text-chart-2">
            Skipped: {suite.unavailable}
          </p>
        )}
        {live?.skipReason && !suite.unavailable && (
          <p className="mb-2 rounded-md bg-chart-2/10 px-2.5 py-2 text-xs text-chart-2">
            Skipped: {live.skipReason}
          </p>
        )}
        {cases.length === 0 && !suite.unavailable && (
          <p className="text-xs text-muted-foreground italic">
            {suite.caseCount} cases, not run yet.
          </p>
        )}
        {failing.length > 0 && (
          <p className="mb-1 text-xs text-muted-foreground">
            Showing all {cases.length} cases, {failing.length} not passing.
          </p>
        )}
        <ul className="divide-y divide-border/40">
          {cases.map((c) => (
            <CaseRow key={c.id} result={c} slowest={slowest} />
          ))}
        </ul>
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------

/**
 * One thread in the past-conversations table: what happened, what the rails
 * did about it, what the judge thought of it. The row is the trace unit every
 * observability guide converges on — aggregate charts say that something
 * moved, this table is where you find out what.
 */
function ConversationRow({
  row,
  judging,
  onJudge,
}: {
  row: ConversationMonitorRow
  judging: boolean
  onJudge: () => void
}) {
  const [open, setOpen] = useState(false)
  const ev = row.eval
  const verdict = ev ? VERDICT_STYLE[ev.verdict] : null

  return (
    <>
      <tr
        className="cursor-pointer border-t border-border/40 hover:bg-foreground/[0.03]"
        onClick={() => setOpen((v) => !v)}
      >
        <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">
          {when(row.updatedAt)}
        </td>
        <td className="max-w-0 py-1.5 pr-3">
          <span className="block truncate" title={row.title}>
            {row.title || (
              <span className="text-muted-foreground italic">untitled</span>
            )}
          </span>
        </td>
        <td className="py-1.5 pr-3 text-right">{row.turns}</td>
        <td className="py-1.5 pr-3 whitespace-nowrap">
          {row.rails.scans === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : row.rails.blocked > 0 ? (
            <span className="text-destructive">
              {row.rails.blocked} blocked
            </span>
          ) : row.rails.wouldBlock > 0 ? (
            <span className="text-chart-2">{row.rails.wouldBlock} flagged</span>
          ) : (
            <span className="text-muted-foreground">
              {row.rails.scans} clean
            </span>
          )}
        </td>
        <td className="py-1.5 pr-3 whitespace-nowrap">
          {ev && verdict ? (
            <span
              className={cn("inline-flex items-center gap-1.5", verdict.text)}
            >
              <span
                aria-hidden
                className={cn("size-1.5 rounded-full", verdict.dot)}
              />
              {(ev.overall * 100).toFixed(0)}%
            </span>
          ) : (
            <span className="text-muted-foreground italic">not judged</span>
          )}
        </td>
        <td className="py-1 text-right">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={ev ? "Judge again" : "Judge this conversation"}
            title={ev ? "Judge again" : "Judge this conversation"}
            disabled={judging}
            onClick={(e) => {
              e.stopPropagation()
              onJudge()
            }}
          >
            {judging ? <Spinner className="size-3.5" /> : <GavelIcon />}
          </Button>
        </td>
      </tr>

      {open && (
        <tr className="border-t border-border/40 bg-card/40">
          <td colSpan={6} className="px-3 py-2.5">
            <div className="flex flex-col gap-2.5 font-sans">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span className="font-mono">{row.provider}</span>
                <span>{row.turns} messages</span>
                {row.rails.scans > 0 && (
                  <span>
                    rails: {row.rails.scans} scan
                    {row.rails.scans === 1 ? "" : "s"}
                    {row.rails.maxScore !== null &&
                      ` · max score ${row.rails.maxScore.toFixed(3)}`}
                  </span>
                )}
                {ev && (
                  <span>
                    judged {when(ev.at)} by{" "}
                    <span className="font-mono">{ev.model}</span> in{" "}
                    {seconds(ev.ms)}
                  </span>
                )}
              </div>

              {ev ? (
                <ul className="flex flex-col gap-2">
                  {ev.scores.map((s) => {
                    const status: EvalStatus =
                      s.score >= 0.7
                        ? "pass"
                        : s.score >= 0.5
                          ? "skipped"
                          : "fail"
                    return (
                      <li key={s.metric} className="flex flex-col gap-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="text-xs font-medium">
                            {s.metric}
                          </span>
                          <span
                            className={cn(
                              "font-mono text-[11px]",
                              STATUS_STYLE[status].text
                            )}
                          >
                            {(s.score * 100).toFixed(0)}%
                          </span>
                        </span>
                        <ScoreBar
                          score={s.score}
                          threshold={0.7}
                          status={status}
                        />
                        {s.reason && (
                          <span className="text-[11px] leading-snug text-muted-foreground">
                            {s.reason}
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  Not judged yet — the gavel runs the three conversation metrics
                  on the local judge.
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------

type Filter = "all" | "failing" | EvalKind

export function MonitoringTab() {
  // rails
  const [rails, setRails] = useState<GuardrailDashboard | null>(null)
  const [railError, setRailError] = useState<string | null>(null)
  const [windowDays, setWindowDays] = useState(7)
  const [refreshing, setRefreshing] = useState(false)
  const [scans, setScans] = useState<GuardrailScan[]>([])
  const [queue, setQueue] = useState<"unjudged" | "blocked" | "recent">(
    "unjudged"
  )

  // evals
  const [catalog, setCatalog] = useState<EvalCatalog | null>(null)
  const [evalError, setEvalError] = useState<string | null>(null)
  const [run, setRun] = useState<EvalRun | null>(null)
  const [history, setHistory] = useState<EvalRun[]>([])
  const [liveSuites, setLiveSuites] = useState<Record<string, EvalSuiteResult>>(
    {}
  )
  const [progress, setProgress] = useState<{
    suite: string
    done: number
    total: number
    label: string
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Filter>("all")
  const abortRef = useRef<AbortController | null>(null)

  // conversations
  const [threads, setThreads] = useState<ConversationMonitorRow[] | null>(null)
  const [judging, setJudging] = useState<string | null>(null)

  const loadScans = useCallback(
    (mode: typeof queue) =>
      api
        .guardrailScans(
          mode === "blocked"
            ? { blocked: true, order: "recent", limit: 50 }
            : mode === "recent"
              ? { order: "recent", limit: 50 }
              : { unlabelled: true, order: "score", limit: 50 }
        )
        .then((r) => setScans(r.scans))
        .catch((err) => setRailError(String(err).slice(0, 200))),
    []
  )

  const loadRails = useCallback(
    (days: number, mode: typeof queue) => {
      setRefreshing(true)
      return Promise.all([
        api.guardrails(days).then(setRails),
        loadScans(mode),
        api.conversationMonitor(25).then((r) => setThreads(r.threads)),
      ])
        .catch((err) => setRailError(String(err).slice(0, 200)))
        .finally(() => setRefreshing(false))
    },
    [loadScans]
  )

  useEffect(() => {
    void loadRails(windowDays, queue)
  }, [loadRails, windowDays, queue])

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>

    const load = () => {
      api
        .evals()
        .then((c) => {
          if (!live) return
          setCatalog(c)
          if (c.lastRun) {
            setRun(c.lastRun)
            setLiveSuites(
              Object.fromEntries(c.lastRun.suites.map((s) => [s.id, s]))
            )
          }
          // Runs are serialized server-side; poll while somebody else's run
          // is in flight rather than pinning the buttons to a stale fact.
          if (c.running) timer = setTimeout(load, 2500)
        })
        .catch((err) => live && setEvalError(String(err).slice(0, 200)))
      api
        .evalHistory()
        .then((h) => live && setHistory(h.runs))
        .catch(() => {
          /* history is a nicety; its absence must not blank the panel */
        })
    }
    load()

    return () => {
      live = false
      clearTimeout(timer)
      abortRef.current?.abort()
    }
  }, [])

  const start = useCallback(async (suites?: string[]) => {
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setEvalError(null)
    setProgress(null)
    if (suites?.length) {
      setLiveSuites((prev) => {
        const next = { ...prev }
        for (const id of suites) delete next[id]
        return next
      })
    } else {
      setLiveSuites({})
      setRun(null)
    }

    let done = 0
    try {
      await api.runEvals(
        suites,
        (frame) => {
          if (frame.type === "suite-start") {
            done = 0
            setProgress({
              suite: frame.title,
              done: 0,
              total: frame.total,
              label: "",
            })
          }
          if (frame.type === "case") {
            done += 1
            setProgress((p) =>
              p ? { ...p, done, label: frame.result.name } : p
            )
          }
          if (frame.type === "suite-done") {
            setLiveSuites((prev) => ({
              ...prev,
              [frame.result.id]: frame.result,
            }))
          }
          if (frame.type === "done") {
            setRun(frame.run)
            setLiveSuites((prev) => ({
              ...prev,
              ...Object.fromEntries(frame.run.suites.map((s) => [s.id, s])),
            }))
            setHistory((prev) => [frame.run, ...prev].slice(0, 25))
          }
          if (frame.type === "error") setEvalError(frame.message)
        },
        controller.signal
      )
    } catch (err) {
      if (!controller.signal.aborted) setEvalError(String(err).slice(0, 200))
    } finally {
      setBusy(false)
      setProgress(null)
      abortRef.current = null
    }
  }, [])

  const label = useCallback(async (id: number, next: GuardrailLabel | null) => {
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
  }, [])

  const setMode = useCallback(
    async (mode: GuardrailDashboard["mode"]) => {
      try {
        const res = await api.setGuardrailConfig({ mode })
        setRails((prev) =>
          prev ? { ...prev, mode: res.mode, threshold: res.threshold } : prev
        )
        toast.success(
          res.note ?? `Guardrails: ${res.mode} at ${res.threshold.toFixed(2)}`
        )
        void loadRails(windowDays, queue)
      } catch (err) {
        toast.error(String(err).slice(0, 160))
      }
    },
    [loadRails, windowDays, queue]
  )

  const judgeThread = useCallback(async (id: string) => {
    setJudging(id)
    try {
      const ev = await api.evaluateConversation(id)
      setThreads((prev) =>
        prev ? prev.map((t) => (t.id === id ? { ...t, eval: ev } : t)) : prev
      )
      toast.success(
        `Judged ${VERDICT_STYLE[ev.verdict].label} at ${(ev.overall * 100).toFixed(0)}%`
      )
    } catch (err) {
      toast.error(String(err).slice(0, 200))
    } finally {
      setJudging(null)
    }
  }, [])

  // ---- derived ------------------------------------------------------------

  const totals = useMemo(() => {
    const suites = Object.values(liveSuites)
    return {
      passed: suites.reduce((n, s) => n + s.passed, 0),
      failed: suites.reduce((n, s) => n + s.failed, 0),
      skippedSuites: suites.filter((s) => s.status === "skipped").length,
      green: suites.filter((s) => s.status === "pass").length,
      ran: suites.length,
    }
  }, [liveSuites])

  const overall: EvalStatus =
    totals.failed > 0 ? "fail" : totals.skippedSuites > 0 ? "skipped" : "pass"
  const elsewhere = !!catalog?.running && !busy
  const judged = totals.passed + totals.failed
  const passRate = judged ? totals.passed / judged : 0

  const visible = useMemo(() => {
    if (!catalog) return []
    if (filter === "all") return catalog.suites
    if (filter === "failing") {
      return catalog.suites.filter((s) => {
        const live = liveSuites[s.id]
        return live ? live.status !== "pass" : !!s.unavailable
      })
    }
    return catalog.suites.filter((s) => s.kind === filter)
  }, [catalog, filter, liveSuites])

  const totalRecent = rails?.rails.reduce((n, r) => n + r.recent.n, 0) ?? 0
  const totalBlocked =
    rails?.rails.reduce((n, r) => n + r.recent.blocked, 0) ?? 0
  const evaluated = threads?.filter((t) => t.eval) ?? []
  const flagged = evaluated.filter((t) => t.eval!.verdict !== "pass").length

  if (railError && !rails && !catalog) {
    return <p className="text-sm text-destructive">{railError}</p>
  }
  if (!rails && !catalog) return <Spinner className="mx-auto" />

  const kinds = [...new Set((catalog?.suites ?? []).map((s) => s.kind))]

  return (
    <div className="flex flex-col gap-5">
      {/* ---- headline ---------------------------------------------------- */}
      <div className="flex flex-col gap-3 rounded-lg bg-card/60 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <ShieldIcon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                !rails || rails.mode === "off"
                  ? "text-muted-foreground"
                  : rails.classifierReady
                    ? "text-chart-3"
                    : "text-destructive"
              )}
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm">
                {!rails ? (
                  <span className="text-muted-foreground">Loading rails…</span>
                ) : rails.mode === "off" ? (
                  <span className="text-muted-foreground">
                    Rails off — only the persona scrubber is running.
                  </span>
                ) : rails.classifierReady ? (
                  <>
                    <span className="font-medium">{rails.modelLabel}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      ·{" "}
                      {rails.mode === "observe"
                        ? "observing, blocking nothing"
                        : "blocking"}{" "}
                      at {rails.threshold.toFixed(2)}
                    </span>
                  </>
                ) : (
                  <span className="text-destructive">
                    {rails.modelLabel} has not answered — the rails are failing
                    open.
                  </span>
                )}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {rails ? `${rails.total.toLocaleString()} rail decisions` : "…"}
                {rails?.health.dropped
                  ? ` · ${rails.health.dropped} dropped`
                  : ""}
                {run &&
                  ` · evals ${when(run.startedAt)} · case set ${run.caseSetHash.slice(0, 6)}`}
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
              disabled={refreshing}
              onClick={() => void loadRails(windowDays, queue)}
            >
              <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
            </Button>
          </div>
        </div>

        {/* The five numbers that answer "is it green" without scrolling:
            offline quality, suite coverage, live traffic, live blocks, and
            what the judge thinks of real conversations. */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border/50 pt-3 sm:grid-cols-5">
          <Stat
            label="pass rate"
            value={totals.ran ? `${(passRate * 100).toFixed(0)}%` : "—"}
            hint={
              totals.ran ? `${totals.passed} of ${judged} checks` : "never run"
            }
            tone={totals.ran ? STATUS_STYLE[overall].text : undefined}
          />
          <Stat
            label="suites green"
            value={totals.ran ? `${totals.green}/${totals.ran}` : "—"}
            hint={
              totals.skippedSuites
                ? `${totals.skippedSuites} unavailable`
                : undefined
            }
          />
          <Stat
            label={`rails ${rails?.windowDays ?? windowDays}d`}
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
            label="convos"
            value={threads ? `${evaluated.length}/${threads.length}` : "—"}
            hint={
              evaluated.length
                ? flagged
                  ? `${flagged} flagged`
                  : "all pass"
                : "judged / total"
            }
            tone={flagged ? "text-chart-2" : undefined}
          />
        </div>

        {/* controls: rail mode on the left, eval runs on the right */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
          <span className="text-xs text-muted-foreground">Rails</span>
          {GUARDRAIL_MODES.map((m) => (
            <Button
              key={m}
              size="sm"
              variant={rails?.mode === m ? "secondary" : "ghost"}
              className="h-7 px-2.5 font-mono text-[11px]"
              onClick={() => void setMode(m)}
            >
              {m}
            </Button>
          ))}
          <div className="ml-auto flex items-center gap-3">
            <Trend runs={history} />
            {busy ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => abortRef.current?.abort()}
              >
                <SquareIcon data-icon="inline-start" />
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={elsewhere || !catalog}
                onClick={() => start()}
              >
                <PlayIcon data-icon="inline-start" />
                {elsewhere ? "Running elsewhere" : "Run evals"}
              </Button>
            )}
          </div>
        </div>

        {progress && (
          <div className="flex flex-col gap-1.5">
            <Progress
              value={
                progress.total ? (progress.done / progress.total) * 100 : null
              }
              className="h-1.5"
            />
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              {progress.suite} · {progress.done}/{progress.total}
              {progress.label ? ` · ${progress.label}` : ""}
            </span>
          </div>
        )}

        {evalError && <p className="text-xs text-destructive">{evalError}</p>}
        {railError && <p className="text-xs text-destructive">{railError}</p>}
      </div>

      {/* ---- what changed ------------------------------------------------ */}
      {(run?.regressions?.length || run?.fixes?.length) && (
        <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
          <span className="text-xs text-muted-foreground">
            Compared with the last run that asked the same questions.
          </span>
          {run.regressions?.map((id) => (
            <span
              key={id}
              className="flex items-center gap-2 font-mono text-xs text-destructive"
            >
              <TrendingDownIcon className="size-3.5 shrink-0" />
              {id}
            </span>
          ))}
          {run.fixes?.map((id) => (
            <span
              key={id}
              className="flex items-center gap-2 font-mono text-xs text-chart-3"
            >
              <TrendingUpIcon className="size-3.5 shrink-0" />
              {id}
            </span>
          ))}
        </div>
      )}

      {/* ---- conversations ----------------------------------------------- */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <h3 className="font-heading text-base font-semibold">
            Conversations
          </h3>
          <p className="text-sm text-muted-foreground">
            Every persisted Ask Grapevine thread: what the rails did during it,
            and how the local judge scored it on helpfulness, groundedness and
            persona. Click a row for the judge's reasoning; the gavel judges (or
            re-judges) it.
          </p>
        </div>

        {!threads ? (
          <Spinner className="mx-auto" />
        ) : threads.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground italic">
            No conversations yet — Ask Grapevine threads land here once someone
            signed in chats.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border/60">
            <table className="w-full min-w-[480px] table-fixed text-left font-mono text-[11px]">
              <colgroup>
                <col className="w-[64px]" />
                <col />
                <col className="w-[42px]" />
                <col className="w-[78px]" />
                <col className="w-[78px]" />
                <col className="w-[36px]" />
              </colgroup>
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-3 pl-3 font-normal">when</th>
                  <th className="py-1.5 pr-3 font-normal">conversation</th>
                  <th className="py-1.5 pr-3 text-right font-normal">msgs</th>
                  <th className="py-1.5 pr-3 font-normal">rails</th>
                  <th className="py-1.5 pr-3 font-normal">eval</th>
                  <th className="py-1.5 pr-2 font-normal"></th>
                </tr>
              </thead>
              <tbody className="[&>tr>td:first-child]:pl-3">
                {threads.map((t) => (
                  <ConversationRow
                    key={t.id}
                    row={t}
                    judging={judging === t.id}
                    onJudge={() => void judgeThread(t.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Separator />

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

      <Separator />

      {/* ---- suites ------------------------------------------------------ */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <h3 className="font-heading text-base font-semibold">Suites</h3>
          <p className="text-sm text-muted-foreground">
            The offline gate — same registry the CLI runs. Offline suites are
            milliseconds; judged ones cost local GPU minutes.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(["all", "failing", ...kinds] as Filter[]).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? "secondary" : "ghost"}
              className="h-7 px-2.5 text-[11px]"
              title={
                f in KIND_META ? KIND_META[f as EvalKind].blurb : undefined
              }
              onClick={() => setFilter(f)}
            >
              {f === "all" || f === "failing"
                ? f
                : KIND_META[f as EvalKind].label}
            </Button>
          ))}
          {catalog && (
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              {visible.length} of {catalog.suites.length} suites
            </span>
          )}
        </div>

        {!catalog ? (
          <Spinner className="mx-auto" />
        ) : visible.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground italic">
            {filter === "failing"
              ? "Nothing is failing."
              : "No suites in this tier."}
          </p>
        ) : (
          visible.map((s) => (
            <SuiteRow
              key={s.id}
              suite={s}
              live={liveSuites[s.id]}
              busy={busy || elsewhere}
              onRun={() => start([s.id])}
            />
          ))
        )}
      </div>

      {/* ---- run history ------------------------------------------------- */}
      {history.length > 1 && (
        <details className="group rounded-lg border border-border/60 bg-card/40">
          <summary className="flex cursor-pointer list-none items-center gap-2.5 p-3 [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">Run history</span>
              <span className="truncate text-xs text-muted-foreground">
                The last {history.length} runs. Only runs sharing a case set are
                comparable.
              </span>
            </div>
          </summary>
          <div className="overflow-x-auto border-t border-border/60 p-3">
            <table className="w-full min-w-[440px] text-left font-mono text-[11px]">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-normal">when</th>
                  <th className="py-1 pr-3 font-normal">result</th>
                  <th className="py-1 pr-3 font-normal">pass</th>
                  <th className="py-1 pr-3 font-normal">fail</th>
                  <th className="py-1 pr-3 font-normal">skip</th>
                  <th className="py-1 pr-3 font-normal">took</th>
                  <th className="py-1 font-normal">case set</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id} className="border-t border-border/40">
                    <td className="py-1 pr-3">{when(r.startedAt)}</td>
                    <td
                      className={cn("py-1 pr-3", STATUS_STYLE[r.status].text)}
                    >
                      {STATUS_STYLE[r.status].label}
                      {r.regressions?.length
                        ? ` · ${r.regressions.length} regressed`
                        : ""}
                    </td>
                    <td className="py-1 pr-3">{r.passed}</td>
                    <td
                      className={cn(
                        "py-1 pr-3",
                        r.failed && "text-destructive"
                      )}
                    >
                      {r.failed}
                    </td>
                    <td className="py-1 pr-3">{r.skipped}</td>
                    <td className="py-1 pr-3">{seconds(r.ms)}</td>
                    <td className="py-1 text-muted-foreground">
                      {r.caseSetHash.slice(0, 6)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  )
}
