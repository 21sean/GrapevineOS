import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import {
  ArrowUpIcon,
  CalendarPlusIcon,
  CheckIcon,
  HistoryIcon,
  MicIcon,
  SparklesIcon,
  SquareIcon,
  SquarePenIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import {
  useAgentChat,
  type ChatItem,
  type Proposal,
} from "@/hooks/useAgentChat"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useSpeechInput } from "@/hooks/useSpeechInput"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import { timeRange } from "@/lib/time"
import {
  CATEGORY_META,
  INTEREST_TOPICS,
  type ChatThreadMeta,
  type CityEvent,
} from "@/lib/types"
import { cn } from "@/lib/utils"

const SUGGESTIONS = [
  "What's good tonight?",
  "Plan my Saturday",
  "Free stuff this weekend",
  "Live music near me",
]

/** Matches the [Title](event:id) grammar the system prompt asks for. */
const EVENT_LINK_RE = /\[([^\]]+)\]\(event:([^)\s]+)\)/g

/**
 * "Ask Grapevine" — the agent surface. One always-mounted component (the
 * transcript lives here for the session): desktop gets a floating glass
 * palette under the TopBar, phones get a bottom sheet. Event mentions render
 * as chips that select on the map; agent actions arrive as proposal cards the
 * user confirms.
 */
