// Per-thread judge results: every persisted Ask Grapevine thread with what
// the rails did during it and how the local judge scored it, one row each.
// A row expands to the per-metric scores and reasoning; the gavel judges or
// re-judges the thread.

import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react"
import { GavelIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import type {
  ConversationMonitorRow,
  ConversationVerdict,
  EvalStatus,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { ScoreBar } from "@/components/admin/monitoring/primitives"
import {
  STATUS_STYLE,
  seconds,
  when,
} from "@/components/admin/monitoring/shared"

const VERDICT_STYLE: Record<
  ConversationVerdict,
  { dot: string; text: string; label: string }
> = {
  pass: { dot: "bg-chart-3", text: "text-chart-3", label: "pass" },
  borderline: { dot: "bg-chart-2", text: "text-chart-2", label: "borderline" },
  fail: { dot: "bg-destructive", text: "text-destructive", label: "fail" },
}

/**
 * One thread in the past-conversations table: what happened, what the rails
 * did about it, what the judge thought of it. The row is the trace unit every
 * observability guide converges on. Aggregate charts say that something
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
                  Not judged yet. The gavel runs the three conversation metrics
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

export function ConversationsSection({
  threads,
  setThreads,
}: {
  threads: ConversationMonitorRow[] | null
  setThreads: Dispatch<SetStateAction<ConversationMonitorRow[] | null>>
}) {
  const [judging, setJudging] = useState<string | null>(null)

  const judgeThread = useCallback(
    async (id: string) => {
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
    },
    [setThreads]
  )

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1">
        <h3 className="font-heading text-base font-semibold">Conversations</h3>
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
          No conversations yet. Ask Grapevine threads land here once someone
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
  )
}
