import { useMemo, useState } from "react"
import { CalendarIcon, Trash2Icon, UserPlusIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import {
  asEtiquette,
  ETIQUETTE_COLORS,
  ETIQUETTE_META,
  type Etiquette,
  type GcalEvent,
  type GcalEventPatch,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { addDays, parseGcal, startOfDay, ymd } from "./date-utils"

/** "HH:MM" quarter-hour steps for the time selects. */
const TIME_OPTIONS = Array.from({ length: 96 }, (_, i) => {
  const h = Math.floor(i / 4)
  const m = (i % 4) * 15
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
})

function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number)
  const ap = h < 12 ? "AM" : "PM"
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ap}`
}

/** Round up to the next quarter hour, as "HH:MM". */
function nextQuarter(d: Date): string {
  const mins = Math.ceil((d.getHours() * 60 + d.getMinutes()) / 15) * 15
  const clamped = Math.min(mins, 23 * 60 + 45)
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

function atTime(day: Date, time: string): Date {
  const [h, m] = time.split(":").map(Number)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m)
}

const fmtDay = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
})

/**
 * Create/edit an event on the user's Google Calendar. `draft` null means
 * "new event" starting on `defaultDay`. Mount with a fresh `key` per event
 * so state re-initializes.
 */
export function EventDialog({
  open,
  onOpenChange,
  draft,
  defaultDay,
  onSaved,
  onDeleted,
  onInvite,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  draft: GcalEvent | null
  defaultDay?: Date
  onSaved: (e: GcalEvent) => void
  onDeleted: () => void
  onInvite: (e: GcalEvent) => void
}) {
  const [title, setTitle] = useState(draft?.title ?? "")
  const [description, setDescription] = useState(draft?.description ?? "")
  const [location, setLocation] = useState(draft?.location ?? "")
  const [allDay, setAllDay] = useState(draft?.allDay ?? false)
  const [color, setColor] = useState<Etiquette>(
    draft ? asEtiquette(draft.color) : "sky",
  )
  const [startDay, setStartDay] = useState<Date>(() =>
    draft ? startOfDay(parseGcal(draft.start)) : startOfDay(defaultDay ?? new Date()),
  )
  const [endDay, setEndDay] = useState<Date>(() => {
    if (!draft) return startOfDay(defaultDay ?? new Date())
    // Google's all-day end is exclusive; show the inclusive last day.
    const end = parseGcal(draft.end)
    return startOfDay(draft.allDay ? addDays(end, -1) : end)
  })
  const [startTime, setStartTime] = useState(() =>
    draft && !draft.allDay ? hhmm(parseGcal(draft.start)) : nextQuarter(new Date()),
  )
  const [endTime, setEndTime] = useState(() => {
    if (draft && !draft.allDay) return hhmm(parseGcal(draft.end))
    const t = nextQuarter(new Date())
    const [h, m] = t.split(":").map(Number)
    return h >= 23 ? "23:45" : `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`
  })
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const readOnly = !!draft && !draft.canEdit

  const invalid = useMemo(() => {
    if (allDay) return endDay.getTime() < startDay.getTime()
    return atTime(endDay, endTime) <= atTime(startDay, startTime)
  }, [allDay, startDay, endDay, startTime, endTime])

  async function save() {
    if (busy || invalid || readOnly) return
    const patch: GcalEventPatch = {
      title: title.trim() || "(no title)",
      description,
      location,
      allDay,
      color,
      ...(allDay
        ? { start: ymd(startDay), end: ymd(addDays(endDay, 1)) }
        : {
            start: atTime(startDay, startTime).toISOString(),
            end: atTime(endDay, endTime).toISOString(),
          }),
    }
    setBusy(true)
    try {
      const saved = draft
        ? await api.gcalUpdate(draft.id, patch)
        : await api.gcalCreate(patch)
      onSaved(saved)
      onOpenChange(false)
      toast.success(draft ? "Event updated" : "Event added to Google Calendar")
    } catch (err) {
      toast.error("Google Calendar said no", {
        description: String(err).slice(0, 160),
      })
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!draft || deleting) return
    setDeleting(true)
    try {
      await api.gcalDelete(draft.id)
      onDeleted()
      onOpenChange(false)
      toast.success("Removed from Google Calendar")
    } catch (err) {
      toast.error("Couldn't remove the event", {
        description: String(err).slice(0, 160),
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading text-xl font-semibold">
            {draft ? "Edit Event" : "New Event"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {draft ? "Edit this Google Calendar event" : "Create a Google Calendar event"}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="ev-title">Title</FieldLabel>
            <Input
              id="ev-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What's happening?"
              disabled={readOnly}
              autoFocus
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="ev-desc">Description</FieldLabel>
            <Textarea
              id="ev-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              disabled={readOnly}
            />
          </Field>

          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field>
              <FieldLabel>Start Date</FieldLabel>
              <DayPickerField
                value={startDay}
                disabled={readOnly}
                onChange={(d) => {
                  setStartDay(d)
                  if (d.getTime() > endDay.getTime()) setEndDay(d)
                }}
              />
            </Field>
            {!allDay && (
              <Field>
                <FieldLabel>Start Time</FieldLabel>
                <TimeSelect value={startTime} onChange={setStartTime} disabled={readOnly} />
              </Field>
            )}
          </div>

          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field data-invalid={invalid || undefined}>
              <FieldLabel>End Date</FieldLabel>
              <DayPickerField value={endDay} onChange={setEndDay} disabled={readOnly} />
            </Field>
            {!allDay && (
              <Field data-invalid={invalid || undefined}>
                <FieldLabel>End Time</FieldLabel>
                <TimeSelect value={endTime} onChange={setEndTime} disabled={readOnly} />
              </Field>
            )}
          </div>
          {invalid && (
            <FieldDescription className="text-destructive">
              The event has to end after it starts.
            </FieldDescription>
          )}

          <div className="flex items-center gap-2">
            <Checkbox
              id="ev-allday"
              checked={allDay}
              onCheckedChange={(v) => setAllDay(v === true)}
              disabled={readOnly}
            />
            <Label htmlFor="ev-allday" className="text-sm font-normal">
              All day
            </Label>
          </div>

          <Field>
            <FieldLabel htmlFor="ev-location">Location</FieldLabel>
            <Input
              id="ev-location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              disabled={readOnly}
            />
          </Field>

          <Field>
            <FieldLabel>Etiquette</FieldLabel>
            <div className="flex gap-2.5">
              {ETIQUETTE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  aria-pressed={color === c}
                  disabled={readOnly}
                  onClick={() => setColor(c)}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full border-2 transition-transform hover:scale-110 disabled:pointer-events-none",
                    ETIQUETTE_META[c].swatch,
                  )}
                >
                  {color === c && (
                    <span className={cn("size-3 rounded-full", ETIQUETTE_META[c].dot)} />
                  )}
                </button>
              ))}
            </div>
          </Field>

          {draft?.grapevineEventId && (
            <FieldDescription>
              Saved from Grapevine — removing it here also un-saves it on the map.
            </FieldDescription>
          )}
          {readOnly && (
            <FieldDescription>
              You're a guest on this event, so only the organizer can edit it.
              You can still remove it from your calendar.
            </FieldDescription>
          )}
        </FieldGroup>

        <DialogFooter className="sm:justify-between">
          <div className="flex gap-1">
            {draft && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Delete event"
                  onClick={remove}
                  disabled={deleting}
                  className="text-muted-foreground hover:text-destructive"
                >
                  {deleting ? <Spinner /> : <Trash2Icon />}
                </Button>
                <Button
                  variant="ghost"
                  aria-label="Invite people"
                  onClick={() => onInvite(draft)}
                >
                  <UserPlusIcon data-icon="inline-start" />
                  Invite
                </Button>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy || invalid || readOnly}>
              {busy && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DayPickerField({
  value,
  onChange,
  disabled,
}: {
  value: Date
  onChange: (d: Date) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className="justify-between font-normal"
        >
          {fmtDay.format(value)}
          <CalendarIcon data-icon="inline-end" className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          defaultMonth={value}
          onSelect={(d) => {
            if (d) onChange(startOfDay(d))
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function TimeSelect({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  // An off-grid time (e.g. 9:05 from Google) still needs to render.
  const options = TIME_OPTIONS.includes(value)
    ? TIME_OPTIONS
    : [value, ...TIME_OPTIONS]
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-[7.5rem]">
        <SelectValue>{timeLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((t) => (
            <SelectItem key={t} value={t}>
              {timeLabel(t)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
