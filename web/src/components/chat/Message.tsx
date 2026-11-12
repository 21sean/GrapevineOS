import { memo } from "react"
import { CheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Hint } from "./Hint"
import { EventChip } from "./EventChip"
import { CalendarCard, InterestsCard, RarityCard } from "./ProposalCards"
import { WatchCard } from "./WatchCard"
import { EVENT_LINK_RE, RichText } from "./RichText"
import type { useAgentChat, ChatItem } from "@/hooks/useAgentChat"
import { useGrapevine } from "@/lib/store"
import type { ChatUsage } from "@/lib/types"

export const Message = memo(function Message({
  item,
  itemIdx,
  setProposalState,
  onRetry,
}: {
  item: ChatItem
  itemIdx: number
  setProposalState: ReturnType<typeof useAgentChat>["setProposalState"]
  onRetry?: () => void
}) {
  const setAdminOpen = useGrapevine((s) => s.setAdminOpen)

  if (item.kind === "user") {
    return (
      <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-secondary px-3.5 py-2 text-sm">
        {item.text}
      </div>
    )
  }

  const linked = new Set(
    [...item.text.matchAll(EVENT_LINK_RE)].map((m) => m[2])
  )
  const chipRow = item.highlights.filter((id) => !linked.has(id))

  return (
    <div className="flex max-w-full flex-col gap-2">
      {item.notices.map((n, i) => (
        <div
          key={i}
          className="flex flex-wrap items-center gap-2 rounded-lg bg-card/60 px-3 py-2 text-xs text-muted-foreground"
        >
          <span className="min-w-0">{n.message}</span>
          {["no-model", "ollama-down", "no-tools"].includes(n.code) && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setAdminOpen(true)}
            >
              Open Admin
            </Button>
          )}
        </div>
      ))}

      {item.tools.length > 0 && (
        <div className="flex flex-col gap-1">
          {item.tools.map((t, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
            >
              {t.done ? (
                <CheckIcon className="size-3 text-live" />
              ) : (
                <Spinner className="size-3" />
              )}
              <span>
                {t.label}
                {t.detail ? ` · ${t.detail}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {item.status && (
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <Spinner className="size-3" />
          {item.status}
        </div>
      )}

      {item.text && <RichText text={item.text} />}

      {item.streaming &&
        !item.text &&
        !item.status &&
        item.tools.length === 0 && (
          <Spinner className="size-3.5 text-muted-foreground" />
        )}

      {chipRow.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chipRow.map((id) => (
            <EventChip key={id} id={id} label={id} />
          ))}
        </div>
      )}

      {item.proposals.map((p, i) =>
        p.kind === "calendar" ? (
          <CalendarCard
            key={i}
            proposal={p}
            onState={(s) => setProposalState(itemIdx, i, s)}
          />
        ) : p.kind === "rarity" ? (
          <RarityCard
            key={i}
            proposal={p}
            onState={(s) => setProposalState(itemIdx, i, s)}
          />
        ) : p.kind === "watch" ? (
          <WatchCard
            key={i}
            proposal={p}
            onState={(s) => setProposalState(itemIdx, i, s)}
          />
        ) : (
          <InterestsCard
            key={i}
            proposal={p}
            onState={(s) => setProposalState(itemIdx, i, s)}
          />
        )
      )}

      {item.usage && !item.streaming && <UsageLine usage={item.usage} />}

      {item.error && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
          <span className="text-destructive-foreground/90 min-w-0">
            {item.error}
          </span>
          {onRetry && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onRetry}
            >
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  )
})

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

/** Per-turn token footer under a reply. The input figure counts everything
 *  the turn read, cache included. */
function UsageLine({ usage }: { usage: ChatUsage }) {
  const parts: string[] = []
  if (usage.model) parts.push(usage.model)
  parts.push(`${fmtTokens(usage.inputTokens)} in`)
  parts.push(`${fmtTokens(usage.outputTokens)} out`)
  const cached = usage.cacheReadInputTokens ?? 0
  return (
    <Hint
      label={[
        cached
          ? `This turn read ${fmtTokens(usage.inputTokens)} input tokens, ${fmtTokens(cached)} of them from cache.`
          : "This turn's token usage.",
        usage.visibleTtftMs
          ? `First words after ${(usage.visibleTtftMs / 1000).toFixed(1)}s.`
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* tabIndex so the explanation is reachable without a pointer; this is
          the only place the cache split is written down. */}
      <div
        tabIndex={0}
        className="font-mono text-[10px] text-muted-foreground/70"
      >
        {parts.join(" · ")}
      </div>
    </Hint>
  )
}
