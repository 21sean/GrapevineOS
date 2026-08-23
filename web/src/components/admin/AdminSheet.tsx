import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DiscoveryTab } from "@/components/admin/DiscoveryTab"
import { EvalsTab } from "@/components/admin/EvalsTab"
import { GuardrailsTab } from "@/components/admin/GuardrailsTab"
import { InboxTab } from "@/components/admin/InboxTab"
import { ModelsTab } from "@/components/admin/ModelsTab"
import { ProvidersTab } from "@/components/admin/ProvidersTab"
import { SourcesTab } from "@/components/admin/SourcesTab"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useGrapevine } from "@/lib/store"
import { cn } from "@/lib/utils"

const TABS = [
  { value: "models", label: "Models", Panel: ModelsTab },
  { value: "providers", label: "Providers", Panel: ProvidersTab },
  { value: "discover", label: "Discover", Panel: DiscoveryTab },
  { value: "inbox", label: "Inbox", Panel: InboxTab },
  { value: "sources", label: "Sources", Panel: SourcesTab },
  { value: "evals", label: "Evals", Panel: EvalsTab },
  { value: "guardrails", label: "Guardrails", Panel: GuardrailsTab },
] as const

export function AdminSheet() {
  const open = useGrapevine((s) => s.adminOpen)
  const setOpen = useGrapevine((s) => s.setAdminOpen)
  const settings = useGrapevine((s) => s.settings)
  const isMobile = useIsMobile()

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {/* Same floating-glass shell as the event detail panel: phones get an
          iOS-style bottom sheet, desktop floats a rounded glass panel inset
          from the map edges. The header and tab bar stay pinned; only the
          active tab scrolls. */}
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        showCloseButton={false}
        style={
          isMobile
            ? undefined
            : { width: "34rem", maxWidth: "calc(100vw - 1.5rem)" }
        }
        className={cn(
          "glass flex flex-col gap-0 bg-background/70 p-0 overflow-hidden",
          isMobile
            ? "max-h-[90svh] rounded-t-2xl border-b-0 pb-[env(safe-area-inset-bottom)]"
            : "rounded-xl data-[side=right]:inset-y-3 data-[side=right]:right-3 data-[side=right]:h-auto data-[side=right]:border",
        )}
      >
        {/* accent wash: admin is lit by the wine hue that marks the brand's
            control chrome, the way an event is lit by its category color */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-24"
          style={{
            background:
              "linear-gradient(to bottom, color-mix(in oklab, var(--wine) 16%, transparent), transparent)",
          }}
        />

        {isMobile && (
          <div
            aria-hidden
            className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/40"
          />
        )}

        <SheetHeader className="relative shrink-0 gap-1 px-5 pt-5 pb-4">
          <span className="font-mono text-[11px] tracking-[0.18em] text-wine uppercase">
            {settings?.city ?? "Local"}
          </span>
          <SheetTitle className="font-heading text-2xl leading-tight font-semibold">
            Admin
          </SheetTitle>
          <SheetDescription>
            Local pipeline · no paid event APIs
          </SheetDescription>
        </SheetHeader>

        <SheetClose asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-3 right-3 z-20"
          >
            <XIcon />
            <span className="sr-only">Close admin</span>
          </Button>
        </SheetClose>

        <Tabs
          defaultValue="models"
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="shrink-0 border-b border-border/60 px-5 pb-3">
            {/* horizontally scrollable so the tabs never cram; scrollbar hidden */}
            <TabsList className="w-full justify-start overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {isMobile ? (
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
              {TABS.map(({ value, Panel }) => (
                <TabsContent key={value} value={value}>
                  <Panel />
                </TabsContent>
              ))}
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-5 py-4">
                {TABS.map(({ value, Panel }) => (
                  <TabsContent key={value} value={value}>
                    <Panel />
                  </TabsContent>
                ))}
              </div>
            </ScrollArea>
          )}
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}
