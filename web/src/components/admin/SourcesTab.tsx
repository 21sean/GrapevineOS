import { CopyIcon } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useGrapevine } from "@/lib/store"

export function SourcesTab() {
  const sources = useGrapevine((s) => s.sources)

  function copy(address: string) {
    navigator.clipboard
      .writeText(address)
      .then(() => toast.success("Address copied", { description: address }))
      .catch(() => toast.error("Couldn't copy — clipboard blocked"))
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Every address below works automatically — Cloudflare Email Routing's
        catch-all accepts anything at{" "}
        <span className="font-mono text-foreground">@sean.ventures</span>.
        Subscribe to each newsletter with its own address and the{" "}
        <span className="font-mono">To:</span> field tells the pipeline exactly
        where an event came from. No API fees, ever.
      </p>

      <div className="flex flex-col gap-2">
        {sources.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
          >
            <span
              className={
                s.active
                  ? "size-2 shrink-0 rounded-full bg-live"
                  : "size-2 shrink-0 rounded-full bg-muted-foreground/40"
              }
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-2 text-sm font-medium">
                {s.name}
                <Badge variant="secondary" className="text-[10px] font-normal">
                  {s.kind}
                </Badge>
              </span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {s.address}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {s.note}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Copy ${s.address}`}
              onClick={() => copy(s.address)}
            >
              <CopyIcon />
            </Button>
          </div>
        ))}
      </div>

      <Alert>
        <AlertTitle>Hands-free ingestion</AlertTitle>
        <AlertDescription>
          The Cloudflare Email Worker in <span className="font-mono">workers/email-ingest</span>{" "}
          parses incoming newsletters and posts them to this app's ingest
          endpoint. Deploy steps are in the README — until then, paste emails
          in the Ingest tab.
        </AlertDescription>
      </Alert>
    </div>
  )
}
