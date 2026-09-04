import { useEffect, useState } from "react"
import { BotIcon, CheckIcon, CopyIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { SectionHeader } from "@/components/account/SectionHeader"
import { api } from "@/lib/api"
import type { AgentCapabilities } from "@/lib/types"

/**
 * Hand the map to Claude: the MCP connector URL and two ready-made prompts
 * for a scheduled task, so "Claude, tell me every Friday what's on" is a
 * paste away. Claude's scheduled tasks live in the user's own Claude account;
 * this card gives them everything that account needs.
 */

const PROMPTS = [
  {
    title: "Weekend picks, every Friday",
    text:
      "Using the Grapevine connector, call search_events for this coming weekend (date_from is Friday, date_to is Sunday, exclude_promoted true, limit 8). Send me the five best picks with their titles, venues and times, one line each. If nothing matches, say so plainly.",
  },
  {
    title: "Rare finds, once a week",
    text:
      "Using the Grapevine connector, call search_events for the next 14 days with limit 20, keep only events whose rarity is rare or notable, and send me a short list with dates, times and venues. Skip anything promoted.",
  },
] as const

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Couldn't copy", { description: "Clipboard access was blocked." })
    }
  }
  return (
    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={copy} aria-label={label}>
      {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  )
}

export function ClaudeHandoff() {
  const [caps, setCaps] = useState<AgentCapabilities | null>(null)
  useEffect(() => {
    api
      .capabilities()
      .then(setCaps)
      .catch(() => setCaps(null))
  }, [])
  const url = caps?.mcp.url

  return (
    <section>
      <SectionHeader icon={<BotIcon className="size-3.5" />} title="Grapevine in Claude" />
      <p className="mt-2 text-xs text-muted-foreground">
        Add this map as a connector in Claude (Settings, Connectors, add a custom connector with
        the URL below, then sign in when it asks). After that a scheduled task in your Claude
        account can ask it anything the chat here can.
      </p>
      {url && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border bg-muted/30 py-1 pr-1 pl-3">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{url}</span>
          <CopyButton text={url} label="Copy connector URL" />
        </div>
      )}
      <div className="mt-2 flex flex-col gap-2">
        {PROMPTS.map((p) => (
          <div key={p.title} className="rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-medium">{p.title}</span>
              <CopyButton text={p.text} label={`Copy the prompt: ${p.title}`} />
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{p.text}</p>
          </div>
        ))}
      </div>
      {caps?.mcp.auth === "open" && (
        <p className="mt-2 text-xs text-muted-foreground">
          This server runs with MCP_OPEN=1, so the connector needs no sign-in; writes act on the
          operator's linked account.
        </p>
      )}
    </section>
  )
}
