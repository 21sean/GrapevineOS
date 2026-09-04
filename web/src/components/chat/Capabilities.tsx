import { useEffect, useState } from "react"
import { WrenchIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import type { AgentCapabilities } from "@/lib/types"

/**
 * "What can I ask?" A popover off the composer that says who is answering,
 * what it can do, and where the same tools are reachable from Claude. Read
 * once per open; the server's answer changes only when an admin changes the
 * provider or model.
 */

const EFFECT_ORDER = ["read", "ui", "propose", "write"] as const
const EFFECT_LABEL: Record<(typeof EFFECT_ORDER)[number], string> = {
  read: "Looks things up",
  ui: "Changes your map",
  propose: "Asks you first",
  write: "Writes when you say so",
}

const PROVIDER_LABEL: Record<AgentCapabilities["provider"], string> = {
  ollama: "the local model",
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  copilot: "Copilot CLI",
}

/** First sentence of a tool description, for a one-line row. */
function gist(description: string): string {
  const first = description.split(/(?<=\.)\s/)[0] ?? description
  return first.length > 110 ? `${first.slice(0, 107)}…` : first
}

export function CapabilitiesPopover() {
  const [open, setOpen] = useState(false)
  const [caps, setCaps] = useState<AgentCapabilities | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open || caps) return
    api
      .capabilities()
      .then((c) => setCaps(c))
      .catch(() => setFailed(true))
  }, [open, caps])

  const who = caps
    ? caps.provider === "ollama"
      ? caps.model
        ? `${caps.model} on this machine`
        : "no model selected yet"
      : `${PROVIDER_LABEL[caps.provider]} (its own default model)`
    : ""
  const rails = caps
    ? caps.rails.classifier === "ready"
      ? "safety rails on"
      : caps.rails.classifier === "off"
        ? "safety rails off"
        : "safety rails loading"
    : ""

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="What can I ask?"
          className="rounded-full text-muted-foreground"
        >
          <WrenchIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 text-sm">
        {failed ? (
          <p className="text-xs text-muted-foreground">
            Couldn't reach the server.
          </p>
        ) : !caps ? (
          <Spinner className="mx-auto size-4" />
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <div className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                Answering
              </div>
              <div className="mt-1 font-medium">{who}</div>
              <div className="text-xs text-muted-foreground">
                {caps.tools
                  ? `${caps.toolbox.length} tools · ${rails}`
                  : `answers from the event digest only, no tools · ${rails}`}
              </div>
            </div>
            {EFFECT_ORDER.map((effect) => {
              const tools = caps.toolbox.filter((t) => t.effect === effect)
              if (!tools.length) return null
              return (
                <div key={effect}>
                  <div className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                    {EFFECT_LABEL[effect]}
                  </div>
                  <ul className="mt-1 flex flex-col gap-1">
                    {tools.map((t) => (
                      <li key={t.name} className="leading-snug">
                        <span className="font-mono text-xs">
                          {t.name.replace(/_/g, " ")}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {" "}
                          {gist(t.description)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
            <p className="text-xs text-muted-foreground">
              The same tools are available to Claude over MCP; see Account for
              the connector.
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
