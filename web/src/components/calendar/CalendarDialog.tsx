import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import {
  CalendarX2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { useIsMobile } from "@/hooks/useIsMobile"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import type { GcalEvent } from "@/lib/types"
import { AgendaView, AGENDA_DAYS } from "./AgendaView"
import { addDays, monthGrid, startOfDay } from "./date-utils"
import { EventDialog } from "./EventDialog"
import { InviteDialog } from "./InviteDialog"
import { MonthView } from "./MonthView"

type View = "month" | "agenda"

const MONTH_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
})
const MONTH_SHORT = new Intl.DateTimeFormat("en-US", { month: "short" })

// Popup sizing. The default is a comfortable shape for both views; users can
// drag the bottom-right grip to resize, and their choice is remembered.
const SIZE_KEY = "grapevine:calendarSize"
const DEFAULT_SIZE = { w: 960, h: 720 }
const MIN_W = 560
const MIN_H = 420
const EDGE = 24 // viewport breathing room kept around the popup

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), Math.max(lo, hi))

function loadSize(): { w: number; h: number } {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    const p = raw ? JSON.parse(raw) : null
    if (typeof p?.w === "number" && typeof p?.h === "number") {
      return { w: p.w, h: p.h }
    }
  } catch {
    // ignore malformed storage
  }
  return DEFAULT_SIZE
}

/**
 * The in-app Google Calendar: a popup previewing the signed-in user's
 * primary calendar with Month and Agenda views. Events open the edit
 * dialog (delete/invite live there); empty space starts a new one.
 */
