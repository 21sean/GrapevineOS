// Eval suites and runs: the offline gate's suites from the same registry the
// CLI reads, filterable by tier or by what is failing, each expanding to its
// per-case results, plus the run history table behind a disclosure.

import { useMemo, useState } from "react"
import {
  CheckIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  PlayIcon,
  XIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type {
  EvalCatalog,
  EvalCaseResult,
  EvalKind,
  EvalRun,
  EvalStatus,
  EvalSuiteResult,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { ScoreBar } from "@/components/admin/monitoring/primitives"
import {
  STATUS_STYLE,
  seconds,
  when,
} from "@/components/admin/monitoring/shared"

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

type Filter = "all" | "failing" | EvalKind

export function EvalsSection({
  catalog,
  liveSuites,
  history,
  busy,
  elsewhere,
  start,
}: {
  catalog: EvalCatalog | null
  liveSuites: Record<string, EvalSuiteResult>
  history: EvalRun[]
  busy: boolean
  elsewhere: boolean
  start: (suites?: string[]) => Promise<void>
}) {
  const [filter, setFilter] = useState<Filter>("all")

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

  const kinds = [...new Set((catalog?.suites ?? []).map((s) => s.kind))]

  return (
    <>
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
    </>
  )
}
