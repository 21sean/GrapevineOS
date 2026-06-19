import { useCallback, useRef, useState } from "react"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import type { AgentFrame } from "@/lib/types"

/**
 * Owns one session's "Ask Grapevine" transcript for display. Conversation
 * memory lives server-side in the LangGraph checkpointer, keyed by the
 * threadId this hook mints per mount — each send ships only the new message.
 * Signed-in users additionally get their exchanges persisted server-side
 * (chat_threads/chat_messages, ownership-checked); loadThread pulls one of
 * those back into the transcript and resumes it under the same threadId.
 */

export interface ToolRun {
  label: string
  done: boolean
  detail?: string
}

export type Proposal =
  | { kind: "calendar"; eventIds: string[]; note?: string; state: "pending" | "saved" | "dismissed" }
  | {
      kind: "interests"
      addLoves: string[]
      addAvoids: string[]
      removeLoves: string[]
      removeAvoids: string[]
      reason: string
      state: "pending" | "applied" | "dismissed"
    }

export interface Notice {
  code: string
  message: string
}

export type ChatItem =
  | { kind: "user"; text: string }
  | {
      kind: "assistant"
      text: string
      streaming: boolean
      status?: string
      tools: ToolRun[]
      proposals: Proposal[]
      notices: Notice[]
      /** ids the agent pinned on the map this turn (chip-row fallback) */
      highlights: string[]
      error?: string
    }

type AssistantItem = Extract<ChatItem, { kind: "assistant" }>

export function useAgentChat() {
  const [items, setItems] = useState<ChatItem[]>([])
  // Ref mirror so callbacks can read the transcript synchronously without
  // side-effecting inside a state updater (StrictMode double-invokes those).
  const itemsRef = useRef<ChatItem[]>(items)
  const abortRef = useRef<AbortController | null>(null)
  // One server-side conversation per mount; the checkpointer replays history.
  const threadIdRef = useRef<string>(crypto.randomUUID())

  const update = useCallback((fn: (prev: ChatItem[]) => ChatItem[]) => {
    itemsRef.current = fn(itemsRef.current)
    setItems(itemsRef.current)
  }, [])

  /** Immutably patch the trailing assistant item (the one streaming). */
  const patchLast = useCallback(
    (fn: (item: AssistantItem) => Partial<AssistantItem>) => {
      update((prev) => {
        const last = prev[prev.length - 1]
        if (last?.kind !== "assistant") return prev
        return [...prev.slice(0, -1), { ...last, ...fn(last) }]
      })
    },
    [update],
  )

  const onFrame = useCallback(
    (frame: AgentFrame) => {
      switch (frame.type) {
        case "status":
          patchLast(() => ({ status: frame.label }))
          break
        case "delta":
          patchLast((it) => ({ text: it.text + frame.text, status: undefined }))
          break
        case "replace":
          // Guardrails swapped the partial reply for a canned one — drop
          // whatever streamed so far.
          patchLast(() => ({ text: frame.text, status: undefined }))
          break
        case "tool":
          patchLast((it) => {
            if (frame.state === "start") {
              return { tools: [...it.tools, { label: frame.label, done: false }], status: undefined }
            }
            // mark the most recent un-done run with this label finished
            const tools = [...it.tools]
            for (let i = tools.length - 1; i >= 0; i--) {
              if (tools[i].label === frame.label && !tools[i].done) {
                tools[i] = { ...tools[i], done: true, detail: frame.detail }
                break
              }
            }
            return { tools }
          })
          break
        case "action": {
          const a = frame.action
          if (a.kind === "highlight") {
            useGrapevine.getState().setAgentHighlight(a.eventIds, a.fit ?? true)
            patchLast((it) => ({
              highlights: [...new Set([...it.highlights, ...a.eventIds])],
            }))
          } else if (a.kind === "proposeCalendar") {
            patchLast((it) => ({
              proposals: [
                ...it.proposals,
                { kind: "calendar", eventIds: a.eventIds, note: a.note, state: "pending" },
              ],
            }))
          } else if (a.kind === "proposeInterests") {
            patchLast((it) => ({
              proposals: [
                ...it.proposals,
                { ...a, kind: "interests" as const, state: "pending" as const },
              ],
            }))
          } else if (a.kind === "eventPatched") {
            // Server already committed the edit (e.g. set_rarity) — swap the
            // fresh copy in so badges and filters reflect it immediately.
            useGrapevine.getState().upsertEvent(a.event)
          }
          break
        }
        case "notice":
          patchLast((it) => ({
            notices: [...it.notices, { code: frame.code, message: frame.message }],
          }))
          break
        case "error":
          patchLast(() => ({ error: frame.message, streaming: false, status: undefined }))
          break
        case "done":
          // Adopt the server's threadId (it mints one when ours is missing).
          if (frame.threadId) threadIdRef.current = frame.threadId
          patchLast(() => ({ streaming: false, status: undefined }))
          break
      }
    },
    [patchLast],
  )

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return

      update((prev) => [
        ...prev,
        { kind: "user", text: trimmed },
        {
          kind: "assistant",
          text: "",
          streaming: true,
          tools: [],
          proposals: [],
          notices: [],
          highlights: [],
        },
      ])

      const s = useGrapevine.getState()
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      api
        .agentChat(
          {
            threadId: threadIdRef.current,
            message: trimmed,
            context: {
              ...(s.userPos && { userPos: s.userPos }),
              interests: s.interests,
              savedEventIds: s.calendar?.synced ?? [],
              signedIn: !!s.user,
            },
          },
          onFrame,
          ac.signal,
        )
        .catch((err) => {
          if (ac.signal.aborted) {
            patchLast(() => ({ streaming: false, status: undefined }))
          } else {
            patchLast(() => ({
              error: String(err?.message ?? err).slice(0, 300),
              streaming: false,
              status: undefined,
            }))
          }
        })
    },
    [onFrame, patchLast, update],
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  /** Start over: abort any stream, drop the transcript, mint a fresh thread. */
  const reset = useCallback(() => {
    abortRef.current?.abort()
    threadIdRef.current = crypto.randomUUID()
    itemsRef.current = []
    setItems([])
    useGrapevine.getState().clearAgentHighlight()
  }, [])

  /** Resume a persisted conversation: replace the transcript and adopt its id. */
  const loadThread = useCallback(async (id: string) => {
    const detail = await api.chatThread(id)
    abortRef.current?.abort()
    threadIdRef.current = detail.id
    const loaded: ChatItem[] = detail.messages.map((m) =>
      m.role === "user"
        ? { kind: "user", text: m.content }
        : {
            kind: "assistant",
            text: m.content,
            streaming: false,
            tools: [],
            proposals: [],
            notices: [],
            highlights: [],
          },
    )
    itemsRef.current = loaded
    setItems(loaded)
    useGrapevine.getState().clearAgentHighlight()
  }, [])

  /** Cards report back what the user decided so they render one-shot. */
  const setProposalState = useCallback(
    (itemIdx: number, proposalIdx: number, state: Proposal["state"]) => {
      update((prev) =>
        prev.map((item, i) => {
          if (i !== itemIdx || item.kind !== "assistant") return item
          return {
            ...item,
            proposals: item.proposals.map((p, j) =>
              j === proposalIdx ? ({ ...p, state } as Proposal) : p,
            ),
          }
        }),
      )
    },
    [update],
  )

  const last = items[items.length - 1]
  const busy = last?.kind === "assistant" && last.streaming

  return { items, busy, send, stop, reset, loadThread, setProposalState }
}
