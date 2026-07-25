import { useEffect, useState } from "react"
import { HistoryIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import { relativeTime } from "@/lib/time"
import type { ChatThreadMeta } from "@/lib/types"

/**
 * Past conversations, newest first. Server-side these are scoped to the
 * session user — nobody else's threads are listable or readable.
 */
export function ThreadHistory({ onPick }: { onPick: (id: string) => void }) {
  const now = useGrapevine((s) => s.now)
  const [threads, setThreads] = useState<ChatThreadMeta[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    api
      .chatThreads()
      .then((r) => setThreads(r.threads))
      .catch(() => setError(true))
  }, [])

  async function remove(id: string) {
    const prev = threads
    setThreads((t) => t?.filter((x) => x.id !== id) ?? null)
    try {
      await api.chatThreadDelete(id)
    } catch (err) {
      setThreads(prev ?? null)
      toast.error("Couldn't delete", { description: String(err).slice(0, 140) })
    }
  }

  if (error) {
    return (
      <p className="px-6 py-10 text-center text-xs text-muted-foreground">
        Couldn't load your chat history. Is the API running?
      </p>
    )
  }
  if (!threads) {
    return (
      <div className="flex items-center justify-center gap-2 px-6 py-10 text-xs text-muted-foreground">
        <Spinner className="size-3.5" /> Loading history…
      </div>
    )
  }
  if (threads.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
        <HistoryIcon className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium">No conversations yet</p>
        <p className="text-xs text-muted-foreground">
          Chats are saved to your account once you're signed in — pick one up
          again from here anytime.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-0.5 px-2 py-2">
      <span className="px-2 py-1 font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        History
      </span>
      {threads.map((t) => (
        <div
          key={t.id}
          className="group flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-accent/60"
        >
          <button
            type="button"
            onClick={() => onPick(t.id)}
            className="flex min-w-0 flex-1 items-baseline gap-2 px-2 py-2 text-left outline-none focus-visible:underline"
          >
            <span className="min-w-0 flex-1 truncate text-[13px]">
              {t.title || "Untitled chat"}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {relativeTime(t.updatedAt, now, "short")}
            </span>
          </button>
          <button
            type="button"
            aria-label="Delete conversation"
            onClick={() => void remove(t.id)}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
          >
            <Trash2Icon className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
