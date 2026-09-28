import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import {
  ArrowUpIcon,
  CheckIcon,
  HistoryIcon,
  MicIcon,
  SparklesIcon,
  SquareIcon,
  SquarePenIcon,
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { CapabilitiesPopover } from "@/components/chat/Capabilities"
import { EventChip } from "@/components/chat/EventChip"
import { ModelEffortPicker } from "@/components/chat/ModelEffortPicker"
import { CalendarCard, InterestsCard } from "@/components/chat/ProposalCards"
import { WatchCard } from "@/components/chat/WatchCard"
import { EVENT_LINK_RE, RichText } from "@/components/chat/RichText"
import { ThreadHistory } from "@/components/chat/ThreadHistory"
import { useAgentChat, type ChatItem } from "@/hooks/useAgentChat"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useSpeechInput } from "@/hooks/useSpeechInput"
import { modelLabel } from "@/lib/chatModels"
import { useGrapevine } from "@/lib/store"
import type { ChatUsage } from "@/lib/types"
import { cn } from "@/lib/utils"

const SUGGESTIONS = [
  "What's good tonight?",
  "Plan my Saturday",
  "Free stuff this weekend",
  "Live music near me",
]

/**
 * Label for an icon-only control, in the app's tooltip rather than the
 * browser's.
 *
 * The chat was the one surface still using the native `title` attribute:
 * half its buttons carried only an aria-label and so showed nothing at all
 * on hover, and the ones that did have a `title` waited out the OS delay and
 * then rendered an opaque system box over the glass. TopBar has used the
 * Radix tooltip since it was written; this is the same thing, so the two
 * surfaces behave identically.
 */
