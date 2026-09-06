// Small presentational pieces used by more than one Monitoring section: a
// labelled number for the stat strips (headline and rail cards), and a score
// bar drawn against the threshold it has to clear (suites and judged
// conversations).

import type { EvalStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import { STATUS_STYLE } from "@/components/admin/monitoring/shared"

/** One number with a label under it. The strip along the top of the page. */
export function Stat({
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
export function ScoreBar({
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
