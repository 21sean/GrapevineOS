import { useCallback, useEffect, useState } from "react"
import { CheckIcon, CopyIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { ProviderLogo } from "@/components/admin/ProviderLogo"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import {
  CLI_PROVIDER_NAMES,
  type LocalRuntimeStatus,
  type McpInfo,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Admin → Providers: the local runtime chat and extraction generate on, and
 * wiring Claude up to this app's tools over MCP. Hosted CLI generation is gone,
 * so there is nothing to pick here. The one action is the way back from a CLI
 * saved before v0.7.0, which still loads and which chat and extraction refuse.
 */
export function ProvidersTab() {
  const settings = useGrapevine((s) => s.settings)
  const setSettings = useGrapevine((s) => s.setSettings)

  // undefined until the first answer; null when the server could not say.
  const [runtime, setRuntime] = useState<LocalRuntimeStatus | null>()
  const [mcp, setMcp] = useState<McpInfo | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [switching, setSwitching] = useState(false)

  const refresh = useCallback(() => {
    setRefreshing(true)
    api
      .runtime()
      .then(setRuntime)
      .catch(() => setRuntime(null))
      .finally(() => setRefreshing(false))
  }, [])

  useEffect(() => {
    refresh()
    api
      .mcpInfo()
      .then(setMcp)
      .catch(() => setMcp(null))
  }, [refresh])

  const chatProvider = settings?.chatProvider ?? "ollama"
  const extractProvider = settings?.extractProvider ?? "ollama"
  const onLocal = chatProvider === "ollama" && extractProvider === "ollama"

  async function switchToLocal() {
    setSwitching(true)
    try {
      const next = await api.saveSettings({
        chatProvider: "ollama",
        extractProvider: "ollama",
      })
      setSettings(next)
      toast.success("Chat and extraction are back on the local runtime")
    } catch (err) {
      toast.error("Couldn't switch back", {
        description: String(err).slice(0, 140),
      })
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 className="font-heading text-base font-semibold">Providers</h3>
          <p className="text-sm text-muted-foreground">
            Ask Grapevine, newsletter extraction and buzz ratings all run on the
            local runtime.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Check the runtime again"
          onClick={refresh}
          disabled={refreshing}
        >
          <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
        </Button>
      </div>

      {/* The way back from a CLI saved before hosted generation was removed */}
      {!onLocal && (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm">
          {chatProvider !== "ollama" && (
            <p>
              Ask Grapevine is still set to {CLI_PROVIDER_NAMES[chatProvider]},
              so chat answers with an error.
            </p>
          )}
          {extractProvider !== "ollama" && (
            <p>
              Newsletter extraction is still set to{" "}
              {CLI_PROVIDER_NAMES[extractProvider]}, so extraction and buzz
              ratings fail.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Hosted CLI generation was removed in v0.7.0.
          </p>
          <Button
            size="sm"
            className="self-start"
            disabled={switching}
            onClick={switchToLocal}
          >
            Switch back to the local runtime
          </Button>
        </div>
      )}

      {/* The local runtime: the full agent, and the fully local pipeline */}
      <div
        className={cn(
          "flex flex-col gap-2 rounded-lg border px-3 py-2.5",
          (chatProvider === "ollama" || extractProvider === "ollama") &&
            "border-wine/60"
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <ProviderLogo id={runtime?.id ?? "ollama"} />
            <div className="flex min-w-0 flex-col">
              <span className="flex items-center gap-2 text-sm">
                {runtime ? `${runtime.name} (local)` : "Local runtime"}
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    runtime?.version ? "bg-live" : "bg-destructive",
                    runtime === undefined && "invisible"
                  )}
                />
              </span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {runtime === undefined
                  ? "checking…"
                  : `${runtime?.version ? `v${runtime.version}` : "unreachable"} · ${runtime?.model || "no model picked"}`}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {chatProvider === "ollama" && (
              <Badge variant="outline" className="text-live">
                Chat
              </Badge>
            )}
            {extractProvider === "ollama" && (
              <Badge variant="outline" className="text-live">
                Extraction
              </Badge>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Chat gets the full toolbox (map pinning, ETAs, calendar proposals, web
          search), and extraction stays entirely on this machine.{" "}
          {runtime?.id === "vllm"
            ? "It serves one pinned model, set with GRAPEVINE_LLM_MODEL."
            : "Pick the model in the Models tab."}
        </p>
      </div>

      <Separator />

      {/* MCP: Claude drives this app's tools */}
      <div className="flex flex-col gap-1">
        <h3 className="font-heading text-base font-semibold">
          Connect Claude to Grapevine (MCP)
        </h3>
        <p className="text-sm text-muted-foreground">
          Give Claude Code or Claude Desktop this app's tools (event search,
          details, ETAs, calendar saves, interests) over the Model Context
          Protocol. They answer in their own sessions; nothing here generates
          through them.
        </p>
      </div>

      {!mcp ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <SnippetLabel>Endpoint</SnippetLabel>
            <Snippet text={mcp.url} />
          </div>
          <div className="flex flex-col gap-1.5">
            <SnippetLabel>
              Claude Desktop / claude.ai: custom connector
            </SnippetLabel>
            <Snippet text={mcp.connectorUrl} />
            <p className="text-xs text-muted-foreground">
              Settings → Connectors → Add custom connector → paste this URL,
              nothing else.{" "}
              {mcp.auth === "oauth" &&
                "Claude discovers the OAuth setup on its own, opens a browser window to sign in with your Grapevine account, and you approve once. "}
              Connectors need the server reachable over HTTPS: run a tunnel
              (e.g.{" "}
              <code className="font-mono">
                cloudflared tunnel --url http://localhost:8787
              </code>
              ) and set MCP_PUBLIC_URL in server/.env to the tunnel URL so this
              snippet updates.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <SnippetLabel>Claude Code: one command</SnippetLabel>
            <Snippet
              text={`claude mcp add --transport http grapevine ${mcp.url}`}
            />
            {mcp.auth === "oauth" && (
              <p className="text-xs text-muted-foreground">
                First use triggers the same browser sign-in; run{" "}
                <code className="font-mono">/mcp</code> in Claude Code to
                authenticate if it doesn't prompt on its own.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <SnippetLabel>Project .mcp.json</SnippetLabel>
            <Snippet
              text={JSON.stringify({
                mcpServers: {
                  grapevine: { type: "http", url: mcp.url },
                },
              })}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {mcp.auth === "oauth"
              ? "Each connected client acts as the Grapevine account it signed in with; calendar saves and interests are per-user. Headless scripts can still send AGENT_API_KEY (server/.env) as an X-Agent-Key header; those writes act on AGENT_USER_EMAIL."
              : "MCP_OPEN=1: the endpoint is open and writes act on the account named by AGENT_USER_EMAIL. Unset MCP_OPEN to require OAuth sign-in."}
          </p>
        </div>
      )}
    </div>
  )
}

function SnippetLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
      {children}
    </span>
  )
}

function Snippet({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-card/60 px-2.5 py-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] whitespace-nowrap">
        {text}
      </code>
      <CopyButton text={text} />
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Copy"
      className="size-6 shrink-0 rounded-md text-muted-foreground"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => toast.error("Couldn't copy"))
      }}
    >
      {copied ? (
        <CheckIcon className="size-3.5 text-live" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </Button>
  )
}
