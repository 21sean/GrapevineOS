import { useState } from "react"
import { CalendarIcon, CheckIcon, CopyIcon, UnplugIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { SectionHeader } from "@/components/account/SectionHeader"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import { connectGoogleCalendar } from "@/lib/supabase"

/**
 * "Calendar sync" — the Google connect/disconnect row plus the Apple webcal
 * feed, as a section of the account dialog. `onOpenCalendar` hands off to the
 * full calendar dialog (closing this one first).
 */
export function CalendarSync({
  onOpenCalendar,
}: {
  onOpenCalendar: () => void
}) {
  const calendar = useGrapevine((s) => s.calendar)
  const setCalendar = useGrapevine((s) => s.setCalendar)
  const [disconnecting, setDisconnecting] = useState(false)
  const [copied, setCopied] = useState(false)

  // Apple Calendar subscribes via the webcal scheme; same feed, same URL.
  const webcal = calendar?.feedUrl?.replace(/^https?:/, "webcal:")

  async function copyFeed() {
    if (!webcal) return
    try {
      await navigator.clipboard.writeText(webcal)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Couldn't copy — feed link: " + webcal)
    }
  }

  async function disconnectGoogle() {
    setDisconnecting(true)
    try {
      setCalendar(await api.calendarDisconnect())
      toast.success("Google Calendar disconnected", {
        description: "Events already synced stay on your calendar.",
      })
    } catch (err) {
      toast.error("Couldn't disconnect", {
        description: String(err).slice(0, 140),
      })
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <section>
      <SectionHeader
        icon={<CalendarIcon className="size-3.5" />}
        title="Calendar sync"
        action={
          calendar?.google ? (
            <Button
              variant="ghost"
              size="sm"
              className="-my-1 h-7 text-xs"
              onClick={onOpenCalendar}
            >
              Open calendar
            </Button>
          ) : calendar && calendar.synced.length > 0 ? (
            <span className="font-mono text-xs text-muted-foreground">
              {calendar.synced.length}
            </span>
          ) : undefined
        }
      />
      <div className="mt-2 flex flex-col gap-2">
        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
          <span className="flex items-center gap-2 text-[13px] font-medium">
            Google Calendar
            {calendar?.google && (
              <Badge variant="outline" className="border-live/50 text-live">
                connected
              </Badge>
            )}
          </span>
          {calendar?.google ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={disconnectGoogle}
              disabled={disconnecting}
            >
              {disconnecting ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <UnplugIcon data-icon="inline-start" />
              )}
              Disconnect
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="h-7 text-xs"
              onClick={() =>
                connectGoogleCalendar().catch((err) =>
                  toast.error("Couldn't start the Google consent", {
                    description: String(
                      err instanceof Error ? err.message : err
                    ).slice(0, 140),
                  })
                )
              }
            >
              Connect
            </Button>
          )}
        </div>
        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
          <span className="text-[13px] font-medium">Apple Calendar</span>
          <Button
            variant="secondary"
            size="sm"
            className="h-7 text-xs"
            onClick={copyFeed}
            disabled={!webcal}
          >
            {copied ? (
              <CheckIcon data-icon="inline-start" />
            ) : (
              <CopyIcon data-icon="inline-start" />
            )}
            {copied ? "Copied" : "Copy feed link"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Saved events sync straight to Google Calendar once connected. Apple
          doesn't allow direct writes, so subscribe to your feed instead
          (Calendar → File → New Calendar Subscription) — adds and removals
          follow automatically. Any event also downloads as a .ics file.
        </p>
      </div>
    </section>
  )
}
