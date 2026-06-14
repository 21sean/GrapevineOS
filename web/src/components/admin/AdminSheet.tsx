import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { InboxTab } from "@/components/admin/InboxTab"
import { IngestTab } from "@/components/admin/IngestTab"
import { ModelsTab } from "@/components/admin/ModelsTab"
import { ProvidersTab } from "@/components/admin/ProvidersTab"
import { SourcesTab } from "@/components/admin/SourcesTab"
import { useGrapevine } from "@/lib/store"

export function AdminSheet() {
  const open = useGrapevine((s) => s.adminOpen)
  const setOpen = useGrapevine((s) => s.setAdminOpen)
  const settings = useGrapevine((s) => s.settings)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="font-heading text-xl">Admin</SheetTitle>
          <SheetDescription>
            {settings?.city} · local pipeline, no paid event APIs
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          <Tabs defaultValue="models">
            <TabsList className="w-full">
              <TabsTrigger value="models">Models</TabsTrigger>
              <TabsTrigger value="providers">Providers</TabsTrigger>
              <TabsTrigger value="ingest">Ingest</TabsTrigger>
              <TabsTrigger value="inbox">Inbox</TabsTrigger>
              <TabsTrigger value="sources">Sources</TabsTrigger>
            </TabsList>
            <TabsContent value="models" className="pt-4">
              <ModelsTab />
            </TabsContent>
            <TabsContent value="providers" className="pt-4">
              <ProvidersTab />
            </TabsContent>
            <TabsContent value="ingest" className="pt-4">
              <IngestTab />
            </TabsContent>
            <TabsContent value="inbox" className="pt-4">
              <InboxTab />
            </TabsContent>
            <TabsContent value="sources" className="pt-4">
              <SourcesTab />
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  )
}
