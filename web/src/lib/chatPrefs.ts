import { create } from "zustand"
import { CHAT_EFFORT_LEVELS, type ChatEffort } from "@/lib/types"

/**
 * Client-side "Ask Grapevine" composer preferences, persisted to localStorage
 * so they survive reloads and — crucially — outlive the chat panel unmounting
 * when the user clicks away from it.
 *
 *  - model / effort: per-turn overrides for the Claude Code CLI provider (sent
 *    with every /api/agent/chat call; the server ignores them for the other
 *    providers). Empty string = let the CLI use its own default.
 *  - draft: the unsent composer text, saved so closing and reopening the chat
 *    doesn't lose a half-typed message.
 */

/** Explicit model ids (not the CLI's short aliases — those have been observed
 *  to route "opus" to Haiku on some accounts, silently downgrading the call).
 *  "" = the CLI's own default (honours the user's `/model` choice). */
export const CLAUDE_CHAT_MODELS = [
  { value: "", label: "Default" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-opus-4-8", label: "Opus 4.8" },
] as const

export const CHAT_EFFORT_OPTIONS: { value: "" | ChatEffort; label: string }[] = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
]

export function modelLabel(value: string): string {
  return CLAUDE_CHAT_MODELS.find((m) => m.value === value)?.label ?? value
}

export function effortLabel(value: string): string {
  return CHAT_EFFORT_OPTIONS.find((e) => e.value === value)?.label ?? value
}

interface ChatPrefsState {
  /** "" = CLI default, else a pinned Claude model id. */
  model: string
  /** "" = CLI default, else a `--effort` tier. */
  effort: "" | ChatEffort
  /** Unsent composer text. */
  draft: string
  setModel: (model: string) => void
  setEffort: (effort: "" | ChatEffort) => void
  setDraft: (draft: string) => void
}

const LS_KEY = "grapevine.chatPrefs.v1"

interface Persisted {
  model: string
  effort: "" | ChatEffort
  draft: string
}

const DEFAULTS: Persisted = { model: "", effort: "", draft: "" }

function load(): Persisted {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return DEFAULTS
    const p = JSON.parse(raw) as Partial<Persisted>
    const effort =
      p.effort && (CHAT_EFFORT_LEVELS as readonly string[]).includes(p.effort)
        ? (p.effort as ChatEffort)
        : ""
    return {
      model: typeof p.model === "string" ? p.model : "",
      effort,
      draft: typeof p.draft === "string" ? p.draft : "",
    }
  } catch {
    return DEFAULTS
  }
}

export const useChatPrefs = create<ChatPrefsState>((set, get) => {
  const persist = () => {
    const { model, effort, draft } = get()
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ model, effort, draft }))
    } catch {
      /* private mode / quota — prefs just won't persist */
    }
  }
  return {
    ...load(),
    setModel: (model) => {
      set({ model })
      persist()
    },
    setEffort: (effort) => {
      set({ effort })
      persist()
    },
    setDraft: (draft) => {
      set({ draft })
      persist()
    },
  }
})
