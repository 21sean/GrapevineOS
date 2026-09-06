import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import type {
  ConversationMonitorRow,
  EvalCatalog,
  EvalRun,
  EvalSuiteResult,
  GuardrailDashboard,
  GuardrailScan,
} from "@/lib/types"
import { ConversationsSection } from "@/components/admin/monitoring/ConversationsSection"
import { EvalsSection } from "@/components/admin/monitoring/EvalsSection"
import { RailsSection } from "@/components/admin/monitoring/RailsSection"
import { StatsSection } from "@/components/admin/monitoring/StatsSection"
import type {
  EvalProgress,
  ScanQueue,
} from "@/components/admin/monitoring/shared"

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
 *
 * The sections live in ./monitoring, one file each. This file owns the state
 * more than one of them reads (the rail dashboard, the eval catalog and runs,
 * the thread list, and the loaders that refresh them together) and composes
 * the sections in the order above. State only one section touches lives in
 * that section.
 */

export function MonitoringTab() {
  // rails
  const [rails, setRails] = useState<GuardrailDashboard | null>(null)
  const [railError, setRailError] = useState<string | null>(null)
  const [windowDays, setWindowDays] = useState(7)
  const [refreshing, setRefreshing] = useState(false)
  const [scans, setScans] = useState<GuardrailScan[]>([])
  const [queue, setQueue] = useState<ScanQueue>("unjudged")

  // evals
  const [catalog, setCatalog] = useState<EvalCatalog | null>(null)
  const [evalError, setEvalError] = useState<string | null>(null)
  const [run, setRun] = useState<EvalRun | null>(null)
  const [history, setHistory] = useState<EvalRun[]>([])
  const [liveSuites, setLiveSuites] = useState<Record<string, EvalSuiteResult>>(
    {}
  )
  const [progress, setProgress] = useState<EvalProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // conversations
  const [threads, setThreads] = useState<ConversationMonitorRow[] | null>(null)

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

  // ---- derived ------------------------------------------------------------

  const elsewhere = !!catalog?.running && !busy

  if (railError && !rails && !catalog) {
    return <p className="text-sm text-destructive">{railError}</p>
  }
  if (!rails && !catalog) return <Spinner className="mx-auto" />

  return (
    <div className="flex flex-col gap-5">
      <StatsSection
        rails={rails}
        railError={railError}
        windowDays={windowDays}
        setWindowDays={setWindowDays}
        refreshing={refreshing}
        onRefresh={() => void loadRails(windowDays, queue)}
        setMode={setMode}
        catalog={catalog}
        evalError={evalError}
        run={run}
        history={history}
        liveSuites={liveSuites}
        progress={progress}
        busy={busy}
        elsewhere={elsewhere}
        start={start}
        onStop={() => abortRef.current?.abort()}
        threads={threads}
      />

      <ConversationsSection threads={threads} setThreads={setThreads} />

      <Separator />

      <RailsSection
        rails={rails}
        scans={scans}
        setScans={setScans}
        queue={queue}
        setQueue={setQueue}
      />

      <Separator />

      <EvalsSection
        catalog={catalog}
        liveSuites={liveSuites}
        history={history}
        busy={busy}
        elsewhere={elsewhere}
        start={start}
      />
    </div>
  )
}
