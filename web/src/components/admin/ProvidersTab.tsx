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
import type { ChatProviderId, CliProviderStatus, McpInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Admin → Providers: pick who answers "Ask Grapevine" and who runs the
 * newsletter extraction pipeline — the local Ollama model or a
 * subscription-authed CLI (Claude Code / Codex / Gemini / Copilot, no API
 * keys) — and wire Claude up to this app's tools over MCP.
 */
export function ProvidersTab() {
  const settings = useGrapevine((s) => s.settings)
  const setSettings = useGrapevine((s) => s.setSettings)

  const [clis, setClis] = useState<CliProviderStatus[] | null>(null)
  const [ollama, setOllama] = useState<{ ok: boolean; url: string; version: string | null } | null>(null)
  const [mcp, setMcp] = useState<McpInfo | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback((force = false) => {
    setRefreshing(true)
    Promise.allSettled([
      api.providers(force).then((r) => setClis(r.providers)).catch(() => setClis([])),
      api.ollamaHealth().then(setOllama).catch(() => setOllama(null)),
    ]).finally(() => setRefreshing(false))
  }, [])

  useEffect(() => {
    refresh()
    api.mcpInfo().then(setMcp).catch(() => setMcp(null))
  }, [refresh])

  const chatActive = settings?.chatProvider ?? "ollama"
  const extractActive = settings?.extractProvider ?? "ollama"

  async function setProvider(
    role: "chatProvider" | "extractProvider",
    id: ChatProviderId,
    label: string,
  ) {
    try {
      const next = await api.saveSettings({ [role]: id })
      setSettings(next)
      toast.success(
        role === "chatProvider"
          ? `Ask Grapevine now answers via ${label}`
          : `Newsletter extraction now runs via ${label}`,
      )
    } catch (err) {
      toast.error("Couldn't switch provider", { description: String(err).slice(0, 140) })
    }
  }

  const roleActions = (id: ChatProviderId, label: string, disabled = false) => (
    <div className="flex shrink-0 flex-col items-end gap-1">
      {chatActive === id ? (
        <Badge variant="outline" className="text-live">
          Chat
        </Badge>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={disabled}
          onClick={() => setProvider("chatProvider", id, label)}
        >
          Use for chat
        </Button>
      )}
      {extractActive === id ? (
        <Badge variant="outline" className="text-live">
          Extraction
        </Badge>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={disabled}
          onClick={() => setProvider("extractProvider", id, label)}
        >
          Use for extraction
        </Button>
      )}
    </div>
  )

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 className="font-heading text-base font-semibold">Providers</h3>
          <p className="text-sm text-muted-foreground">
            Who answers Ask Grapevine, and who runs newsletter extraction and
            buzz ratings. The CLIs sign in with the subscription you already
            have (Claude.ai, ChatGPT, Google, GitHub) — no API keys.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Re-detect providers"
          onClick={() => refresh(true)}
          disabled={refreshing}
        >
          <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
        </Button>
      </div>

      {/* Ollama — the full agent, and the fully local pipeline */}
      <div
        className={cn(
          "flex flex-col gap-2 rounded-lg border px-3 py-2.5",
          (chatActive === "ollama" || extractActive === "ollama") && "border-wine/60",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <ProviderLogo id="ollama" />
            <div className="flex min-w-0 flex-col">
              <span className="flex items-center gap-2 text-sm">
                Ollama (local)
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    ollama?.ok ? "bg-live" : "bg-destructive",
                  )}
                />
              </span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {ollama?.ok ? `v${ollama.version}` : "unreachable"} ·{" "}
                {settings?.model || "no model picked"}
              </span>
            </div>
          </div>
          {roleActions("ollama", "the local Ollama model")}
        </div>
        <p className="text-xs text-muted-foreground">
          Chat gets the full toolbox — map pinning, ETAs, calendar proposals,
          web search — and extraction stays entirely on this machine. Pick the
          model in the Models tab.
        </p>
      </div>

      {/* Subscription CLIs */}
      {!clis && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}
      {clis?.map((p) => {
        const isActive = chatActive === p.id || extractActive === p.id
        return (
          <div
            key={p.id}
            className={cn(
              "flex flex-col gap-2 rounded-lg border px-3 py-2.5",
              isActive && "border-wine/60",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <ProviderLogo id={p.logo} />
                <div className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-2 text-sm">
                    {p.name}
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        !p.installed
                          ? "bg-destructive"
                          : p.authed
                            ? "bg-live"
                            : "bg-amber-400",
                      )}
                    />
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {!p.installed
                      ? "not installed"
                      : `${p.version ?? "installed"} · ${
                          p.authed
                            ? p.authKind === "api-key"
                              ? "API key detected"
                              : "signed in (subscription)"
                            : "not signed in"
                        }`}
                  </span>
                </div>
              </div>
              {roleActions(p.id, p.name, !p.installed)}
            </div>
            {!p.installed && <Snippet text={p.installHint} />}
            {p.installed && !p.authed && (
              <>
                <p className="text-xs text-muted-foreground">
                  Sign in on the server machine — {p.loginNote}:
                </p>
                <Snippet text={p.loginHint} />
              </>
            )}
            <p className="text-xs text-muted-foreground">
              {p.loginNote}. Chat answers from the event digest — no map or
              calendar tools in this mode. Extraction runs the same newsletter
              pipeline through the CLI instead of the local model.
            </p>
          </div>
        )
      })}

      <Separator />

      {/* MCP — Claude drives this app's tools */}
      <div className="flex flex-col gap-1">
        <h3 className="font-heading text-base font-semibold">
          Connect Claude to Grapevine (MCP)
        </h3>
        <p className="text-sm text-muted-foreground">
          The reverse direction: give Claude Code or Claude Desktop this app's
          tools — event search, details, ETAs, calendar saves, interests — over
          the Model Context Protocol.
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
            <SnippetLabel>Claude Desktop / claude.ai — custom connector</SnippetLabel>
            <Snippet text={mcp.connectorUrl} />
            <p className="text-xs text-muted-foreground">
              Settings → Connectors → Add custom connector → paste this URL —
              nothing else. {mcp.auth === "oauth" &&
                "Claude discovers the OAuth setup on its own, opens a browser window to sign in with your Grapevine account, and you approve once. "}
              Connectors need the server reachable over HTTPS — run a tunnel
              (e.g. <code className="font-mono">cloudflared tunnel --url http://localhost:8787</code>)
              and set MCP_PUBLIC_URL in server/.env to the tunnel URL so this
              snippet updates.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <SnippetLabel>Claude Code — one command</SnippetLabel>
            <Snippet text={`claude mcp add --transport http grapevine ${mcp.url}`} />
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
              ? "Each connected client acts as the Grapevine account it signed in with — calendar saves and interests are per-user. Headless scripts can still send AGENT_API_KEY (server/.env) as an X-Agent-Key header; those writes act on AGENT_USER_EMAIL."
              : "MCP_OPEN=1 — the endpoint is open and writes act on the account named by AGENT_USER_EMAIL. Unset MCP_OPEN to require OAuth sign-in."}
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
      {copied ? <CheckIcon className="size-3.5 text-live" /> : <CopyIcon className="size-3.5" />}
    </Button>
  )
}
