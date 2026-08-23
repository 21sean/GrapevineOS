import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  CHAT_EFFORT_OPTIONS,
  CLAUDE_CHAT_MODELS,
  effortLabel,
  modelLabel,
  useChatPrefs,
} from "@/lib/chatPrefs"
import { cn } from "@/lib/utils"

/**
 * Compact model + reasoning-effort picker for the Ask Grapevine composer.
 * Only shown when the chat provider is Claude Code — it's the one CLI whose
 * `--model` / `--effort` we drive per turn. "Default" leaves the choice to the
 * CLI (honouring the user's own `/model`). Selections persist via useChatPrefs.
 */
export function ModelEffortPicker() {
  const model = useChatPrefs((s) => s.model)
  const effort = useChatPrefs((s) => s.effort)
  const setModel = useChatPrefs((s) => s.setModel)
  const setEffort = useChatPrefs((s) => s.setEffort)

  // "Model · Effort", collapsing either half when it's on the CLI default.
  const trigger =
    [model && modelLabel(model), effort && effortLabel(effort)]
      .filter(Boolean)
      .join(" · ") || "Model"

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 rounded-full px-2.5 text-xs text-muted-foreground"
            >
              {trigger}
              <ChevronDownIcon className="size-3 opacity-60" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Model and reasoning effort</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-52 p-1.5">
        <Section label="Model">
          {CLAUDE_CHAT_MODELS.map((m) => (
            <Row
              key={m.value}
              label={m.label}
              active={model === m.value}
              onSelect={() => setModel(m.value)}
            />
          ))}
        </Section>
        <div className="my-1.5 h-px bg-border" />
        <Section label="Reasoning effort">
          {CHAT_EFFORT_OPTIONS.map((e) => (
            <Row
              key={e.value}
              label={e.label}
              active={effort === e.value}
              onSelect={() => setEffort(e.value)}
            />
          ))}
        </Section>
      </PopoverContent>
    </Popover>
  )
}

function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col">
      <span className="px-2 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      {children}
    </div>
  )
}

function Row({
  label,
  active,
  onSelect,
}: {
  label: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
        active && "text-foreground",
      )}
    >
      <span>{label}</span>
      {active && <CheckIcon className="size-3.5 text-wine" />}
    </button>
  )
}
