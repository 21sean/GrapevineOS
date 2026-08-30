import { accessToken } from "./supabase"
import type {
  AgentFrame,
  CalendarStatus,
  ChatMessageRec,
  ChatThreadMeta,
  CityEvent,
  CliProviderStatus,
  ConversationEval,
  ConversationMonitorRow,
  DiscoveryRunResult,
  DiscoverySearch,
  EvalCatalog,
  EvalFrame,
  EvalRun,
  GuardrailDashboard,
  GuardrailLabel,
  GuardrailRail,
  GuardrailScan,
  GuardrailMode,
  Filters,
  GcalEvent,
  GcalEventPatch,
  InboxEmail,
  IngestRecord,
  Interests,
  McpInfo,
  Reaction,
  Settings,
  Source,
  User,
  VenueDetails,
} from "./types"

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(body.slice(0, 300) || `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

/**
 * fetch + the Supabase access token as a Bearer header. The Express API
 * verifies it against the project's JWKS; requests without a session go out
 * bare and hit the public endpoints exactly as before.
 */
async function fetch(input: string, init?: RequestInit): Promise<Response> {
  const token = await accessToken()
  return globalThis.fetch(input, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
}

export const api = {
  events: () => fetch("/api/events").then((r) => json<CityEvent[]>(r)),

  me: () => fetch("/api/me").then((r) => json<{ user: User | null }>(r)),

  savePrefs: (prefs: {
    filters?: Filters
    interests?: Interests
    pinnedIds?: string[]
    hiddenIds?: string[]
    mutedVenues?: string[]
    mutedSources?: string[]
  }) =>
    fetch("/api/me/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prefs),
    }).then((r) => json<{ user: User | null }>(r)),

  settings: () => fetch("/api/settings").then((r) => json<Settings>(r)),

  saveSettings: (patch: Partial<Settings>) =>
    fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<Settings>(r)),

  sources: () => fetch("/api/sources").then((r) => json<Source[]>(r)),

  eta: (to: [number, number], from?: [number, number]) => {
    const params = new URLSearchParams({ to: to.join(",") })
    if (from) params.set("from", from.join(","))
    return fetch(`/api/eta?${params}`).then((r) =>
      json<{ minutes: number | null; km: number | null }>(r),
    )
  },

  /** Drive-time contour around a point — the "Near me" filter's zone. */
  isochrone: (minutes: number, center?: [number, number]) => {
    const params = new URLSearchParams({ minutes: String(minutes) })
    if (center) params.set("center", center.join(","))
    return fetch(`/api/isochrone?${params}`).then((r) =>
      json<{ polygons: [number, number][][][] }>(r),
    )
  },

  /**
   * Mapbox Places detail for an event's venue: hours, photos, accessibility,
   * and typical busyness. `venue` is null when Mapbox has no record for the
   * place, or when the preview quota/scope makes the lookup unavailable.
   */
  venue: (id: string) =>
    fetch(`/api/events/${id}/venue`).then((r) =>
      json<{ venue: VenueDetails | null }>(r),
    ),

  rate: (id: string) =>
    fetch(`/api/events/${id}/rate`, { method: "POST" }).then((r) =>
      json<CityEvent>(r),
    ),

  /** The signed-in user's reactions (going / went / not for me). */
  reactions: () =>
    fetch("/api/reactions").then((r) =>
      json<{ reactions: { eventId: string; reaction: Reaction }[] }>(r),
    ),

  setReaction: (id: string, reaction: Reaction | null) =>
    fetch(`/api/events/${encodeURIComponent(id)}/reaction`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reaction }),
    }).then((r) => json<{ ok: boolean }>(r)),

  // ---------- web push (reminders + leave-by alerts + weekly digest) ----------

  pushKey: () => fetch("/api/push/key").then((r) => json<{ publicKey: string }>(r)),

  pushStatus: (endpoint: string) =>
    fetch("/api/push/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }).then((r) =>
      json<{
        subscribed: boolean
        reminders: boolean
        weeklyDigest: boolean
        leaveBy: boolean
        rareFinds: boolean
      }>(r),
    ),

  pushSubscribe: (
    subscription: PushSubscriptionJSON,
    prefs?: {
      reminders?: boolean
      weeklyDigest?: boolean
      leaveBy?: boolean
      rareFinds?: boolean
    },
  ) =>
    fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription, ...prefs }),
    }).then((r) => json<{ ok: boolean }>(r)),

  pushPrefs: (
    endpoint: string,
    prefs: {
      reminders?: boolean
      weeklyDigest?: boolean
      leaveBy?: boolean
      rareFinds?: boolean
    },
  ) =>
    fetch("/api/push/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, ...prefs }),
    }).then((r) => json<{ ok: boolean }>(r)),

  /** Coarse origin for leave-by ETAs; the server snaps it to ~110 m. */
  pushPosition: (pos: [number, number]) =>
    fetch("/api/push/position", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lng: pos[0], lat: pos[1] }),
    }).then((r) => json<{ ok: boolean }>(r)),

  pushUnsubscribe: (endpoint: string) =>
    fetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }).then((r) => json<{ ok: boolean }>(r)),

  /** Scrape og:images for catalog events that never got artwork. */
  backfillImages: () =>
    fetch("/api/ingest/backfill-images", { method: "POST" }).then((r) =>
      json<{ scanned: number; enriched: number }>(r),
    ),

  ollamaHealth: () =>
    fetch("/api/ollama/health").then((r) =>
      json<{ ok: boolean; url: string; version: string | null }>(r),
    ),

  ollamaModels: () =>
    fetch("/api/ollama/models").then((r) =>
      json<
        {
          name: string
          sizeBytes: number
          family: string
          parameterSize: string
          capabilities: string[]
        }[]
      >(r),
    ),

  /** CLI chat providers (claude/codex/gemini) installed on the server machine. */
  providers: (refresh = false) =>
    fetch(`/api/providers${refresh ? "?refresh=1" : ""}`).then((r) =>
      json<{ providers: CliProviderStatus[] }>(r),
    ),

  /** models.dev provider logo as raw SVG text (inlined to inherit currentColor). */
  providerLogo: (id: string) =>
    fetch(`/api/logo/${encodeURIComponent(id)}`).then((r) => r.text()),

  /** Where MCP clients (Claude Code/Desktop) connect to drive this app. */
  mcpInfo: () => fetch("/api/mcp/info").then((r) => json<McpInfo>(r)),

  catalog: () =>
    fetch("/api/catalog").then((r) =>
      json<
        {
          id: string
          name: string
          models: {
            tag: string
            label: string
            sizeGB: number
            downloadSize: string
            blurb: string
            context?: number
            releaseDate?: string
            reasoning?: boolean
            vision?: boolean
          }[]
        }[]
      >(r),
    ),

  /** Local hardware the server detected — drives the can-it-run badges. */
  system: () =>
    fetch("/api/system").then((r) =>
      json<{
        ramGB: number
        vramGB: number | null
        gpu: string | null
        unifiedMemory: boolean
      }>(r),
    ),

  /** Streams NDJSON pull progress; calls onProgress with 0–100 (or -1 while indeterminate). */
  async pullModel(
    model: string,
    onProgress: (pct: number, status: string) => void,
  ): Promise<void> {
    const res = await fetch("/api/ollama/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    })
    if (!res.ok || !res.body) throw new Error(await res.text())
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.error) throw new Error(msg.error)
          const pct =
            msg.total && msg.completed
              ? Math.round((msg.completed / msg.total) * 100)
              : -1
          onProgress(pct, msg.status ?? "")
        } catch (err) {
          if (err instanceof SyntaxError) continue
          throw err
        }
      }
    }
  },

  /**
   * Streams the agent's NDJSON frames; abort via `signal` to stop generation.
   * Conversation history lives server-side in the LangGraph checkpointer —
   * send the same `threadId` to continue a conversation.
   */
  async agentChat(
    body: {
      threadId: string
      message: string
      context?: {
        userPos?: [number, number]
        interests?: Interests
        savedEventIds?: string[]
        signedIn?: boolean
      }
      /** Claude Code CLI overrides (empty/omitted = the CLI's own default). */
      model?: string
      effort?: string
    },
    onFrame: (frame: AgentFrame) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch("/api/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok || !res.body) throw new Error(await res.text())
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          onFrame(JSON.parse(line) as AgentFrame)
        } catch (err) {
          if (err instanceof SyntaxError) continue
          throw err
        }
      }
    }
  },

  calendarStatus: () =>
    fetch("/api/calendar/status").then((r) => json<CalendarStatus>(r)),

  calendarAdd: (id: string) =>
    fetch(`/api/calendar/events/${id}`, { method: "POST" }).then((r) =>
      json<CalendarStatus & { googleSynced: boolean; warning?: string }>(r),
    ),

  calendarRemove: (id: string) =>
    fetch(`/api/calendar/events/${id}`, { method: "DELETE" }).then((r) =>
      json<CalendarStatus>(r),
    ),

  /** Hand the provider_refresh_token from the OAuth return to the server. */
  calendarConnect: (refreshToken: string, scope?: string) =>
    fetch("/api/calendar/google/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken, ...(scope && { scope }) }),
    }).then((r) => json<CalendarStatus>(r)),

  calendarDisconnect: () =>
    fetch("/api/calendar/google/disconnect", { method: "POST" }).then((r) =>
      json<CalendarStatus>(r),
    ),

  /** The user's Google Calendar between two ISO instants (the popup window). */
  gcalEvents: (from: string, to: string) =>
    fetch(
      `/api/calendar/google/events?${new URLSearchParams({ from, to })}`,
    ).then((r) => json<{ events: GcalEvent[] }>(r)),

  gcalCreate: (body: GcalEventPatch) =>
    fetch("/api/calendar/google/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<GcalEvent>(r)),

  gcalUpdate: (id: string, patch: GcalEventPatch) =>
    fetch(`/api/calendar/google/events/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<GcalEvent>(r)),

  gcalDelete: (id: string) =>
    fetch(`/api/calendar/google/events/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).then((r) => json<CalendarStatus>(r)),

  /** Ask Grapevine history — signed-in users only, ownership checked server-side. */
  chatThreads: () =>
    fetch("/api/chat/threads").then((r) => json<{ threads: ChatThreadMeta[] }>(r)),

  chatThread: (id: string) =>
    fetch(`/api/chat/threads/${encodeURIComponent(id)}`).then((r) =>
      json<{ id: string; messages: ChatMessageRec[] }>(r),
    ),

  chatThreadDelete: (id: string) =>
    fetch(`/api/chat/threads/${encodeURIComponent(id)}`, { method: "DELETE" }).then(
      (r) => json<{ ok: boolean }>(r),
    ),

  inbox: () =>
    fetch("/api/inbox").then((r) =>
      json<{ configured: boolean; emails: InboxEmail[] }>(r),
    ),

  reprocessInbox: (key: string) =>
    fetch("/api/inbox/reprocess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    }).then((r) => json<{ extracted: number; added: number }>(r)),

  ingestHistory: () =>
    fetch("/api/ingest/history").then((r) => json<IngestRecord[]>(r)),

  ingestEmail: (text: string, source: string, dryRun: boolean) =>
    fetch("/api/ingest/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, source, dryRun }),
    }).then((r) => json<{ events: CityEvent[]; added: number }>(r)),

  commitEvents: (events: CityEvent[]) =>
    fetch("/api/ingest/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    }).then((r) => json<{ added: number }>(r)),

  // ---------- web discovery (AI web search → verified events) ----------

  discoveryRun: (query: string, dryRun: boolean) =>
    fetch("/api/discovery/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // dry_run is the server's canonical spelling (omitted = dry run)
      body: JSON.stringify({ query, dry_run: dryRun }),
    }).then((r) => json<DiscoveryRunResult>(r)),

  discoverySearches: () =>
    fetch("/api/discovery/searches").then((r) =>
      json<{ searches: DiscoverySearch[] }>(r),
    ),

  addDiscoverySearch: (query: string, cadenceHours: number) =>
    fetch("/api/discovery/searches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, cadenceHours }),
    }).then((r) => json<DiscoverySearch>(r)),

  patchDiscoverySearch: (
    id: string,
    patch: { active?: boolean; cadenceHours?: number },
  ) =>
    fetch(`/api/discovery/searches/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<DiscoverySearch>(r)),

  deleteDiscoverySearch: (id: string) =>
    fetch(`/api/discovery/searches/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).then((r) => json<{ ok: boolean }>(r)),

  runDiscoverySearch: (id: string) =>
    fetch(`/api/discovery/searches/${encodeURIComponent(id)}/run`, {
      method: "POST",
    }).then((r) => json<DiscoveryRunResult>(r)),

  // ---------- evals ----------

  evals: () => fetch("/api/evals").then((r) => json<EvalCatalog>(r)),

  evalHistory: () =>
    fetch("/api/evals/history").then((r) => json<{ runs: EvalRun[] }>(r)),

  /**
   * Streams one NDJSON frame per case as it finishes, so a long suite shows
   * progress instead of a spinner. Abort via `signal`; the server stops
   * between cases and does not record a partial run to history.
   */
  async runEvals(
    suites: string[] | undefined,
    onFrame: (frame: EvalFrame) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch("/api/evals/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(suites?.length ? { suites } : {}),
      signal,
    })
    if (!res.ok || !res.body) throw new Error(await res.text())
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          onFrame(JSON.parse(line) as EvalFrame)
        } catch (err) {
          if (err instanceof SyntaxError) continue
          throw err
        }
      }
    }
  },

  /** Past conversations, each with its rail decisions and newest eval. */
  conversationMonitor: (limit = 25) =>
    fetch(`/api/evals/conversations?limit=${limit}`).then((r) =>
      json<{ threads: ConversationMonitorRow[] }>(r),
    ),

  /** Judge one thread on the local Ollama judge. Tens of seconds — spin. */
  evaluateConversation: (threadId: string) =>
    fetch(`/api/evals/conversations/${encodeURIComponent(threadId)}/evaluate`, {
      method: "POST",
    }).then((r) => json<ConversationEval>(r)),

  // ---------- guardrails ----------

  /**
   * The whole dashboard in one request. `window` is the comparison period:
   * the server also returns the equivalent window before it, which is what
   * makes the drift number a comparison rather than a vibe.
   */
  guardrails: (windowDays = 7) =>
    fetch(`/api/guardrails?window=${windowDays}`).then((r) => json<GuardrailDashboard>(r)),

  /** The review queue. Highest-scoring unlabelled decisions by default. */
  guardrailScans: (params: {
    rail?: GuardrailRail
    blocked?: boolean
    unlabelled?: boolean
    minScore?: number
    order?: "recent" | "score"
    limit?: number
  } = {}) => {
    const q = new URLSearchParams()
    if (params.rail) q.set("rail", params.rail)
    if (params.blocked !== undefined) q.set("blocked", String(params.blocked))
    if (params.unlabelled) q.set("unlabelled", "true")
    if (params.minScore !== undefined) q.set("min_score", String(params.minScore))
    if (params.order) q.set("order", params.order)
    if (params.limit) q.set("limit", String(params.limit))
    return fetch(`/api/guardrails/scans?${q}`).then((r) => json<{ scans: GuardrailScan[] }>(r))
  },

  /** Record a judgement. `null` clears one. */
  labelGuardrailScan: (id: number, label: GuardrailLabel | null) =>
    fetch(`/api/guardrails/scans/${id}/label`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    }).then((r) => json<{ ok: true }>(r)),

  /** Retune. Returns what is actually in force, which env can still override. */
  setGuardrailConfig: (patch: { mode?: GuardrailMode; threshold?: number }) =>
    fetch("/api/guardrails/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<{ mode: GuardrailMode; threshold: number; note?: string }>(r)),
}
