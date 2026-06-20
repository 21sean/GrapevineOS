import { lazy, Suspense, useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Toaster } from "@/components/ui/sonner"
import { Spinner } from "@/components/ui/spinner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AgentChat } from "@/components/AgentChat"
import { CarouselOverlay, CAROUSEL_MS } from "@/components/CarouselOverlay"
import { EventDetail } from "@/components/EventDetail"
import { FilterRail } from "@/components/FilterRail"
import { InterestsDialog } from "@/components/InterestsDialog"
import { EventMap } from "@/components/map/EventMap"
import { MobileDock } from "@/components/MobileDock"
import { TopBar } from "@/components/TopBar"
import { useIsMobile } from "@/hooks/useIsMobile"
import { selectTour } from "@/lib/derived"
import { useGrapevine } from "@/lib/store"

// Operator-only chrome — load its chunk on first open instead of shipping it
// to every visitor.
const AdminSheet = lazy(() =>
  import("@/components/admin/AdminSheet").then((m) => ({ default: m.AdminSheet })),
)

// Same deal for the Google Calendar popup (react-day-picker et al.).
const CalendarDialog = lazy(() =>
  import("@/components/calendar/CalendarDialog").then((m) => ({
    default: m.CalendarDialog,
  })),
)

export function App() {
  const loaded = useGrapevine((s) => s.loaded)
  const load = useGrapevine((s) => s.load)
  const tick = useGrapevine((s) => s.tick)
  const setUserPos = useGrapevine((s) => s.setUserPos)
  const carouselOn = useGrapevine((s) => s.carouselOn)
  const adminOpen = useGrapevine((s) => s.adminOpen)
  const calendarOpen = useGrapevine((s) => s.calendarOpen)
  // Length only — App must not re-render (and fan out to the whole tree) on
  // every clock tick just because the tour's membership was recomputed.
  const tourLength = useGrapevine((s) => selectTour(s).length)

  const [loadError, setLoadError] = useState<string | null>(null)
  const isMobile = useIsMobile()
  // Latch so the sheet stays mounted after closing — otherwise the close
  // animation would be cut off when adminOpen flips false. Render-phase
  // state adjustment, per the React docs (same pattern as AccountDialog).
  const [adminEverOpened, setAdminEverOpened] = useState(false)
  if (adminOpen && !adminEverOpened) setAdminEverOpened(true)
  const [calendarEverOpened, setCalendarEverOpened] = useState(false)
  if (calendarOpen && !calendarEverOpened) setCalendarEverOpened(true)

  useEffect(() => {
    load().catch((err) => setLoadError(String(err)))
    // the OAuth callbacks bounce here with ?auth= / ?calendar= status params
    const params = new URLSearchParams(window.location.search)
    if (params.get("auth") === "failed") {
      toast.error("Google sign-in didn't complete. Try again.")
    }
    if (params.get("calendar") === "connected") {
      toast.success("Google Calendar connected", {
        description: "Events you save now sync automatically.",
      })
    } else if (params.get("calendar") === "failed") {
      toast.error("Google Calendar didn't connect. Try again from your account.")
    }
    if (params.has("auth") || params.has("calendar")) {
      params.delete("auth")
      params.delete("calendar")
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
  useEffect(() => {
    if (!carouselOn || tourLength < 2) return
    const timer = setInterval(() => {
      if (document.hidden) return // don't burn battery touring a hidden tab
      const s = useGrapevine.getState()
      s.advanceCarousel((s.carouselIdx + 1) % tourLength)
    }, CAROUSEL_MS)
    return () => clearInterval(timer)
  }, [carouselOn, tourLength])

  return (
    <TooltipProvider delayDuration={250}>
      {/* dvh so the layout tracks Safari's collapsing toolbar; nothing sits in
          a dead strip when the browser chrome animates away. */}
      <div className="relative h-dvh w-full overflow-hidden">
        {/* Map mounts immediately so WebGL init, style download, and tile
            fetches run in parallel with the API calls instead of behind them. */}
        <EventMap />
        {loaded ? (
          <>
            <TopBar />
            {isMobile ? <MobileDock /> : <FilterRail />}
            <CarouselOverlay />
            <EventDetail />
            <InterestsDialog />
            <AgentChat />
            {(adminOpen || adminEverOpened) && (
              <Suspense fallback={null}>
                <AdminSheet />
              </Suspense>
            )}
            {(calendarOpen || calendarEverOpened) && (
              <Suspense fallback={null}>
                <CalendarDialog />
              </Suspense>
            )}
          </>
        ) : (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-background/60">
            <span className="font-heading text-3xl font-semibold italic">
              Grapevine
            </span>
            {loadError ? (
              <>
                <p className="max-w-sm text-center text-sm text-muted-foreground">
                  The API isn't answering. Start it with{" "}
                  <span className="font-mono text-foreground">npm run dev</span>{" "}
                  at the project root.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setLoadError(null)
                    load().catch((err) => setLoadError(String(err)))
                  }}
                >
                  Try again
                </Button>
              </>
            ) : (
              <Spinner className="size-5" />
            )}
          </div>
        )}
        {/* bottom-right is dock territory on phones — toast at the top there */}
        <Toaster theme="dark" position={isMobile ? "top-center" : "bottom-right"} />
      </div>
    </TooltipProvider>
  )
}

export default App
