import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CheckIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  PlayIcon,
  SquareIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  XIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import {
  CATEGORY_META,
  type EvalCatalog,
  type EvalCaseResult,
  type EvalKind,
  type EvalPersona,
  type EvalRun,
  type EvalStatus,
  type EvalSuiteResult,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { HARDENING } from "@/components/admin/evalNotes"

/**
 * Admin → Evals.
 *
 * Shaped around the three questions an operator asks in order: is it green,
 * what changed since last time, and what exactly is being claimed. So the
 * scoreboard comes first, the regression list second, and the suites — down to
 * individual cases with the value each one observed — third.
 *
 * Two things this panel deliberately does NOT do. It does not compute a score
 * or a pass: every number here is read from the same registry the CLI gate
 * reads, because a dashboard with its own arithmetic eventually disagrees with
 * the gate and then nobody can tell which one is lying. And it does not treat
 * a skipped suite as a pass — an unrun check is unknown, and "unknown" must
 * never be allowed to look like "fine".
 *
 * Suites come in three tiers and are priced very differently: `offline` is
 * milliseconds of pure functions over frozen fixtures, `model` is seconds of
 * local ONNX classifier, `judge` is minutes of local GPU running DeepEval
 * metrics. The tier filter exists so the cheap signal stays reachable without
 * paying for the expensive one.
 */

/**
 * Palette colors, not stock semantic ones. `--live` is this app's warm gold
 * and already means "happening now" in the header and on every marker, so
 * reusing it for "passing" would make two unrelated things the same color.
 * chart-3/chart-2 are the system's green and amber.
 */
const STATUS_STYLE: Record<EvalStatus, { dot: string; text: string; bar: string; label: string }> = {
  pass: { dot: "bg-chart-3", text: "text-chart-3", bar: "bg-chart-3", label: "passing" },
  fail: { dot: "bg-destructive", text: "text-destructive", bar: "bg-destructive", label: "failing" },
  skipped: { dot: "bg-chart-2", text: "text-chart-2", bar: "bg-chart-2", label: "skipped" },
}

const KIND_META: Record<EvalKind, { label: string; blurb: string }> = {
  offline: { label: "offline", blurb: "Pure functions over frozen fixtures. Milliseconds, deterministic." },
  model: { label: "model", blurb: "Needs the local guardrail classifier on disk. Seconds." },
  judge: { label: "judged", blurb: "Graded by an LLM judge on local Ollama. Minutes of GPU." },
}

function StatusDot({ status, className }: { status: EvalStatus; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", STATUS_STYLE[status].dot, className)}
    />
  )
}

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)}s`)

function when(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(iso).toLocaleDateString()
}

// ---------------------------------------------------------------------------

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
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
 * A suite's score against the bar it has to clear.
 *
 * Most suites here are threshold 1 — assertions about deterministic code,
 * where "most of them hold" is not a result anyone should ship on. The judged
 * suites sit below 1 on purpose, because a judge is a measurement instrument
 * with noise in it. Drawing the threshold rather than hiding it is what makes
 * those two facts legible in the same table.
 */
function ScoreBar({ score, threshold, status }: { score: number; threshold: number; status: EvalStatus }) {
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
    <div className="flex h-8 items-end gap-0.5" aria-label="Pass rate across recent runs">
      {points.map((p, i) => (
        <div
          key={p.run.id}
          title={`${when(p.run.startedAt)} · ${(p.rate * 100).toFixed(0)}% · ${p.run.failed} failing`}
          className={cn(
            "w-1.5 rounded-t-[1px]",
            p.run.failed > 0 ? "bg-destructive/70" : "bg-chart-3/60",
            i === points.length - 1 && "ring-1 ring-foreground/30",
          )}
          style={{ height: `${Math.max(8, p.rate * 100)}%` }}
        />
      ))}
    </div>
  )
}

function CaseRow({ result, slowest }: { result: EvalCaseResult; slowest: number }) {
  const Icon = result.status === "pass" ? CheckIcon : result.status === "fail" ? XIcon : CircleSlashIcon
  return (
    <li className="flex gap-2.5 py-1.5">
      <Icon
        className={cn("mt-0.5 size-3.5 shrink-0", STATUS_STYLE[result.status].text)}
        aria-label={STATUS_STYLE[result.status].label}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm leading-snug">{result.name}</span>
        <span
          className={cn(
            "font-mono text-[11px] leading-snug break-words",
            result.status === "pass" ? "text-muted-foreground" : STATUS_STYLE[result.status].text,
          )}
        >
          {result.detail}
        </span>
        {result.note && (
          <span className="text-xs leading-snug text-muted-foreground italic">{result.note}</span>
        )}
      </div>
      <span className="ml-auto flex shrink-0 flex-col items-end gap-1">
        <span className="font-mono text-[10px] text-muted-foreground">{result.ms}ms</span>
        {/* Only worth drawing once something in the suite is actually slow —
            a row of full-width bars on a 2ms suite is decoration. */}
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
  const status: EvalStatus = live?.status ?? (suite.unavailable ? "skipped" : "pass")
  const cases = live?.cases ?? []
  const failing = cases.filter((c) => c.status !== "pass")
  const slowest = Math.max(0, ...cases.map((c) => c.ms))
  const total = live ? live.passed + live.failed + live.skipped : suite.caseCount

  return (
    <details className="group rounded-lg border border-border/60 bg-card/40 open:bg-card/60">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 p-3 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        {live ? (
          <StatusDot status={status} />
        ) : (
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
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
          <span className="truncate text-xs text-muted-foreground">{suite.what}</span>
          {live && live.status !== "skipped" && (
            <ScoreBar score={live.score} threshold={live.threshold} status={status} />
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
                  {live.threshold < 1 && ` · bar ${(live.threshold * 100).toFixed(0)}%`}
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

function PersonaCard({ persona }: { persona: EvalPersona }) {
  const tint = CATEGORY_META[persona.tint]?.color ?? "#8fa3bf"
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-medium"
          style={{ background: `color-mix(in oklab, ${tint} 22%, transparent)`, color: tint }}
        >
          {persona.initials}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">{persona.name}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{persona.homeLabel}</span>
        </div>
      </div>

      <p className="text-xs leading-snug text-muted-foreground">{persona.blurb}</p>

      <div className="flex flex-wrap gap-1">
        {persona.loves.map((t) => (
          <Badge key={t} variant="outline" className="text-[10px] font-normal">
            {t}
          </Badge>
        ))}
        {persona.avoids.map((t) => (
          <Badge
            key={t}
            variant="outline"
            className="text-[10px] font-normal text-muted-foreground line-through"
          >
            {t}
          </Badge>
        ))}
      </div>

      {persona.history.length > 0 && (
        <div className="flex flex-col gap-1">
          {persona.history.map((h) => (
            <span key={h.title} className="flex items-baseline gap-1.5 text-[11px] text-muted-foreground">
              <span
                className={cn(
                  "font-mono",
                  h.reaction === "not_for_me" ? "text-destructive" : "text-live",
                )}
              >
                {h.reaction === "not_for_me" ? "not for me" : h.reaction}
              </span>
              <span className="truncate">{h.title}</span>
            </span>
          ))}
        </div>
      )}

      <ul className="flex flex-col gap-1 border-t border-border/50 pt-2">
        {persona.checks.map((c) => (
          <li key={c} className="flex gap-1.5 text-[11px] leading-snug text-muted-foreground">
            <CheckIcon className="mt-0.5 size-3 shrink-0 text-chart-3" />
            {c}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------

type Filter = "all" | "failing" | EvalKind

export function EvalsTab() {
  const [catalog, setCatalog] = useState<EvalCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [run, setRun] = useState<EvalRun | null>(null)
  const [history, setHistory] = useState<EvalRun[]>([])
  const [liveSuites, setLiveSuites] = useState<Record<string, EvalSuiteResult>>({})
  const [progress, setProgress] = useState<{ suite: string; done: number; total: number; label: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Filter>("all")
  const abortRef = useRef<AbortController | null>(null)

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
            setLiveSuites(Object.fromEntries(c.lastRun.suites.map((s) => [s.id, s])))
          }
          // Runs are serialized server-side, so a run somebody else started
          // blocks this panel's buttons. Poll until it clears rather than
          // leaving them disabled against a fact that stopped being true.
          if (c.running) timer = setTimeout(load, 2500)
        })
        .catch((err) => live && setError(String(err).slice(0, 200)))
      api
        .evalHistory()
        .then((h) => live && setHistory(h.runs))
        .catch(() => {
          /* history is a nicety; its absence must not blank the panel */
        })
    }
    load()

    // Any run still streaming when the sheet closed is server-side; the abort
    // below is only for this component's own request.
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
    setError(null)
    setProgress(null)
    // Clear only what is about to be re-run, so a single-suite run keeps the
    // rest of the last run on screen instead of blanking the panel.
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
            setProgress({ suite: frame.title, done: 0, total: frame.total, label: "" })
          }
          if (frame.type === "case") {
            done += 1
            setProgress((p) => (p ? { ...p, done, label: frame.result.name } : p))
          }
          if (frame.type === "suite-done") {
            setLiveSuites((prev) => ({ ...prev, [frame.result.id]: frame.result }))
          }
          if (frame.type === "done") {
            setRun(frame.run)
            setLiveSuites((prev) => ({
              ...prev,
              ...Object.fromEntries(frame.run.suites.map((s) => [s.id, s])),
            }))
            setHistory((prev) => [frame.run, ...prev].slice(0, 25))
          }
          if (frame.type === "error") setError(frame.message)
        },
        controller.signal,
      )
    } catch (err) {
      if (!controller.signal.aborted) setError(String(err).slice(0, 200))
    } finally {
      setBusy(false)
      setProgress(null)
      abortRef.current = null
    }
  }, [])

  const totals = useMemo(() => {
    const suites = Object.values(liveSuites)
    return {
      passed: suites.reduce((n, s) => n + s.passed, 0),
      failed: suites.reduce((n, s) => n + s.failed, 0),
      skippedCases: suites.reduce((n, s) => n + s.skipped, 0),
      skippedSuites: suites.filter((s) => s.status === "skipped").length,
      green: suites.filter((s) => s.status === "pass").length,
      ran: suites.length,
    }
  }, [liveSuites])

  const overall: EvalStatus =
    totals.failed > 0 ? "fail" : totals.skippedSuites > 0 ? "skipped" : "pass"
  const elsewhere = !!catalog?.running && !busy
  const declared = catalog?.suites.reduce((n, s) => n + s.caseCount, 0) ?? 0
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

  if (error && !catalog) return <p className="text-sm text-destructive">{error}</p>
  if (!catalog) return <Spinner className="mx-auto" />

  const kinds = [...new Set(catalog.suites.map((s) => s.kind))]

  return (
    <div className="flex flex-col gap-5">
      {/* ---- scoreboard -------------------------------------------------- */}
      <div className="flex flex-col gap-3 rounded-lg bg-card/60 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-2 text-sm">
              {totals.ran > 0 ? (
                <>
                  <StatusDot status={overall} />
                  <span className={STATUS_STYLE[overall].text}>
                    {totals.failed
                      ? `${totals.failed} failing`
                      : totals.passed
                        ? `${totals.passed} checks passing`
                        : "nothing ran"}
                  </span>
                  {(totals.skippedCases > 0 || totals.skippedSuites > 0) && (
                    <span className="text-muted-foreground">
                      ·{" "}
                      {totals.skippedSuites > 0
                        ? `${totals.skippedSuites} suite${totals.skippedSuites === 1 ? "" : "s"} skipped`
                        : `${totals.skippedCases} skipped`}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <span aria-hidden className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
                  <span className="text-muted-foreground">
                    {declared} checks across {catalog.suites.length} suites, never run here
                  </span>
                </>
              )}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {run
                ? [
                    when(run.startedAt),
                    seconds(run.ms),
                    // A single-suite run leaves the other suites on screen from
                    // an earlier one, so say so rather than letting the
                    // timestamp claim the whole board was just re-checked.
                    run.suites.length < catalog.suites.length
                      ? `${run.suites.length} of ${catalog.suites.length} suites`
                      : `case set ${run.caseSetHash}`,
                  ].join(" · ")
                : `frozen at ${new Date(catalog.fixtureNow).toLocaleString()} · ${catalog.fixtureEvents} fixture events`}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <Trend runs={history} />
            {busy ? (
              <Button variant="outline" onClick={() => abortRef.current?.abort()}>
                <SquareIcon data-icon="inline-start" />
                Stop
              </Button>
            ) : (
              // Runs are serialized on the server, so a run started from another
              // tab or by the CLI would come back 409. Say that up front instead
              // of offering a button that cannot work.
              <Button disabled={elsewhere} onClick={() => start()}>
                <PlayIcon data-icon="inline-start" />
                {elsewhere ? "Running elsewhere" : "Run all"}
              </Button>
            )}
          </div>
        </div>

        {totals.ran > 0 && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border/50 pt-3 sm:grid-cols-4">
            <Stat
              label="pass rate"
              value={`${(passRate * 100).toFixed(0)}%`}
              hint={`${totals.passed} of ${judged} judged`}
              tone={STATUS_STYLE[overall].text}
            />
            <Stat
              label="suites green"
              value={`${totals.green}/${totals.ran}`}
              hint={totals.skippedSuites ? `${totals.skippedSuites} unavailable` : "all ran"}
            />
            <Stat label="duration" value={run ? seconds(run.ms) : "—"} hint="whole run" />
            <Stat
              label="case set"
              value={run?.caseSetHash.slice(0, 6) ?? "—"}
              hint="runs compare only within one"
            />
          </div>
        )}

        {progress && (
          <div className="flex flex-col gap-1.5">
            <Progress
              value={progress.total ? (progress.done / progress.total) * 100 : null}
              className="h-1.5"
            />
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              {progress.suite} · {progress.done}/{progress.total}
              {progress.label ? ` · ${progress.label}` : ""}
            </span>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      {/* ---- what changed ---------------------------------------------- */}
      {(run?.regressions?.length || run?.fixes?.length) && (
        <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
          <span className="text-xs text-muted-foreground">
            Compared with the last run that asked the same questions.
          </span>
          {run.regressions?.map((id) => (
            <span key={id} className="flex items-center gap-2 font-mono text-xs text-destructive">
              <TrendingDownIcon className="size-3.5 shrink-0" />
              {id}
            </span>
          ))}
          {run.fixes?.map((id) => (
            <span key={id} className="flex items-center gap-2 font-mono text-xs text-chart-3">
              <TrendingUpIcon className="size-3.5 shrink-0" />
              {id}
            </span>
          ))}
        </div>
      )}

      {/* ---- suites ----------------------------------------------------- */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {(["all", "failing", ...kinds] as Filter[]).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? "secondary" : "ghost"}
              className="h-7 px-2.5 text-[11px]"
              title={f in KIND_META ? KIND_META[f as EvalKind].blurb : undefined}
              onClick={() => setFilter(f)}
            >
              {f === "all" || f === "failing" ? f : KIND_META[f as EvalKind].label}
            </Button>
          ))}
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {visible.length} of {catalog.suites.length} suites
          </span>
        </div>

        {visible.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground italic">
            {filter === "failing" ? "Nothing is failing." : "No suites in this tier."}
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
                The last {history.length} runs. Only runs sharing a case set are comparable.
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
                    <td className={cn("py-1 pr-3", STATUS_STYLE[r.status].text)}>
                      {STATUS_STYLE[r.status].label}
                      {r.regressions?.length ? ` · ${r.regressions.length} regressed` : ""}
                    </td>
                    <td className="py-1 pr-3">{r.passed}</td>
                    <td className={cn("py-1 pr-3", r.failed && "text-destructive")}>{r.failed}</td>
                    <td className="py-1 pr-3">{r.skipped}</td>
                    <td className="py-1 pr-3">{seconds(r.ms)}</td>
                    <td className="py-1 text-muted-foreground">{r.caseSetHash.slice(0, 6)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <Separator />

      {/* ---- example users ---------------------------------------------- */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="font-heading text-base font-semibold">Example users</h3>
          <p className="text-sm text-muted-foreground">
            Fixtures, not accounts. Personalization is asserted against a person
            with a stated taste, so a red case reads as a promise broken to
            someone rather than an assertion number. Their cases are the{" "}
            <span className="font-mono text-xs">personas</span> suite above.
          </p>
        </div>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {catalog.personas.map((p) => (
            <PersonaCard key={p.id} persona={p} />
          ))}
        </div>
      </div>

      <Separator />

      {/* ---- the collapsed register ------------------------------------- */}
      <details className="group rounded-lg border border-border/60 bg-card/40">
        <summary className="flex cursor-pointer list-none items-center gap-2.5 p-3 [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">Production notes</span>
            <span className="truncate text-xs text-muted-foreground">
              Every failure mode this harness was built against, and the ones it
              does not cover.
            </span>
          </div>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
            {HARDENING.reduce((n, g) => n + g.items.length, 0)} notes
          </span>
        </summary>

        <div className="flex flex-col gap-4 border-t border-border/60 px-3 pt-3 pb-3">
          {HARDENING.map((group) => (
            <div key={group.title} className="flex flex-col gap-2">
              <h4 className="font-mono text-[11px] tracking-[0.14em] text-wine uppercase">
                {group.title}
              </h4>
              <ul className="flex flex-col gap-2.5">
                {group.items.map((item) => (
                  <li key={item.risk} className="flex flex-col gap-0.5">
                    <span className="text-sm leading-snug font-medium">{item.risk}</span>
                    <span className="text-xs leading-snug text-muted-foreground">
                      {item.handled}
                    </span>
                    {item.where && (
                      <span className="font-mono text-[10px] text-muted-foreground/80">
                        {item.where}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}
