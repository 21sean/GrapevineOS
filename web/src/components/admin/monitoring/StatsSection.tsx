// The headline strip, the "is it green right now" answer: rail status and
// mode, the window picker, five counters (pass rate, suites green, rail
// decisions, blocked, judged conversations), the eval run controls with the
// pass-rate trend, and the what-changed card that compares the last run with
// the last comparable one.

import { useMemo } from "react"
import {
  PlayIcon,
  RefreshCwIcon,
  ShieldIcon,
  SquareIcon,
  TrendingDownIcon,
  TrendingUpIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  GUARDRAIL_MODES,
  type ConversationMonitorRow,
  type EvalCatalog,
  type EvalRun,
  type EvalStatus,
  type EvalSuiteResult,
  type GuardrailDashboard,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { Stat } from "@/components/admin/monitoring/primitives"
import {
  STATUS_STYLE,
  pct,
  when,
  type EvalProgress,
} from "@/components/admin/monitoring/shared"

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

export function StatsSection({
  rails,
  railError,
  windowDays,
  setWindowDays,
  refreshing,
  onRefresh,
  setMode,
  catalog,
  evalError,
  run,
  history,
  liveSuites,
  progress,
  busy,
  elsewhere,
  start,
  onStop,
  threads,
}: {
  rails: GuardrailDashboard | null
  railError: string | null
  windowDays: number
  setWindowDays: (days: number) => void
  refreshing: boolean
  onRefresh: () => void
  setMode: (mode: GuardrailDashboard["mode"]) => Promise<void>
  catalog: EvalCatalog | null
  evalError: string | null
  run: EvalRun | null
  history: EvalRun[]
  liveSuites: Record<string, EvalSuiteResult>
  progress: EvalProgress | null
  busy: boolean
  elsewhere: boolean
  start: (suites?: string[]) => Promise<void>
  onStop: () => void
  threads: ConversationMonitorRow[] | null
}) {
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
  const judged = totals.passed + totals.failed
  const passRate = judged ? totals.passed / judged : 0

  const totalRecent = rails?.rails.reduce((n, r) => n + r.recent.n, 0) ?? 0
  const totalBlocked =
    rails?.rails.reduce((n, r) => n + r.recent.blocked, 0) ?? 0
  const evaluated = threads?.filter((t) => t.eval) ?? []
  const flagged = evaluated.filter((t) => t.eval!.verdict !== "pass").length

  return (
    <>
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
                    Rails off; only the persona scrubber is running.
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
                    {rails.modelLabel} has not answered, so the rails are
                    failing open.
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
              onClick={onRefresh}
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
              <Button variant="outline" size="sm" onClick={onStop}>
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
    </>
  )
}