export function CalendarDialog() {
  const open = useGrapevine((s) => s.calendarOpen)
  const setOpen = useGrapevine((s) => s.setCalendarOpen)
  const user = useGrapevine((s) => s.user)
  const calendar = useGrapevine((s) => s.calendar)
  const now = useGrapevine((s) => s.now)
  const isMobile = useIsMobile()

  const [view, setView] = useState<View>("agenda")
  const [anchor, setAnchor] = useState(() => new Date())
  const [events, setEvents] = useState<GcalEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [seq, setSeq] = useState(0) // bump to refetch after mutations

  // Edit/create/invite dialog state.
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<GcalEvent | null>(null)
  const [creatingAt, setCreatingAt] = useState<Date>(() => new Date())
  const [inviting, setInviting] = useState<GcalEvent | null>(null)

  // Resizable, viewport-clamped popup size (remembered across opens).
  const [size, setSize] = useState(loadSize)
  const [vp, setVp] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }))
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  // Mobile fills the screen; desktop uses the custom size, clamped to fit.
  const dims = useMemo(() => {
    if (isMobile) return { w: vp.w - 16, h: vp.h - 16 }
    return {
      w: clamp(size.w, MIN_W, vp.w - EDGE),
      h: clamp(size.h, MIN_H, vp.h - EDGE),
    }
  }, [isMobile, size, vp])

  const startResize = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault()
      const x0 = e.clientX
      const y0 = e.clientY
      const w0 = dims.w
      const h0 = dims.h
      let next = { w: w0, h: h0 }
      const onMove = (ev: PointerEvent) => {
        // The popup is center-anchored, so each edge moves half the cursor
        // delta — doubling it keeps the grip under the pointer.
        next = {
          w: clamp(w0 + 2 * (ev.clientX - x0), MIN_W, window.innerWidth - EDGE),
          h: clamp(h0 + 2 * (ev.clientY - y0), MIN_H, window.innerHeight - EDGE),
        }
        setSize(next)
      }
      const onUp = () => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        document.body.style.userSelect = ""
        try {
          localStorage.setItem(SIZE_KEY, JSON.stringify(next))
        } catch {
          // ignore quota/security errors
        }
      }
      document.body.style.userSelect = "none"
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
    },
    [dims],
  )

  const connected = !!user && !!calendar?.google

  const range = useMemo(() => {
    if (view === "month") {
      const cells = monthGrid(anchor)
      return { from: cells[0], to: addDays(cells[41], 1) }
    }
    const start = startOfDay(anchor)
    return { from: start, to: addDays(start, AGENDA_DAYS) }
  }, [view, anchor])

  useEffect(() => {
    if (!open || !connected) return
    let stale = false
    api
      .gcalEvents(range.from.toISOString(), range.to.toISOString())
      .then((r) => {
        if (stale) return
        setEvents(r.events)
        setError(null)
      })
      .catch((err) => {
        if (!stale) setError(String(err).slice(0, 200))
      })
    return () => {
      stale = true
    }
  }, [open, connected, range, seq])

  const refresh = useCallback(() => setSeq((s) => s + 1), [])

  const title = useMemo(() => {
    if (view === "month") return MONTH_YEAR.format(anchor)
    const last = addDays(range.from, AGENDA_DAYS - 1)
    if (range.from.getMonth() === last.getMonth()) return MONTH_YEAR.format(range.from)
    const sameYear = range.from.getFullYear() === last.getFullYear()
    return sameYear
      ? `${MONTH_SHORT.format(range.from)} – ${MONTH_SHORT.format(last)} ${last.getFullYear()}`
      : `${MONTH_SHORT.format(range.from)} ${range.from.getFullYear()} – ${MONTH_SHORT.format(last)} ${last.getFullYear()}`
  }, [view, anchor, range])

  function step(dir: 1 | -1) {
    setAnchor((a) =>
      view === "month"
        ? new Date(a.getFullYear(), a.getMonth() + dir, 1)
        : addDays(a, dir * AGENDA_DAYS),
    )
  }

  function openNew(day?: Date) {
    setEditing(null)
    setCreatingAt(day ?? new Date())
    setEditOpen(true)
  }

  function openEdit(e: GcalEvent) {
    setEditing(e)
    setEditOpen(true)
  }

  function onDeleted() {
    refresh()
    // A Grapevine-synced save may have been removed with it.
    void useGrapevine.getState().refreshCalendar()
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        style={{
          width: dims.w,
          height: dims.h,
          maxWidth: "none",
          maxHeight: "none",
        }}
        className="flex flex-col gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">Your Google Calendar</DialogTitle>
        <DialogDescription className="sr-only">
          Preview and manage your Google Calendar without leaving the map.
        </DialogDescription>

        {/* toolbar */}
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-3 pr-14">
          <Button variant="outline" size="sm" onClick={() => setAnchor(new Date())}>
            Today
          </Button>
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous"
              onClick={() => step(-1)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next"
              onClick={() => step(1)}
            >
              <ChevronRightIcon />
            </Button>
          </div>
          <h2 className="font-heading text-lg font-semibold tracking-tight">
            {title}
          </h2>
          <div className="ml-auto flex items-center gap-2">
            <Select value={view} onValueChange={(v) => setView(v as View)}>
              <SelectTrigger size="sm" className="w-28" aria-label="Calendar view">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="month">Month</SelectItem>
                  <SelectItem value="agenda">Agenda</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button size="sm" onClick={() => openNew()} disabled={!connected}>
              <PlusIcon data-icon="inline-start" />
              New event
            </Button>
          </div>
        </header>

        {/* body */}
        {!connected ? (
          <ConnectPrompt signedIn={!!user} />
        ) : error ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CalendarX2Icon />
              </EmptyMedia>
              <EmptyTitle>Couldn't reach Google Calendar</EmptyTitle>
              <EmptyDescription>{error}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" onClick={refresh}>
                Try again
              </Button>
            </EmptyContent>
          </Empty>
        ) : events === null ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : view === "month" ? (
          <MonthView
            anchor={anchor}
            events={events}
            now={now}
            onPickEvent={openEdit}
            onPickDay={openNew}
          />
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <AgendaView
              anchor={anchor}
              events={events}
              now={now}
              onPickEvent={openEdit}
            />
          </ScrollArea>
        )}

        {editOpen && (
          <EventDialog
            key={editing?.id ?? `new-${creatingAt.toISOString()}`}
            open={editOpen}
            onOpenChange={setEditOpen}
            draft={editing}
            defaultDay={creatingAt}
            onSaved={refresh}
            onDeleted={onDeleted}
            onInvite={(e) => {
              setEditOpen(false)
              setInviting(e)
            }}
          />
        )}

        {inviting && (
          <InviteDialog
            open
            onOpenChange={(o) => {
              if (!o) {
                setInviting(null)
                refresh()
              }
            }}
            event={inviting}
            onChanged={setInviting}
          />
        )}

        {/* drag-to-resize grip (desktop only) */}
        {!isMobile && (
          <div
            onPointerDown={startResize}
            title="Drag to resize"
            aria-hidden
            className="absolute right-0.5 bottom-0.5 z-30 flex size-5 cursor-nwse-resize touch-none items-end justify-end p-1 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
          >
            <svg
              viewBox="0 0 10 10"
              className="size-2.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
            >
              <path d="M9 3 3 9M9 6.5 6.5 9" />
            </svg>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ConnectPrompt({ signedIn }: { signedIn: boolean }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CalendarX2Icon />
        </EmptyMedia>
        <EmptyTitle>
          {signedIn ? "Connect Google Calendar" : "Sign in to see your calendar"}
        </EmptyTitle>
        <EmptyDescription>
          {signedIn
            ? "Grant calendar access and this popup previews your schedule — saved events sync both ways."
            : "Sign in with Google, connect your calendar, and manage your schedule without leaving the map."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {signedIn ? (
          <Button asChild size="sm">
            <a href="/auth/google/calendar">Connect Google Calendar</a>
          </Button>
        ) : (
          <Button size="sm" onClick={() => window.location.assign("/auth/google")}>
            Sign in with Google
          </Button>
        )}
      </EmptyContent>
    </Empty>
  )
}
