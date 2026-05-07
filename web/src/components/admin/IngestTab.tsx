import { useState } from "react"
import { FlaskConicalIcon, MailPlusIcon, SparklesIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { StarRating } from "@/components/StarRating"
import { api } from "@/lib/api"
import { useGrapevine } from "@/lib/store"
import { CATEGORY_META, type CityEvent } from "@/lib/types"

const SAMPLE_EMAIL = `Subject: ☀️ SDtoday: Your 4th of July weekend guide

Happy Thursday, San Diego! Here's what we're eyeing this weekend:

🎆 SATURDAY | Big Bay Boom — the West Coast's largest fireworks show
lights up San Diego Bay at 9pm. Free viewing from Embarcadero,
Shelter Island, and Coronado Ferry Landing.

🌮 SATURDAY 11am-9pm | Barrio Logan Taco & Mariachi Festival at
Chicano Park. $5 entry, 30+ taco stands, lucha libre at 3pm.
Tickets at the gate or on Eventbrite.

🏃 FRIDAY 6pm | Twilight Trail Run at Mission Trails Regional Park.
Free group run, 5 miles, all paces. Meet at the visitor center.

🎶 SUNDAY 2-6pm | Free reggae in the park: Iration side project plays
Waterfront Park's summer series. Lawn opens at noon.`

export function IngestTab() {
  const sources = useGrapevine((s) => s.sources)
  const refreshEvents = useGrapevine((s) => s.refreshEvents)
  const settings = useGrapevine((s) => s.settings)

  const [source, setSource] = useState("sdtoday")
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<CityEvent[] | null>(null)
  const [included, setIncluded] = useState<Set<string>>(new Set())

  async function extract() {
    setBusy(true)
    setPreview(null)
    try {
      const res = await api.ingestEmail(text, source, true)
      setPreview(res.events)
      setIncluded(new Set(res.events.map((e) => e.id)))
      if (!res.events.length) {
        toast.info("No events found in that email")
      }
    } catch (err) {
      toast.error("Extraction failed", { description: String(err).slice(0, 180) })
    } finally {
      setBusy(false)
    }
  }

  async function commit() {
    if (!preview) return
    const chosen = preview.filter((e) => included.has(e.id))
    try {
      const res = await api.commitEvents(chosen)
      await refreshEvents()
      toast.success(`Added ${res.added} event${res.added === 1 ? "" : "s"} to the map`)
      setPreview(null)
      setText("")
    } catch (err) {
      toast.error("Couldn't save events", { description: String(err).slice(0, 140) })
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="ingest-source">Source</FieldLabel>
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger id="ingest-source" className="w-full">
              <SelectValue placeholder="Which newsletter is this from?" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {sources.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor="ingest-text">Newsletter email</FieldLabel>
          <Textarea
            id="ingest-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the raw text of a newsletter email…"
            className="min-h-40 font-mono text-xs"
          />
          <FieldDescription>
            {settings?.model
              ? `Extracted locally by ${settings.model} — nothing leaves your machine.`
              : "Pick a model in the Models tab first."}
          </FieldDescription>
        </Field>

        <div className="flex items-center gap-2">
          <Button onClick={extract} disabled={busy || !text.trim()}>
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <SparklesIcon data-icon="inline-start" />
            )}
            {busy ? "Reading the newsletter…" : "Extract events"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setText(SAMPLE_EMAIL)}
            disabled={busy}
          >
            <FlaskConicalIcon data-icon="inline-start" />
            Try a sample
          </Button>
        </div>
      </FieldGroup>

      {preview && preview.length > 0 && (
        <>
          <Separator />
          <div className="flex flex-col gap-3">
            <span className="text-sm text-muted-foreground">
              Found {preview.length} event{preview.length === 1 ? "" : "s"} —
              geocoded and rated. Uncheck any you don't want.
            </span>
            {preview.map((e) => (
              <div key={e.id} className="flex items-start gap-3 rounded-lg border p-3">
                <Switch
                  checked={included.has(e.id)}
                  onCheckedChange={(on) => {
                    setIncluded((prev) => {
                      const next = new Set(prev)
                      if (on) next.add(e.id)
                      else next.delete(e.id)
                      return next
                    })
                  }}
                  aria-label={`Include ${e.title}`}
                />
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-medium">{e.title}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {new Date(e.start).toLocaleString()} · {e.venue}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="secondary"
                      style={{ color: CATEGORY_META[e.category]?.color }}
                    >
                      {CATEGORY_META[e.category]?.label ?? e.category}
                    </Badge>
                    <StarRating rating={e.rating} showNumber />
                    {e.promoted && <Badge variant="destructive">promoted</Badge>}
                    <span className="font-mono text-xs text-muted-foreground">
                      {e.price}
                    </span>
                  </div>
                  {e.ratingRationale && (
                    <span className="text-xs text-muted-foreground italic">
                      “{e.ratingRationale}”
                    </span>
                  )}
                </div>
              </div>
            ))}
            <Button onClick={commit} disabled={included.size === 0}>
              <MailPlusIcon data-icon="inline-start" />
              Add {included.size} to the map
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
