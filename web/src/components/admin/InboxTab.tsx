import { useEffect, useState } from "react"
import { MailIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import type { InboxEmail } from "@/lib/types"

/**
 * The raw emails sitting in Cloudflare KV, straight from the email worker —
 * what arrived, whether the poller has processed it, and a re-run button for
 * when a newsletter deserves a second pass (better model, tweaked prompt).
 */
export function InboxTab() {
  const refreshEvents = useGrapevine((s) => s.refreshEvents)
  const inboxDomain = useGrapevine((s) => s.settings?.inboxDomain ?? "example.com")

  const [emails, setEmails] = useState<InboxEmail[] | null>(null)
  const [configured, setConfigured] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.inbox()
      setConfigured(res.configured)
      setEmails(res.emails)
    } catch (err) {
      setError(String(err).slice(0, 200))
      setEmails([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function reprocess(email: InboxEmail) {
    setBusyKey(email.key)
    try {
      const res = await api.reprocessInbox(email.key)
      toast.success(`Re-ran “${email.subject || email.source}”`, {
        description: `${res.extracted} extracted, ${res.added} new on the map`,
      })
      setEmails(
        (cur) =>
          cur?.map((e) => (e.key === email.key ? { ...e, processed: true } : e)) ??
          cur,
      )
      if (res.added > 0) void refreshEvents()
    } catch (err) {
      toast.error("Reprocess failed", { description: String(err).slice(0, 140) })
    } finally {
      setBusyKey(null)
    }
  }

  if (!configured) {
    return (
      <Alert>
        <AlertTitle>Inbox isn't configured</AlertTitle>
        <AlertDescription>
          Set <span className="font-mono">SUPABASE_URL</span> and{" "}
          <span className="font-mono">SUPABASE_SECRET_KEY</span> in{" "}
          <span className="font-mono">server/.env</span> to see the inbound
          newsletter inbox here.
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Everything the email worker has banked in Supabase (30-day window).
          The poller picks new mail up automatically; re-run one to extract
          again with the current model.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={load}
          disabled={loading}
          className="shrink-0"
        >
          {loading ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          Refresh
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Couldn't reach KV</AlertTitle>
          <AlertDescription>
            {error.includes("401") || error.includes("403")
              ? "Cloudflare rejected the API token — is it still active?"
              : error}
          </AlertDescription>
        </Alert>
      )}

      {!emails && !error && (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Loading inbox…
        </div>
      )}

      {emails && emails.length === 0 && !error && (
        <p className="py-4 text-sm text-muted-foreground">
          Nothing in KV yet. Once newsletters start landing at your{" "}
          <span className="font-mono">@{inboxDomain}</span> addresses they'll
          show up here.
        </p>
      )}

      {emails && emails.length > 0 && (
        <div className="flex flex-col gap-2">
          {emails.map((e) => (
            <div
              key={e.key}
              className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
            >
              <MailIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {e.source}
                  <Badge
                    variant={e.processed ? "secondary" : "outline"}
                    className="text-[10px] font-normal"
                  >
                    {e.processed ? "processed" : "pending"}
                  </Badge>
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {e.subject || "(no subject)"}
                </span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {e.from} · {fmtWhen(e.receivedAt)} ·{" "}
                  {Math.round(e.chars / 1000)}k chars
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Reprocess ${e.subject || e.source}`}
                onClick={() => reprocess(e)}
                disabled={busyKey !== null}
              >
                {busyKey === e.key ? <Spinner /> : <RotateCcwIcon />}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d)
}
