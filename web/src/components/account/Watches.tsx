import { useCallback, useEffect, useState } from "react"
import { EyeIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { SectionHeader } from "@/components/account/SectionHeader"
import { api } from "@/lib/api"
import { cadenceLabel } from "@/lib/time"
import type { DiscoverySearch } from "@/lib/types"

/**
 * The watches this account keeps: recurring web-discovery searches the
 * server runs on a cadence, whose verified finds land on the shared map.
 * Created from the chat ("watch for jazz shows", then confirm the card);
 * paused or deleted here.
 */
export function Watches({ onOpenChat }: { onOpenChat: () => void }) {
  const [state, setState] = useState<{
    watches: DiscoverySearch[]
    max: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(
    () =>
      api
        .watches()
        .then((s) => {
          setState(s)
          setError(null)
        })
        .catch((err) => setError(String(err).slice(0, 120))),
    []
  )
  useEffect(() => {
    void refresh()
  }, [refresh])

  async function toggle(w: DiscoverySearch, on: boolean) {
    try {
      await api.patchWatch(w.id, { active: on })
    } catch {
      toast.error("Couldn't update the watch")
    } finally {
      void refresh()
    }
  }

  async function remove(w: DiscoverySearch) {
    try {
      await api.deleteWatch(w.id)
      toast.success("Watch removed", { description: w.query })
    } catch {
      toast.error("Couldn't remove the watch")
    } finally {
      void refresh()
    }
  }

  const watches = state?.watches ?? []

  return (
    <section>
      <SectionHeader
        icon={<EyeIcon className="size-3.5" />}
        title="Watches"
        action={
          state ? (
            <span className="font-mono text-xs text-muted-foreground">
              {watches.length}/{state.max}
            </span>
          ) : undefined
        }
      />
      {error ? (
        <p className="mt-2 text-xs text-destructive">{error}</p>
      ) : !state ? (
        <Spinner className="mt-2 size-4" />
      ) : watches.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Nothing watched yet. Ask Grapevine to{" "}
          <button
            type="button"
            onClick={onOpenChat}
            className="underline underline-offset-2"
          >
            “watch for jazz shows”
          </button>{" "}
          and confirm the card. The server re-searches the web on a schedule,
          verifies what it finds against the source page, and puts real events
          on the map.
        </p>
      ) : (
        <div className="mt-2 flex flex-col divide-y divide-border overflow-hidden rounded-lg border">
          {watches.map((w) => (
            <div
              key={w.id}
              className="flex items-center gap-3 py-2 pr-1.5 pl-3"
            >
              <Switch
                checked={w.active}
                onCheckedChange={(on) => void toggle(w, on)}
                aria-label={`${w.active ? "Pause" : "Resume"} ${w.query}`}
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-medium">
                  {w.query}
                </span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {cadenceLabel(w.cadenceHours)}
                  {w.lastRunAt
                    ? ` · last run ${new Date(w.lastRunAt).toLocaleDateString()}`
                    : " · not run yet"}
                  {w.lastStatus ? ` · ${w.lastStatus}` : ""}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove watch ${w.query}`}
                onClick={() => void remove(w)}
                className="text-muted-foreground"
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
