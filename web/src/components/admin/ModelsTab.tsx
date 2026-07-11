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
import { Spinner } from "@/components/ui/spinner"
import { ProviderLogo } from "@/components/admin/ProviderLogo"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import { cn } from "@/lib/utils"

type Installed = Awaited<ReturnType<typeof api.ollamaModels>>[number]
type Catalog = Awaited<ReturnType<typeof api.catalog>>
type Hardware = Awaited<ReturnType<typeof api.system>>

type Fit = "gpu" | "cpu" | "no"

const FIT: Record<Fit, { dot: string; label: string }> = {
  gpu: { dot: "bg-emerald-500", label: "runs on your GPU" },
  cpu: { dot: "bg-amber-500", label: "runs slowly (CPU offload)" },
  no: { dot: "bg-destructive", label: "too big for this PC" },
}

/** Quantized weights + KV-cache headroom vs detected memory. */
function fitFor(sizeGB: number, hw: Hardware | null): Fit | null {
  if (!hw) return null
  const need = sizeGB * 1.1 + 1.5
  if (hw.vramGB && need <= hw.vramGB) return "gpu"
  if (need <= hw.ramGB * 0.9) return "cpu"
  return "no"
}

function fitSentence(fit: Fit | null, hw: Hardware | null): string {
  if (!fit || !hw) return ""
  const gpu = hw.unifiedMemory
    ? `${hw.vramGB} GB unified memory`
    : `${hw.vramGB} GB GPU`
  if (fit === "gpu") return `Fits your ${gpu}.`
  if (fit === "cpu")
    return hw.vramGB
      ? `Exceeds your ${gpu} — will offload to RAM and run slowly.`
      : `No GPU detected — runs from ${hw.ramGB} GB RAM, slowly.`
  return `Too big for this PC (${hw.ramGB} GB RAM).`
}

export function ModelsTab() {
  const settings = useGrapevine((s) => s.settings)
  const setSettings = useGrapevine((s) => s.setSettings)

  const [health, setHealth] = useState<{ ok: boolean; url: string; version: string | null } | null>(null)
  const [installed, setInstalled] = useState<Installed[] | null>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [system, setSystem] = useState<Hardware | null>(null)
  const [selectedTag, setSelectedTag] = useState("")
  const [pulling, setPulling] = useState<{ tag: string; pct: number; status: string } | null>(null)

  const refresh = useCallback(() => {
    api.ollamaHealth().then(setHealth).catch(() => setHealth(null))
    api.ollamaModels().then(setInstalled).catch(() => setInstalled([]))
  }, [])

  useEffect(() => {
    refresh()
    api.catalog().then(setCatalog).catch(() => setCatalog([]))
    api.system().then(setSystem).catch(() => setSystem(null))
  }, [refresh])

  const chatModels = (installed ?? []).filter(
    (m) => !m.capabilities.length || m.capabilities.includes("completion"),
  )
  const installedTags = new Set((installed ?? []).map((m) => m.name.replace(/:latest$/, "")))
  const selected = catalog?.flatMap((c) => c.models).find((m) => m.tag === selectedTag)

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
          Open-weights models released since January 2026 that Ollama can pull,
          straight from models.dev and the Ollama registry.
        </p>
        <p className="text-xs text-muted-foreground">
          {system
            ? `This PC: ${system.gpu ?? "no GPU detected"}${
                system.vramGB
                  ? ` · ${system.vramGB} GB ${system.unifiedMemory ? "unified memory" : "VRAM"}`
                  : ""
              } · ${system.ramGB} GB RAM`
            : "Detecting hardware…"}
        </p>
      </div>

      <Field>
        <FieldLabel htmlFor="catalog-model">Pull a model</FieldLabel>
        {/* minmax(0,1fr): the long nowrap value must not inflate the sheet's
            scroll-area table wrapper */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <Select value={selectedTag} onValueChange={setSelectedTag}>
            <SelectTrigger id="catalog-model" className="w-full">
              <SelectValue
                placeholder={catalog ? "Browse the catalog" : "Loading catalog…"}
              />
            </SelectTrigger>
            <SelectContent>
              {catalog?.map((company) => (
                <SelectGroup key={company.id}>
                  <SelectLabel className="flex items-center gap-2">
                    <ProviderLogo id={company.id} className="size-4" />
                    {company.name}
                  </SelectLabel>
                  {company.models.map((m) => {
                    const fit = fitFor(m.sizeGB, system)
                    return (
                      <SelectItem key={m.tag} value={m.tag}>
                        <span className="flex items-center gap-2">
                          {fit && (
                            <span
                              title={FIT[fit].label}
                              aria-label={FIT[fit].label}
                              className={cn(
                                "size-2 shrink-0 rounded-full",
                                FIT[fit].dot,
                              )}
                            />
                          )}
                          {m.label}
                          <span className="font-mono text-xs text-muted-foreground">
                            {m.downloadSize}
                            {m.context
                              ? ` · ${Math.round(m.context / 1000)}k ctx`
                              : ""}
                            {m.releaseDate ? ` · ${m.releaseDate}` : ""}
                          </span>
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
                          {installedTags.has(m.tag) && (
                            <Badge variant="outline" className="text-[10px] text-live">
                              installed
                            </Badge>
                          )}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            className="shrink-0"
            disabled={
              !selected || pulling !== null || installedTags.has(selected.tag)
            }
            onClick={() => selected && pull(selected.tag)}
          >
            {pulling ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <DownloadIcon data-icon="inline-start" />
            )}
            {selected && installedTags.has(selected.tag)
              ? "Installed"
              : pulling
                ? "Pulling"
                : "Pull"}
          </Button>
        </div>
        <FieldDescription>
          {selected
            ? [
                selected.blurb &&
                  (/[.!?]$/.test(selected.blurb)
                    ? selected.blurb
                    : `${selected.blurb}.`),
                fitSentence(fitFor(selected.sizeGB, system), system),
              ]
                .filter(Boolean)
                .join(" ")
            : "Pick a model to see whether it fits this machine."}
        </FieldDescription>
      </Field>

      {pulling && (
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
    </div>
  )
}
