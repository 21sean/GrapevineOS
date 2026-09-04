import { useState } from "react"
import { CheckIcon, EyeIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { Proposal } from "@/hooks/useAgentChat"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import { cadenceLabel } from "@/lib/time"

/**
 * The card behind propose_watch: the agent offers to keep searching the web
 * for a topic, and nothing is scheduled until the person taps. Same
 * human-in-the-loop shape as the calendar card, and the watch shows up in
 * Account, Watches the moment it is confirmed.
 */
export function WatchCard({
  proposal,
  onState,
}: {
  proposal: Extract<Proposal, { kind: "watch" }>
  onState: (s: Proposal["state"]) => void
}) {
  const user = useGrapevine((s) => s.user)
  const [busy, setBusy] = useState(false)
  const [watchId, setWatchId] = useState<string | null>(null)

  async function undo() {
    if (!watchId) return
    try {
      await api.deleteWatch(watchId)
      setWatchId(null)
      onState("pending")
    } catch (err) {
      toast.error("Couldn't undo", { description: String(err).slice(0, 140) })
    }
  }

  async function schedule() {
    if (!user) {
      useGrapevine.getState().setSignInOpen(true)
      return
    }
    setBusy(true)
    try {
      const watch = await api.addWatch(proposal.query, proposal.cadenceHours)
      setWatchId(watch.id)
      onState("scheduled")
      toast.success(`Watching: ${proposal.query}`, {
        description: `${cadenceLabel(proposal.cadenceHours)}. Verified finds land on the map; manage it under Account, Watches.`,
        action: { label: "Undo", onClick: undo },
      })
    } catch (err) {
      toast.error("Couldn't schedule the watch", {
        description: String(err).slice(0, 140),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="glass flex flex-col gap-2.5 rounded-xl p-3">
      <span className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        {proposal.note ?? "Keep watching"}
      </span>
      <div className="text-sm">
        <span className="font-medium">{proposal.query}</span>
        <span className="text-muted-foreground">
          {" "}
          · {cadenceLabel(proposal.cadenceHours)}
        </span>
      </div>
      <span className="text-xs text-muted-foreground">
        The server re-searches the web on that cadence, verifies each find
        against its source page, and puts real events on the map for everyone.
      </span>
      {proposal.state === "scheduled" ? (
        <div className="flex items-center gap-2 text-sm">
          <CheckIcon className="size-4 text-live" />
          Watching
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={undo}
          >
            Undo
          </Button>
        </div>
      ) : proposal.state === "dismissed" ? (
        <span className="text-xs text-muted-foreground">Dismissed</span>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" onClick={schedule} disabled={busy}>
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <EyeIcon data-icon="inline-start" />
            )}
            {user ? "Start watching" : "Sign in to watch"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onState("dismissed")}
          >
            Dismiss
          </Button>
        </div>
      )}
    </div>
  )
}
