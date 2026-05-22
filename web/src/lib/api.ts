import type {
  CityEvent,
  Filters,
  IngestRecord,
  Interests,
  Settings,
  Source,
  User,
} from "./types"

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(body.slice(0, 300) || `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  events: () => fetch("/api/events").then((r) => json<CityEvent[]>(r)),

  me: () => fetch("/api/me").then((r) => json<{ user: User | null }>(r)),

  logout: () =>
    fetch("/auth/logout", { method: "POST" }).then((r) => json<{ ok: boolean }>(r)),

  savePrefs: (prefs: {
    filters?: Filters
    interests?: Interests
    pinnedIds?: string[]
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

  rate: (id: string) =>
    fetch(`/api/events/${id}/rate`, { method: "POST" }).then((r) =>
      json<CityEvent>(r),
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

  catalog: () =>
    fetch("/api/catalog").then((r) =>
      json<
        {
          id: string
          name: string
          models: {
            tag: string
            label: string
            params: string
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
}
