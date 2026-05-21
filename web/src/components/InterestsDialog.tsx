import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useGrapevine } from "@/lib/store"
import { INTEREST_TOPICS } from "@/lib/types"

export function InterestsDialog() {
  const open = useGrapevine((s) => s.interestsOpen)
  const setOpen = useGrapevine((s) => s.setInterestsOpen)
  const interests = useGrapevine((s) => s.interests)
  const setInterests = useGrapevine((s) => s.setInterests)

  const [loves, setLoves] = useState<string[]>(interests.loves)
  const [avoids, setAvoids] = useState<string[]>(interests.avoids)

  useEffect(() => {
    if (open) {
      setLoves(interests.loves)
      setAvoids(interests.avoids)
    }
  }, [open, interests])

  function save() {
    setInterests({ loves, avoids })
    setOpen(false)
    toast.success("Interests saved", {
      description:
        avoids.length > 0
          ? `Hiding ${avoids.join(", ")} from your map.`
          : "Your feed is re-ranked.",
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-heading text-xl">
            What are you into?
          </DialogTitle>
          <DialogDescription>
            The map re-ranks around your picks. Anything under “less of this”
            disappears entirely.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[55vh] flex-col gap-6 overflow-y-auto py-1">
          <FieldSet>
            <FieldLegend>More like this</FieldLegend>
            <FieldDescription>
              Floats matching events to the top of the feed and the tour.
            </FieldDescription>
            <ToggleGroup
              type="multiple"
              variant="outline"
              size="sm"
              className="flex-wrap justify-start"
              value={loves}
              onValueChange={(v) => {
                setLoves(v)
                setAvoids((a) => a.filter((t) => !v.includes(t)))
              }}
            >
              {INTEREST_TOPICS.map((t) => (
                <ToggleGroupItem
                  key={t}
                  value={t}
                  className="rounded-full px-3 data-[state=on]:border-live/60 data-[state=on]:text-live"
                >
                  {t}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FieldSet>

          <FieldSet>
            <FieldLegend>Less of this</FieldLegend>
            <FieldDescription>
              Hidden completely. You'll never see these on the map.
            </FieldDescription>
            <ToggleGroup
              type="multiple"
              variant="outline"
              size="sm"
              className="flex-wrap justify-start"
              value={avoids}
              onValueChange={(v) => {
                setAvoids(v)
                setLoves((l) => l.filter((t) => !v.includes(t)))
              }}
            >
              {INTEREST_TOPICS.map((t) => (
                <ToggleGroupItem
                  key={t}
                  value={t}
                  className="rounded-full px-3 data-[state=on]:border-destructive/60 data-[state=on]:text-destructive data-[state=on]:line-through"
                >
                  {t}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FieldSet>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={save}>Save interests</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