export function AgentChat() {
  const askOpen = useGrapevine((s) => s.askOpen)
  const setAskOpen = useGrapevine((s) => s.setAskOpen)
  const isMobile = useIsMobile()
  const chat = useAgentChat()

  // ⌘K / Ctrl+K toggles; Escape closes unless a Radix layer already ate it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        const s = useGrapevine.getState()
        s.setAskOpen(!s.askOpen)
      } else if (e.key === "Escape" && !e.defaultPrevented) {
        const s = useGrapevine.getState()
        if (s.askOpen) s.setAskOpen(false)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  if (isMobile) {
    return (
      <Sheet open={askOpen} onOpenChange={setAskOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[86svh] gap-0 rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
        >
          <div
            aria-hidden
            className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/40"
          />
          <SheetHeader className="sr-only">
            <SheetTitle>Ask Grapevine</SheetTitle>
            <SheetDescription>Chat with the local events concierge</SheetDescription>
          </SheetHeader>
          <Conversation chat={chat} className="min-h-[42svh]" />
        </SheetContent>
      </Sheet>
    )
  }

  if (!askOpen) return null
  return (
    <DesktopPalette onClose={() => setAskOpen(false)}>
      <Conversation chat={chat} />
    </DesktopPalette>
  )
}

function DesktopPalette({
  children,
  onClose,
}: {
  children: ReactNode
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Palette convention: clicking the map dismisses it — but not clicks inside
  // portaled layers the chat itself spawned (event detail sheet, admin sheet,
  // dialogs, toast Undo buttons).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null
      if (!panelRef.current || !t) return
      if (panelRef.current.contains(t)) return
      if (
        t.closest(
          '[data-slot="sheet-content"], [data-slot="dialog-content"], [data-sonner-toaster]',
        )
      )
        return
      onClose()
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [onClose])

  return (
    <div
      ref={panelRef}
      className="glass pointer-events-auto absolute top-16 left-1/2 z-30 flex w-[min(640px,92vw)] -translate-x-1/2 flex-col overflow-hidden rounded-2xl"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Close"
        onClick={onClose}
        className="absolute top-1.5 right-1.5 z-10 rounded-full text-muted-foreground"
      >
        <XIcon />
      </Button>
      {children}
    </div>
  )
}

function Conversation({
  chat,
  className,
}: {
  chat: ReturnType<typeof useAgentChat>
  className?: string
}) {
  const { items, busy, send, stop, reset, loadThread } = chat
  const user = useGrapevine((s) => s.user)
  const [input, setInput] = useState("")
  const [showHistory, setShowHistory] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // What was typed before dictation started — spoken text appends to it.
  const dictationBase = useRef("")
  const speech = useSpeechInput({
    onText: (text) => {
      const base = dictationBase.current.replace(/\s+$/, "")
      setInput(base ? `${base} ${text}` : text)
    },
    onError: (err) =>
      toast.error(
        err === "not-allowed" || err === "service-not-allowed"
          ? "Microphone access is blocked — allow it in your browser's site settings."
          : `Dictation failed (${err})`,
      ),
  })

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Follow the stream — items change on every delta, so this tracks the tail.
  // The scroll container is the Radix ScrollArea viewport, not the root.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )
    if (el) el.scrollTop = el.scrollHeight
  }, [items])

  function submit(e?: FormEvent) {
    e?.preventDefault()
    if (busy || !input.trim()) return
    speech.stop()
    setShowHistory(false)
    send(input)
    setInput("")
  }

  const lastUserText = [...items].reverse().find((i) => i.kind === "user")?.text

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <ScrollArea
        ref={listRef}
        className="flex-1 [&_[data-slot=scroll-area-viewport]]:max-h-[min(55vh,560px)] [&_[data-slot=scroll-area-viewport]]:overscroll-contain"
      >
        {showHistory ? (
          <ThreadHistory
            onPick={(id) => {
              setShowHistory(false)
              loadThread(id).catch((err) =>
                toast.error("Couldn't load that conversation", {
                  description: String(err).slice(0, 140),
                }),
              )
            }}
          />
        ) : items.length === 0 ? (
          <EmptyState onPick={(q) => send(q)} />
        ) : (
          <div className="flex flex-col gap-4 px-4 py-4">
            {items.map((item, i) => (
              <Message
                key={i}
                item={item}
                itemIdx={i}
                chat={chat}
                onRetry={lastUserText ? () => send(lastUserText) : undefined}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      <form
        onSubmit={submit}
        className={cn(
          "flex shrink-0 items-center gap-2 border-t border-border/60 py-2 pr-2",
          items.length > 0 || user ? "pl-2" : "pl-4",
        )}
      >
        {user && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={showHistory ? "Back to chat" : "Chat history"}
            title={showHistory ? "Back to chat" : "Chat history"}
            aria-pressed={showHistory}
            onClick={() => setShowHistory((v) => !v)}
            className={cn(
              "rounded-full text-muted-foreground",
              showHistory && "bg-accent text-foreground",
            )}
          >
            <HistoryIcon />
          </Button>
        )}
        {items.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="New chat"
            title="New chat"
            onClick={() => {
              setShowHistory(false)
              reset()
              inputRef.current?.focus()
            }}
            className="rounded-full text-muted-foreground"
          >
            <SquarePenIcon />
          </Button>
        )}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            speech.listening ? "Listening…" : "Ask about tonight, this weekend, a vibe…"
          }
          className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {speech.supported && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={speech.listening ? "Stop dictation" : "Speak your request"}
            title={speech.listening ? "Stop dictation" : "Speak your request"}
            aria-pressed={speech.listening}
            onClick={() => {
              if (!speech.listening) dictationBase.current = input
              speech.toggle()
              inputRef.current?.focus()
            }}
            className={cn(
              "rounded-full text-muted-foreground",
              speech.listening && "animate-pulse bg-destructive/15 text-destructive",
            )}
          >
            <MicIcon />
          </Button>
        )}
        {busy ? (
          <Button
            type="button"
            size="icon-sm"
            variant="secondary"
            aria-label="Stop"
            onClick={stop}
            className="rounded-full"
          >
            <SquareIcon className="size-3" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon-sm"
            aria-label="Send"
            disabled={!input.trim()}
            className="rounded-full"
          >
            <ArrowUpIcon />
          </Button>
        )}
      </form>
    </div>
  )
}

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  const city = useGrapevine((s) => s.settings?.city)
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
      <SparklesIcon className="size-6 text-wine" />
      <div className="space-y-1">
        <p className="font-heading text-lg font-semibold italic">Ask Grapevine</p>
        <p className="text-sm text-muted-foreground">
          Anything about what's on in {city ?? "town"} — it searches, pins the
          map, and can plan your day.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onPick(q)}
            className="rounded-full border border-border bg-secondary/40 px-3 py-1.5 text-xs transition-colors hover:bg-secondary"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  )
}

