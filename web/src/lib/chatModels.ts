import type { ChatEffort } from "@/lib/types"

/**
 * The model and effort menus of the "Ask Grapevine" composer, for the Claude
 * Code provider. The choices themselves are kept in the persisted store
 * (chatModel, chatEffort); this file only knows what the menus offer.
 */

/** Explicit model ids, not the CLI's short aliases ("opus", "sonnet"): an
 *  alias resolves against the account and has been observed to land somewhere
 *  other than the tier it names. "" = the CLI's own default (honours the
 *  user's `/model` choice).
 *
 *  Only tiers a Pro/Max subscription actually serves belong here: a model the
 *  account can't reach doesn't error, it quietly answers on a different one
 *  (claude-fable-5 comes back as Opus 5), which is the silent downgrade this
 *  list exists to avoid. The usage footer reports whichever model wrote the
 *  reply, so add a tier here only after checking it round-trips as itself. */
export const CLAUDE_CHAT_MODELS = [
  { value: "", label: "Default" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5" },
  { value: "claude-sonnet-5", label: "Sonnet 5" },
  { value: "claude-opus-5", label: "Opus 5" },
] as const

export const CHAT_EFFORT_OPTIONS: { value: "" | ChatEffort; label: string }[] =
  [
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
