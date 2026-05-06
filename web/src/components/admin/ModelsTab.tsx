import { useCallback, useEffect, useState } from "react"
import { DownloadIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { ProviderLogo } from "@/components/admin/ProviderLogo"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import { cn } from "@/lib/utils"

type Installed = Awaited<ReturnType<typeof api.ollamaModels>>[number]
type Catalog = Awaited<ReturnType<typeof api.catalog>>

export function ModelsTab() {
  const settings = useGrapevine((s) => s.settings)
  const setSettings = useGrapevine((s) => s.setSettings)

  const [health, setHealth] = useState<{ ok: boolean; url: string; version: string | null } | null>(null)
  const [installed, setInstalled] = useState<Installed[] | null>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [pulling, setPulling] = useState<{ tag: string; pct: number; status: string } | null>(null)

  const refresh = useCallback(() => {
    api.ollamaHealth().then(setHealth).catch(() => setHealth(null))
    api.ollamaModels().then(setInstalled).catch(() => setInstalled([]))
  }, [])

  useEffect(() => {
    refresh()
    api.catalog().then(setCatalog).catch(() => setCatalog([]))
  }, [refresh])

  const chatModels = (installed ?? []).filter(
    (m) => !m.capabilities.length || m.capabilities.includes("completion"),
  )
  const installedTags = new Set((installed ?? []).map((m) => m.name.replace(/:latest$/, "")))

  async function setActive(model: string) {
    const next = await api.saveSettings({ model })
    setSettings(next)
    toast.success(`Active model: ${model}`)
  }

  async function pull(tag: string) {
    setPulling({ tag, pct: -1, status: "starting" })
    try {
      await api.pullModel(tag, (pct, status) => setPulling({ tag, pct, status }))
      toast.success(`Pulled ${tag}`)
      refresh()
    } catch (err) {
      toast.error(`Pull failed for ${tag}`, { description: String(err).slice(0, 140) })
    } finally {
      setPulling(null)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between rounded-lg bg-card/60 px-3 py-2">
        <span className="flex items-center gap-2 text-sm">
          <span
            className={cn(
              "size-2 rounded-full",
              health?.ok ? "bg-live" : "bg-destructive",
            )}
          />
          {health?.ok
            ? `Ollama ${health.version} connected`
            : "Ollama unreachable"}
          <span className="font-mono text-xs text-muted-foreground">
            {health?.url}
          </span>
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Refresh" onClick={refresh}>
          <RefreshCwIcon />
        </Button>
      </div>

      <Field>
        <FieldLabel htmlFor="active-model">Active model</FieldLabel>
        <Select value={settings?.model ?? ""} onValueChange={setActive}>
          <SelectTrigger id="active-model" className="w-full">
            <SelectValue placeholder="Pick a model" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Installed on this machine</SelectLabel>
              {chatModels.map((m) => (
                <SelectItem key={m.name} value={m.name}>
                  <span className="flex items-center gap-2">
                    {m.name}
                    <span className="font-mono text-xs text-muted-foreground">
                      {m.parameterSize}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>
          Runs extraction, buzz ratings, and curation. Embedding-only models are
          hidden.
        </FieldDescription>
      </Field>

      <Separator />

      <div className="flex flex-col gap-1">
        <h3 className="font-heading text-base font-semibold">Model catalog</h3>
        <p className="text-sm text-muted-foreground">
          Open-weights models you can pull into Ollama, grouped by lab.
          Metadata via models.dev.
        </p>
      </div>

      {!catalog && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {catalog?.map((company) => (
        <section key={company.id} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <ProviderLogo id={company.id} />
            <span className="text-sm font-medium">{company.name}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {company.models.map((m) => {
              const isInstalled = installedTags.has(m.tag)
              const isPulling = pulling?.tag === m.tag
              return (
                <div
                  key={m.tag}
                  className="flex flex-col gap-2 rounded-lg border px-3 py-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-2 text-sm">
                        {m.label}
                        {m.reasoning && (
                          <Badge variant="secondary" className="text-[10px]">
                            reasoning
                          </Badge>
                        )}
                        {m.vision && (
                          <Badge variant="secondary" className="text-[10px]">
                            vision
                          </Badge>
                        )}
                      </span>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {m.tag} · {m.downloadSize}
                        {m.context ? ` · ${Math.round(m.context / 1000)}k ctx` : ""}
                        {m.releaseDate ? ` · ${m.releaseDate}` : ""}
                      </span>
                    </div>
                    {isInstalled ? (
                      <Badge variant="outline" className="shrink-0 text-live">
                        Installed
                      </Badge>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={pulling !== null}
                        onClick={() => pull(m.tag)}
                      >
                        {isPulling ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <DownloadIcon data-icon="inline-start" />
                        )}
                        {isPulling ? "Pulling" : "Pull"}
                      </Button>
                    )}
                  </div>
                  {isPulling && (
                    <div className="flex items-center gap-2">
                      <Progress
                        value={pulling.pct >= 0 ? pulling.pct : null}
                        className="h-1.5"
                      />
                      <span className="w-24 shrink-0 truncate font-mono text-[10px] text-muted-foreground">
                        {pulling.pct >= 0 ? `${pulling.pct}%` : pulling.status}
                      </span>
                    </div>
                  )}
                  <p className="sr-only">{m.blurb}</p>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