function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * "Ask Grapevine": the agent surface. One always-mounted component (the
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
            <SheetDescription>
              Chat with the local events concierge
            </SheetDescription>
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

  // Palette convention: clicking the map dismisses it, but not clicks inside
  // portaled layers the chat itself spawned (event detail sheet, admin sheet,
  // dialogs, toast Undo buttons).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null
      if (!panelRef.current || !t) return
      if (panelRef.current.contains(t)) return
      if (
        t.closest(
          '[data-slot="sheet-content"], [data-slot="dialog-content"], [data-slot="popover-content"], [data-sonner-toaster]'
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
      <Hint label="Close (Esc)">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          onClick={onClose}
          className="absolute top-1.5 right-1.5 z-10 rounded-full text-muted-foreground"
        >
          <XIcon />
        </Button>
      </Hint>
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
  const chatProvider = useGrapevine((s) => s.settings?.chatProvider)
  // Draft lives in the persisted store, not local state, so clicking away from
  // the chat (which unmounts this component) doesn't discard a half-typed line.
  const input = useGrapevine((s) => s.chatDraft)
  const setInput = useGrapevine((s) => s.setChatDraft)
  const [showHistory, setShowHistory] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // What was typed before dictation started; spoken text appends to it.
  const dictationBase = useRef("")
  const speech = useSpeechInput({
    onText: (text) => {
      const base = dictationBase.current.replace(/\s+$/, "")
      setInput(base ? `${base} ${text}` : text)
    },
    onError: (err) =>
      toast.error(
        err === "not-allowed" || err === "service-not-allowed"
          ? "Microphone access is blocked. Allow it in your browser's site settings."
          : `Dictation failed (${err})`
      ),
  })

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // The scroll container is the Radix ScrollArea viewport, not the root.
  const viewport = useCallback(
    () =>
      listRef.current?.querySelector<HTMLElement>(
        '[data-slot="scroll-area-viewport"]'
      ) ?? null,
    []
  )

  // Follow the stream, but only while the reader is at the tail. A reply that
  // yanks the view back down every time a token lands makes scrolling up to
  // re-read the previous answer impossible.
  const pinned = useRef(true)
  useEffect(() => {
    const el = viewport()
    if (!el) return
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [viewport])

  useEffect(() => {
    const el = viewport()
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [items, viewport])

  /** Asking something new always jumps to the answer. */
  const ask = useCallback(
    (text: string) => {
      pinned.current = true
      send(text)
    },
    [send]
  )

  function submit(e?: FormEvent) {
    e?.preventDefault()
    if (busy || !input.trim()) return
    speech.stop()
    setShowHistory(false)
    ask(input)
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
                })
              )
            }}
          />
        ) : items.length === 0 ? (
          <EmptyState onPick={ask} />
        ) : (
          <div className="flex flex-col gap-4 px-4 py-4">
            {items.map((item, i) => (
              <Message
                key={i}
                item={item}
                itemIdx={i}
                chat={chat}
                onRetry={lastUserText ? () => ask(lastUserText) : undefined}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      {chatProvider === "claude" && (
        <div className="flex shrink-0 items-center border-t border-border/60 px-2 pt-1.5">
          <ModelEffortPicker />
        </div>
      )}

      <form
        onSubmit={submit}
        className={cn(
          "flex shrink-0 items-center gap-2 py-2 pr-2",
          // The picker row already draws the top divider when it's shown.
          chatProvider === "claude" ? "" : "border-t border-border/60",
          "pl-2"
        )}
      >
        <CapabilitiesPopover />
        {user && (
          <Hint label={showHistory ? "Back to chat" : "Chat history"}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={showHistory ? "Back to chat" : "Chat history"}
              aria-pressed={showHistory}
              onClick={() => setShowHistory((v) => !v)}
              className={cn(
                "rounded-full text-muted-foreground",
                showHistory && "bg-accent text-foreground"
              )}
            >
              <HistoryIcon />
            </Button>
          </Hint>
        )}
        {items.length > 0 && (
          <Hint label="New chat">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="New chat"
              onClick={() => {
                setShowHistory(false)
                reset()
                inputRef.current?.focus()
              }}
              className="rounded-full text-muted-foreground"
            >
              <SquarePenIcon />
            </Button>
          </Hint>
        )}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            speech.listening
              ? "Listening…"
              : "Ask about tonight, this weekend, a vibe…"
          }
          className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {speech.supported && (
          <Hint
            label={speech.listening ? "Stop dictation" : "Speak your request"}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={
                speech.listening ? "Stop dictation" : "Speak your request"
              }
              aria-pressed={speech.listening}
              onClick={() => {
                if (!speech.listening) dictationBase.current = input
                speech.toggle()
                inputRef.current?.focus()
              }}
              className={cn(
                "rounded-full text-muted-foreground",
                speech.listening &&
                  "animate-pulse bg-destructive/15 text-destructive"
              )}
            >
              <MicIcon />
            </Button>
          </Hint>
        )}
        {busy ? (
          <Hint label="Stop generating">
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
          </Hint>
        ) : (
          <Hint label="Send (Enter)">
            <Button
              type="submit"
              size="icon-sm"
              aria-label="Send"
              disabled={!input.trim()}
              className="rounded-full"
            >
              <ArrowUpIcon />
            </Button>
          </Hint>
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
        <p className="font-heading text-lg font-semibold italic">
          Ask Grapevine
        </p>
        <p className="text-sm text-muted-foreground">
          Anything about what's on in {city ?? "town"}: it searches, pins the
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
    [...item.text.matchAll(EVENT_LINK_RE)].map((m) => m[2])
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
          {[
            "no-model",
            "ollama-down",
            "no-tools",
            "cli-missing",
            "cli-auth",
          ].includes(n.code) && (
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

      {item.streaming &&
        !item.text &&
        !item.status &&
        item.tools.length === 0 && (
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
        ) : p.kind === "watch" ? (
          <WatchCard
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
        )
      )}

      {item.usage && !item.streaming && <UsageLine usage={item.usage} />}

      {item.error && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
          <span className="text-destructive-foreground/90 min-w-0">
            {item.error}
          </span>
          {onRetry && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onRetry}
            >
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

/** Per-turn token/cost footer under a Claude Code reply. The input figure
 *  counts everything the turn read, cache included; the raw uncached count
 *  reads as single digits next to a real cost. */
function UsageLine({ usage }: { usage: ChatUsage }) {
  const parts: string[] = []
  if (usage.model) parts.push(modelLabel(usage.model).replace(/^claude-/i, ""))
  parts.push(`${fmtTokens(usage.inputTokens)} in`)
  parts.push(`${fmtTokens(usage.outputTokens)} out`)
  if (typeof usage.costUSD === "number" && usage.costUSD > 0) {
    parts.push(`$${usage.costUSD.toFixed(usage.costUSD < 0.1 ? 3 : 2)}`)
  }
  const cached = usage.cacheReadInputTokens ?? 0
  return (
    <Hint
      label={
        cached
          ? `This turn read ${fmtTokens(usage.inputTokens)} input tokens, ${fmtTokens(cached)} of them from cache`
          : "This turn's token usage"
      }
    >
      {/* tabIndex so the explanation is reachable without a pointer; this is
          the only place the cache split is written down. */}
      <div
        tabIndex={0}
        className="font-mono text-[10px] text-muted-foreground/70"
      >
        {parts.join(" · ")}
      </div>
    </Hint>
  )
}
