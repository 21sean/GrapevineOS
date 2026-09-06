import { useEffect } from "react"
import { useGrapevine } from "@/lib/store"
import { timeRange } from "@/lib/time"
import { CATEGORY_META } from "@/lib/types"

/**
 * An inline pill for an event the assistant mentioned: the category dot, the
 * title and the printed time, and a tap selects the event on the map. Shared
 * by the transcript's rich text, the proposal cards and the "shown on map"
 * strip, so it lives here rather than in AgentChat, which imports all three.
 */

// One refresh attempt per unknown event id covers "event landed after page
// load" for every chip, new agent turns and loadThread on old transcripts
// alike; an id still unknown after its refresh is a hallucinated one and
// renders as plain text.
const refreshAttempted = new Set<string>()

export function EventChip({ id, label }: { id: string; label: string }) {
  const event = useGrapevine((s) => s.events.find((e) => e.id === id))
  const select = useGrapevine((s) => s.select)
  const tz = useGrapevine((s) => s.settings?.tz) ?? "UTC"
  // A string, not the raw clock: chips in a long transcript re-render only
  // when their printed time actually changes.
  const range = useGrapevine((s) => (event ? timeRange(event, tz, s.now) : ""))

  useEffect(() => {
    if (!event && !refreshAttempted.has(id)) {
      refreshAttempted.add(id)
      useGrapevine
        .getState()
        .refreshEvents()
        .catch(() => {})
    }
  }, [event, id])

  if (!event) return <span className="font-medium">{label}</span>
  return (
    <button
      type="button"
      onClick={() => select(event.id)}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-2 py-0.5 align-middle text-xs font-medium transition-colors hover:bg-secondary"
    >
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: CATEGORY_META[event.category].color }}
      />
      <span className="truncate">{event.title}</span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {range}
      </span>
    </button>
  )
}
