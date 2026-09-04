import { useState, type FormEvent } from "react"
import { CheckIcon, LinkIcon, MailIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api } from "@/lib/api"
import type { GcalAttendee, GcalEvent } from "@/lib/types"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** "Add to Google Calendar" template link — works for anyone, no invite needed. */
function shareLink(e: GcalEvent): string {
  const fmt = (value: string) =>
    e.allDay
      ? value.slice(0, 10).replaceAll("-", "")
      : new Date(value).toISOString().replace(/[-:]|\.\d{3}/g, "")
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: `${fmt(e.start)}/${fmt(e.end)}`,
    ...(e.description && { details: e.description }),
    ...(e.location && { location: e.location }),
  })
  return `https://calendar.google.com/calendar/render?${params}`
}

const STATUS_META: Record<string, { label: string; className?: string }> = {
  accepted: { label: "Going", className: "border-live/50 text-live" },
  declined: {
    label: "Declined",
    className: "border-destructive/50 text-destructive",
  },
  tentative: { label: "Maybe" },
  needsAction: { label: "Invited" },
}

/**
 * Invite people to a Google Calendar event: shareable link, email invites
 * (Google sends the real invitation mail), guest management, and an
 * edit/view-only toggle that maps onto `guestsCanModify`.
 */
export function InviteDialog({
  open,
  onOpenChange,
  event,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  event: GcalEvent
  onChanged: (e: GcalEvent) => void
}) {
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const link = shareLink(event)

  async function patchAttendees(
    attendees: GcalAttendee[],
    success: string
  ): Promise<void> {
    setBusy(true)
    try {
      const updated = await api.gcalUpdate(event.id, {
        attendees: attendees.map((a) => ({
          email: a.email,
          ...(a.displayName && { displayName: a.displayName }),
          ...(a.responseStatus !== "needsAction" && {
            responseStatus: a.responseStatus,
          }),
        })),
      })
      onChanged(updated)
      toast.success(success)
    } catch (err) {
      toast.error("Google Calendar said no", {
        description: String(err).slice(0, 160),
      })
    } finally {
      setBusy(false)
    }
  }

  function invite(e?: FormEvent) {
    e?.preventDefault()
    const addr = email.trim().toLowerCase()
    if (!EMAIL_RE.test(addr)) {
      toast.error("That doesn't look like an email address")
      return
    }
    if (event.attendees.some((a) => a.email.toLowerCase() === addr)) {
      toast.error("Already on the guest list")
      return
    }
    setEmail("")
    void patchAttendees(
      [
        ...event.attendees,
        {
          email: addr,
          responseStatus: "needsAction",
          organizer: false,
          self: false,
        },
      ],
      `Invite sent to ${addr}`
    )
  }

  async function setMode(mode: string) {
    const guestsCanModify = mode === "edit"
    if (guestsCanModify === event.guestsCanModify) return
    setBusy(true)
    try {
      onChanged(await api.gcalUpdate(event.id, { guestsCanModify }))
      toast.success(
        guestsCanModify
          ? "Guests can now edit this event"
          : "Guests can view only"
      )
    } catch (err) {
      toast.error("Couldn't change sharing", {
        description: String(err).slice(0, 160),
      })
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Couldn't copy — link: " + link)
    }
  }

  const canManage = event.canEdit

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="items-center">
          <DialogTitle className="font-heading text-xl font-semibold">
            Invite people
          </DialogTitle>
          <DialogDescription className="truncate text-center">
            {event.title}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Tabs
            value={event.guestsCanModify ? "edit" : "view"}
            onValueChange={setMode}
          >
            <TabsList className="w-full">
              <TabsTrigger
                value="edit"
                className="flex-1"
                disabled={!canManage || busy}
              >
                Can edit
              </TabsTrigger>
              <TabsTrigger
                value="view"
                className="flex-1"
                disabled={!canManage || busy}
              >
                View only
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <InputGroup>
            <InputGroupAddon>
              <LinkIcon />
            </InputGroupAddon>
            <InputGroupInput
              readOnly
              value={link}
              className="font-mono text-xs"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="sm" variant="secondary" onClick={copy}>
                {copied ? <CheckIcon data-icon="inline-start" /> : null}
                {copied ? "Copied" : "Copy link"}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>

          <form onSubmit={invite}>
            <InputGroup>
              <InputGroupAddon>
                <MailIcon />
              </InputGroupAddon>
              <InputGroupInput
                type="email"
                placeholder="Invite by email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={!canManage || busy}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  type="submit"
                  size="sm"
                  disabled={!canManage || busy || !email.trim()}
                >
                  {busy ? <Spinner data-icon="inline-start" /> : null}
                  Invite
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>

          {event.attendees.length > 0 ? (
            <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border">
              {event.attendees.map((a) => (
                <GuestRow
                  key={a.email}
                  attendee={a}
                  canRemove={canManage && !a.organizer && !busy}
                  onRemove={() =>
                    void patchAttendees(
                      event.attendees.filter((x) => x.email !== a.email),
                      `Removed ${a.email}`
                    )
                  }
                />
              ))}
            </div>
          ) : (
            <p className="text-center text-xs text-muted-foreground">
              No guests yet — invite someone by email, and Google Calendar sends
              them the invitation.
            </p>
          )}

          {!canManage && (
            <p className="text-xs text-muted-foreground">
              Only the event's organizer can invite guests or change sharing.
              The link above still works for adding this event to any calendar.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function GuestRow({
  attendee,
  canRemove,
  onRemove,
}: {
  attendee: GcalAttendee
  canRemove: boolean
  onRemove: () => void
}) {
  const name = attendee.displayName || attendee.email
  const status = attendee.organizer
    ? { label: "Organizer", className: undefined }
    : (STATUS_META[attendee.responseStatus] ?? STATUS_META.needsAction)
  return (
    <div className="flex items-center gap-2.5 px-3 py-2">
      <Avatar className="size-7">
        <AvatarFallback className="text-[10px] uppercase">
          {name.slice(0, 2)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{name}</p>
        {attendee.displayName && (
          <p className="truncate text-xs text-muted-foreground">
            {attendee.email}
          </p>
        )}
      </div>
      <Badge variant="outline" className={status.className}>
        {status.label}
      </Badge>
      {canRemove && (
        <button
          type="button"
          aria-label={`Remove ${attendee.email}`}
          onClick={onRemove}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  )
}