/** "2h ago" / "yesterday" — coarse, it's a history list. */
function threadAge(iso: string, now: Date): string {
  const mins = Math.round((now.getTime() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(iso))
}

/**
 * Past conversations, newest first. Server-side these are scoped to the
 * session user — nobody else's threads are listable or readable.
 */
function ThreadHistory({ onPick }: { onPick: (id: string) => void }) {
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
              {threadAge(t.updatedAt, now)}
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

function Message({
  item,
  itemIdx,
  chat,
  onRetry,
}: {
  item: ChatItem
  itemIdx: number
  chat: ReturnType<typeof useAgentChat>
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
    [...item.text.matchAll(EVENT_LINK_RE)].map((m) => m[2]),
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
          {["no-model", "ollama-down", "no-tools", "cli-missing", "cli-auth"].includes(
            n.code,
          ) && (
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

      {item.streaming && !item.text && !item.status && item.tools.length === 0 && (
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
            onState={(s) => chat.setProposalState(itemIdx, i, s)}
          />
        ) : (
          <InterestsCard
            key={i}
            proposal={p}
            onState={(s) => chat.setProposalState(itemIdx, i, s)}
          />
        ),
      )}

      {item.error && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
          <span className="min-w-0 text-destructive-foreground/90">{item.error}</span>
          {onRetry && (
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

// ---------- rich text: paragraphs, "- " bullets, **bold**, event chips ------

function RichText({ text }: { text: string }) {
  // local models sometimes double-bracket citations: [[name](url)] → [name](url)
  const cleaned = text.replace(/\[(\[[^\]]+\]\(https?:\/\/[^)\s]+\))\]/g, "$1")
  const blocks = cleaned.split(/\n+/).filter((l) => l.trim())
  return (
    <div className="space-y-1.5 text-sm leading-relaxed">
      {blocks.map((line, i) => {
        const bullet = /^\s*[-•*]\s+/.test(line)
        const content = renderInline(bullet ? line.replace(/^\s*[-•*]\s+/, "") : line)
        return bullet ? (
          <div key={i} className="flex gap-2 pl-1">
            <span className="text-muted-foreground">•</span>
            <span className="min-w-0">{content}</span>
          </div>
        ) : (
          <p key={i}>{content}</p>
        )
      })}
    </div>
  )
}

function renderInline(line: string): ReactNode[] {
  const out: ReactNode[] = []
  // event chips | web citations | bold
  const re = new RegExp(
    `${EVENT_LINK_RE.source}|\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)|\\*\\*([^*]+)\\*\\*`,
    "g",
  )
  let idx = 0
  let key = 0
  for (const m of line.matchAll(re)) {
    if (m.index! > idx) out.push(line.slice(idx, m.index))
    if (m[2]) out.push(<EventChip key={key++} id={m[2]} label={m[1]} />)
    else if (m[4])
      out.push(
        <a
          key={key++}
          href={m[4]}
          target="_blank"
          rel="noreferrer"
          className="text-wine underline underline-offset-2 hover:opacity-80"
        >
          {m[3]}
        </a>,
      )
    // Bold wins the alternation when the model writes **[Title](event:id)** —
    // recurse so links inside bold still render as chips, not raw markdown.
    // Bold content can't contain "*", so this terminates after one level.
    else out.push(<strong key={key++}>{renderInline(m[5])}</strong>)
    idx = m.index! + m[0].length
  }
  if (idx < line.length) out.push(line.slice(idx))
  return out
}

// One refresh per session covers "event landed after page load"; anything
// still unknown after that is a hallucinated id and renders as plain text.
let refreshedOnce = false

function EventChip({ id, label }: { id: string; label: string }) {
  const event = useGrapevine((s) => s.events.find((e) => e.id === id))
  const select = useGrapevine((s) => s.select)
  const tz = useGrapevine((s) => s.settings?.tz) ?? "UTC"
  // A string, not the raw clock: chips in a long transcript re-render only
  // when their printed time actually changes.
  const range = useGrapevine((s) => (event ? timeRange(event, tz, s.now) : ""))

  useEffect(() => {
    if (!event && !refreshedOnce) {
      refreshedOnce = true
      useGrapevine.getState().refreshEvents().catch(() => {})
    }
  }, [event])

  if (!event) return <span className="font-medium">{label}</span>
  return (
    <button
      type="button"
      onClick={() => select(event.id)}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-2 py-0.5 align-middle text-xs font-medium transition-colors hover:bg-secondary"
    >
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: CATEGORY_META[event.category].color }}
      />
      <span className="truncate">{event.title}</span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {range}
      </span>
    </button>
  )
}

// ---------- proposal cards --------------------------------------------------

function CalendarCard({
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
      window.location.assign("/auth/google")
      return
    }
    setBusy(true)
    try {
      let last
      for (const e of list) last = await api.calendarAdd(e.id)
      if (last) setCalendar(last)
      onState("saved")
      toast.success(
        `Saved ${list.length} event${list.length === 1 ? "" : "s"} to your calendar`,
        {
          description: last?.warning
            ? "Google Calendar didn't sync — they're still in your Grapevine feed"
            : undefined,
          action: { label: "Undo", onClick: undo },
        },
      )
    } catch (err) {
      toast.error("Calendar save failed", { description: String(err).slice(0, 140) })
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
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={undo}>
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
            {user
              ? `Save all (${list.length})`
              : "Sign in to save"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onState("dismissed")}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  )
}

function InterestsCard({
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
        ...interests.loves.filter((t) => !removeLoves.includes(t) && !addAvoids.includes(t)),
        ...addLoves,
      ]),
    ]
    const avoids = [
      ...new Set([
        ...interests.avoids.filter((t) => !removeAvoids.includes(t) && !addLoves.includes(t)),
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
        <span className="text-xs text-muted-foreground italic">{proposal.reason}</span>
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
          <Button variant="ghost" size="sm" onClick={() => onState("dismissed")}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  )
}
