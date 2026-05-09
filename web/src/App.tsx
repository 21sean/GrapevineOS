import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Toaster } from "@/components/ui/sonner"
import { Spinner } from "@/components/ui/spinner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AdminSheet } from "@/components/admin/AdminSheet"
import { CarouselOverlay, CAROUSEL_MS } from "@/components/CarouselOverlay"
import { EventDetail } from "@/components/EventDetail"
import { FilterRail } from "@/components/FilterRail"
import { InterestsDialog } from "@/components/InterestsDialog"
import { EventMap } from "@/components/map/EventMap"
import { TopBar } from "@/components/TopBar"
import { carouselEvents } from "@/lib/score"
import { useGrapevine } from "@/lib/store"

export function App() {
  const loaded = useGrapevine((s) => s.loaded)
  const load = useGrapevine((s) => s.load)
  const tick = useGrapevine((s) => s.tick)
  const setUserPos = useGrapevine((s) => s.setUserPos)
  const carouselOn = useGrapevine((s) => s.carouselOn)
  const events = useGrapevine((s) => s.events)
  const filters = useGrapevine((s) => s.filters)
  const interests = useGrapevine((s) => s.interests)
  const now = useGrapevine((s) => s.now)

  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    load().catch((err) => setLoadError(String(err)))
    // the OAuth callback bounces here with ?auth=failed when sign-in dies
    const params = new URLSearchParams(window.location.search)
    if (params.get("auth") === "failed") {
      toast.error("Google sign-in didn't complete. Try again.")
      params.delete("auth")
      const qs = params.toString()
      window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname)
    }
    const timer = setInterval(tick, 30_000)
    navigator.geolocation?.getCurrentPosition(
      (p) => setUserPos([p.coords.longitude, p.coords.latitude]),
      () => {},
      { maximumAge: 600_000 },
    )
    return () => clearInterval(timer)
  }, [load, tick, setUserPos])

  // the live tour: advance every CAROUSEL_MS while enabled
  const tourLength = useMemo(
    () => carouselEvents(events, filters, interests, now).length,
    [events, filters, interests, now],
  )
  useEffect(() => {
    if (!carouselOn || tourLength < 2) return
    const timer = setInterval(() => {
      const s = useGrapevine.getState()
      s.advanceCarousel((s.carouselIdx + 1) % tourLength)
    }, CAROUSEL_MS)
    return () => clearInterval(timer)
  }, [carouselOn, tourLength])

  if (!loaded) {
    return (
      <div className="flex h-svh flex-col items-center justify-center gap-4">
        <span className="font-heading text-3xl font-semibold italic">
          Grapevine
        </span>
        {loadError ? (
          <p className="max-w-sm text-center text-sm text-muted-foreground">
            The API isn't answering. Start it with{" "}
            <span className="font-mono text-foreground">npm run dev</span> at
            the project root, then reload.
          </p>
        ) : (
          <Spinner className="size-5" />
        )}
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={250}>
      <div className="relative h-svh w-full overflow-hidden">
        <EventMap />
        <TopBar />
        <FilterRail />
        <CarouselOverlay />
        <EventDetail />
        <InterestsDialog />
        <AdminSheet />
        <Toaster theme="dark" position="bottom-right" />
      </div>
    </TooltipProvider>
  )
}

export default App
