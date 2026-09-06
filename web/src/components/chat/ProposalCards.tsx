import { useState } from "react"
import { CalendarPlusIcon, CheckIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { EventChip } from "@/components/chat/EventChip"
import type { Proposal } from "@/hooks/useAgentChat"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import { INTEREST_TOPICS, type CityEvent } from "@/lib/types"

// ---------- proposal cards --------------------------------------------------

export function CalendarCard({
  proposal,
  onState,
}: {
  proposal: Extract<Proposal, { kind: "calendar" }>
  onState: (s: Proposal["state"]) => void
}) {
  const user = useGrapevine((s) => s.user)
  const events = useGrapevine((s) => s.events)
  const setCalendar = useGrapevine((s) => s.setCalendar)
  const [busy, setBusy] = useState(false)

  const list = proposal.eventIds
    .map((id) => events.find((e) => e.id === id))
    .filter((e): e is CityEvent => !!e)
  if (!list.length) return null

  async function undo() {
    try {
      let last
      for (const e of list) last = await api.calendarRemove(e.id)
      if (last) setCalendar(last)
      onState("pending")
    } catch (err) {
      toast.error("Couldn't undo", { description: String(err).slice(0, 140) })
    }
  }

  async function saveAll() {
    if (!user) {
      useGrapevine.getState().setSignInOpen(true)
      return
    }
    setBusy(true)
    try {
      let last
      for (const e of list) {
        last = await api.calendarAdd(e.id)
        // sync after every save, not just the last — a mid-loop failure
        // would otherwise leave earlier successes out of local state
        setCalendar(last)
      }
      onState("saved")
      toast.success(
        `Saved ${list.length} event${list.length === 1 ? "" : "s"} to your calendar`,
        {
          description: last?.warning
            ? "Google Calendar didn't sync — they're still in your Grapevine feed"
            : undefined,
          action: { label: "Undo", onClick: undo },
        }
      )
    } catch (err) {
      toast.error("Calendar save failed", {
        description: String(err).slice(0, 140),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="glass flex flex-col gap-2.5 rounded-xl p-3">
      <span className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        {proposal.note ?? "Save to calendar"}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {list.map((e) => (
          <EventChip key={e.id} id={e.id} label={e.title} />
        ))}
      </div>
      {proposal.state === "saved" ? (
        <div className="flex items-center gap-2 text-sm">
          <CheckIcon className="size-4 text-live" />
          On your calendar
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
          <Button size="sm" onClick={saveAll} disabled={busy}>
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <CalendarPlusIcon data-icon="inline-start" />
            )}
            {user ? `Save all (${list.length})` : "Sign in to save"}
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

export function InterestsCard({
  proposal,
  onState,
}: {
  proposal: Extract<Proposal, { kind: "interests" }>
  onState: (s: Proposal["state"]) => void
}) {
  const interests = useGrapevine((s) => s.interests)
  const setInterests = useGrapevine((s) => s.setInterests)

  // Re-validate client-side so a stale server vocab can't inject junk topics.
  const vet = (topics: string[]) =>
    topics.filter((t) => (INTEREST_TOPICS as readonly string[]).includes(t))
  const addLoves = vet(proposal.addLoves)
  const addAvoids = vet(proposal.addAvoids)
  const removeLoves = vet(proposal.removeLoves)
  const removeAvoids = vet(proposal.removeAvoids)
  const changes = [
    ...addLoves.map((t) => `+ ${t} → loves`),
    ...addAvoids.map((t) => `+ ${t} → avoids`),
    ...removeLoves.map((t) => `− ${t} from loves`),
    ...removeAvoids.map((t) => `− ${t} from avoids`),
  ]
  if (!changes.length) return null

  function apply() {
    const prior = interests
    // A topic can't be loved and avoided at once — the newer signal wins.
    const loves = [
      ...new Set([
        ...interests.loves.filter(
          (t) => !removeLoves.includes(t) && !addAvoids.includes(t)
        ),
        ...addLoves,
      ]),
    ]
    const avoids = [
      ...new Set([
        ...interests.avoids.filter(
          (t) => !removeAvoids.includes(t) && !addLoves.includes(t)
        ),
        ...addAvoids,
      ]),
    ]
    setInterests({ loves, avoids })
    onState("applied")
    toast.success("Interests updated", {
      action: {
        label: "Undo",
        onClick: () => {
          useGrapevine.getState().setInterests(prior)
          onState("pending")
        },
      },
    })
  }

  return (
    <div className="glass flex flex-col gap-2.5 rounded-xl p-3">
      <span className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        Tune interests
      </span>
      <div className="flex flex-wrap gap-1.5">
        {changes.map((c) => (
          <span
            key={c}
            className="rounded-full border border-border bg-secondary/60 px-2 py-0.5 text-xs"
          >
            {c}
          </span>
        ))}
      </div>
      {proposal.reason && (
        <span className="text-xs text-muted-foreground italic">
          {proposal.reason}
        </span>
      )}
      {proposal.state === "applied" ? (
        <div className="flex items-center gap-2 text-sm">
          <CheckIcon className="size-4 text-live" />
          Applied
        </div>
      ) : proposal.state === "dismissed" ? (
        <span className="text-xs text-muted-foreground">Dismissed</span>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" onClick={apply}>
            Apply
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
