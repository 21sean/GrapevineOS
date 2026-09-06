// Shared meta for the Monitoring sections: the pass/fail/skipped palette, the
// number and relative-time formatters, and the small types the tab threads
// through to more than one section. Helpers only, no components, so every
// section file stays a clean fast-refresh boundary.

import type { EvalStatus } from "@/lib/types"

export const STATUS_STYLE: Record<
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

export const pct = (v: number) =>
  `${(v * 100).toFixed(v < 0.1 && v > 0 ? 1 : 0)}%`
export const num = (v: number | null, digits = 3) =>
  v === null ? "—" : v.toFixed(digits)
export const seconds = (ms: number) =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)}s`

export function when(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Which slice of recorded rail decisions the review queue shows. */
export type ScanQueue = "unjudged" | "blocked" | "recent"

/** Where a running eval is, for the progress bar in the headline strip. */
export type EvalProgress = {
  suite: string
  done: number
  total: number
  label: string
}
