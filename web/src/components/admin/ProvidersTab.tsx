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
  isSupportedProvider,
  type HostedProviderId,
  type HostedProviderStatus,
  type LlmProviderId,
  type LocalRuntimeStatus,
  type McpInfo,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/** Admin setup for validated local and subscription-backed generation. */
export function ProvidersTab() {
  const settings = useGrapevine((s) => s.settings)
  const setSettings = useGrapevine((s) => s.setSettings)

  // undefined until the first answer; null when the server could not say.
  const [runtime, setRuntime] = useState<LocalRuntimeStatus | null>()
  const [mcp, setMcp] = useState<McpInfo | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [hosted, setHosted] = useState<HostedProviderStatus[]>([])
  const [providerError, setProviderError] = useState("")
  const [testing, setTesting] = useState<HostedProviderId | null>(null)
  const [tested, setTested] = useState<
    Partial<Record<HostedProviderId, string>>
  >({})

  const refresh = useCallback(() => {
    setRefreshing(true)
    setProviderError("")
    setTested({})
    Promise.all([
      api
        .runtime()
        .then(setRuntime)
        .catch(() => setRuntime(null)),
      api
        .providers()
        .then(setHosted)
        .catch(() => {
          setHosted([])
          setProviderError(
            "Provider checks failed. Wait for active requests and refresh. If this persists, check the API logs and install the Python environment with uv sync --locked --project llm."
          )
        }),
    ]).finally(() => setRefreshing(false))
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

  async function selectProvider(
    role: "chatProvider" | "extractProvider",
    value: LlmProviderId
  ) {
    setSwitching(true)
    try {
      setSettings(await api.saveSettings({ [role]: value }))
      toast.success("Provider updated")
    } catch (err) {
      toast.error("Couldn't update provider", {
        description: String(err).slice(0, 180),
      })
    } finally {
      setSwitching(false)
    }
  }

  async function testProvider(id: HostedProviderId) {
    setTesting(id)
    setTested((previous) => ({
      ...previous,
      [id]: "Testing a validated response…",
    }))
    try {
      await api.testProvider(id)
      setTested((previous) => ({
        ...previous,
        [id]: "Connected · structured response validated",
      }))
    } catch (err) {
      setTested((previous) => ({
        ...previous,
        [id]: String(err).slice(0, 250),
      }))
    } finally {
      setTesting(null)
    }
  }

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
            Choose who answers Ask Grapevine and who processes newsletters and
            buzz ratings.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh provider status"
          onClick={refresh}
          disabled={refreshing}
        >
          <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ["chatProvider", "Ask Grapevine", chatProvider],
            ["extractProvider", "Extraction and ratings", extractProvider],
          ] as const
        ).map(([role, label, value]) => (
          <label key={role} className="flex flex-col gap-1.5 text-sm">
            {label}
            <select
              className="rounded-md border bg-background px-3 py-2"
              value={value}
              disabled={!settings || switching}
              onChange={(event) =>
                selectProvider(role, event.target.value as LlmProviderId)
              }
            >
              <option value="ollama">Local runtime</option>
              <option value="codex">ChatGPT / Codex</option>
              <option value="claude">Claude Code</option>
              {!isSupportedProvider(value) && (
                <option value={value} disabled>
                  {CLI_PROVIDER_NAMES[value]} (unsupported)
                </option>
              )}
            </select>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Hosted providers send the selected workload's messages, event context
        and newsletter text to OpenAI or Anthropic. They use the account signed
        in on the API server and its plan limits or API billing, shared across
        this deployment.
      </p>
      {providerError && (
        <p role="alert" className="text-sm text-destructive">
          {providerError}
        </p>
      )}
      {(["codex", "claude"] as const).map((id) => {
        const status = hosted.find((entry) => entry.id === id)
        return (
          <div
            key={id}
            className={cn(
              "flex flex-col gap-2 rounded-lg border px-3 py-2.5",
              (chatProvider === id || extractProvider === id) &&
                "border-wine/60"
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium">
                {id === "codex" ? "ChatGPT / Codex" : "Claude Code"}
              </h4>
              <Badge variant="outline">
                {status?.ready
                  ? "Ready to test"
                  : refreshing
                    ? "Checking…"
                    : "Setup needed"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {status?.message ??
                "Install and sign in on the machine running the API server."}
            </p>
            {status && (
              <p className="font-mono text-xs text-muted-foreground">
                {status.version ?? "Not installed"} · {status.model}
              </p>
            )}
            <SnippetLabel>
              {id === "codex"
                ? "Install or update"
                : "Install (Windows, macOS or Linux)"}
            </SnippetLabel>
            <Snippet
              text={
                id === "codex"
                  ? "npm install -g @openai/codex@latest"
                  : "npm install -g @anthropic-ai/claude-code@latest"
              }
            />
            <SnippetLabel>
              {id === "codex" ? "Sign in with ChatGPT" : "Sign in with Claude"}
            </SnippetLabel>
            <Snippet
              text={id === "codex" ? "codex login" : "claude auth login"}
            />
            <p className="text-xs text-muted-foreground">
              {id === "codex"
                ? "On a remote server, use codex login --device-auth. Sign-in opens the official OpenAI flow; Grapevine never asks for your password."
                : "Already signed in to Claude Code? Refresh to use that session. The best model may use separately billed Fable credits. Set GRAPEVINE_CLAUDE_MODEL=opus on the server to use latest Opus instead."}{" "}
              Run these as the same operating-system user that starts Grapevine,
              then refresh.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              disabled={!!testing || !status?.ready}
              onClick={() => testProvider(id)}
            >
              Test {id === "codex" ? "ChatGPT" : "Claude"} connection
            </Button>
            <p className="text-xs text-muted-foreground">
              The connection test makes one small model request and uses your
              plan allowance.
            </p>
            {tested[id] && (
              <p role="status" className="text-sm">
                {tested[id]}
              </p>
            )}
          </div>
        )
      })}

      {/* The way back from a CLI saved before hosted generation was removed */}
      {(!isSupportedProvider(chatProvider) ||
        !isSupportedProvider(extractProvider)) && (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm">
          {!isSupportedProvider(chatProvider) && (
            <p>
              Ask Grapevine is still set to {CLI_PROVIDER_NAMES[chatProvider]},
              so chat answers with an error.
            </p>
          )}
          {!isSupportedProvider(extractProvider) && (
            <p>
              Newsletter extraction is still set to{" "}
              {CLI_PROVIDER_NAMES[extractProvider]}, so extraction and buzz
              ratings fail.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            This saved provider is unsupported. Choose a supported provider
            above.
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
          Protocol. These external sessions are separate from the provider
          selected above.
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
