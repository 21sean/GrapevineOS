import { useMemo, useState } from "react"
import { CarFrontIcon, HeartIcon, Settings2Icon } from "lucide-react"
import { AccountDialog } from "@/components/AccountDialog"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useGrapevine } from "@/lib/store"
import { isLive } from "@/lib/time"
import { cn } from "@/lib/utils"

export function TopBar() {
  const settings = useGrapevine((s) => s.settings)
  const events = useGrapevine((s) => s.events)
  const now = useGrapevine((s) => s.now)
  const trafficOn = useGrapevine((s) => s.trafficOn)
  const setTraffic = useGrapevine((s) => s.setTraffic)
  const setInterestsOpen = useGrapevine((s) => s.setInterestsOpen)
  const setAdminOpen = useGrapevine((s) => s.setAdminOpen)
  const user = useGrapevine((s) => s.user)
  const [accountOpen, setAccountOpen] = useState(false)

  const liveCount = useMemo(
    () => events.filter((e) => isLive(e, now)).length,
    [events, now],
  )

  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-4 p-4">
      <div className="glass pointer-events-auto flex h-11 items-center gap-3 rounded-full px-4">
        <span className="font-heading text-lg font-semibold italic tracking-tight">
          Grapevine
        </span>
        <Separator orientation="vertical" className="!h-4" />
        <span className="text-sm text-muted-foreground">{settings?.city}</span>
        <Separator orientation="vertical" className="!h-4" />
        <span className="inline-flex items-center gap-1.5 font-mono text-xs">
          <span
            className={cn(
              "size-2 rounded-full",
              liveCount ? "animate-pulse bg-live" : "bg-muted-foreground/50",
            )}
          />
          {liveCount} live now
        </span>
      </div>

      <div className="glass pointer-events-auto flex h-11 items-center gap-1 rounded-full px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full"
              onClick={() => setInterestsOpen(true)}
            >
              <HeartIcon data-icon="inline-start" />
              Interests
            </Button>
          </TooltipTrigger>
          <TooltipContent>Tune what floats to the top</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={trafficOn ? "secondary" : "ghost"}
              size="sm"
              className="rounded-full"
              onClick={() => setTraffic(!trafficOn)}
            >
              <CarFrontIcon data-icon="inline-start" />
              Traffic
            </Button>
          </TooltipTrigger>
          <TooltipContent>Show live congestion on the map</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              aria-label="Admin"
              onClick={() => setAdminOpen(true)}
            >
              <Settings2Icon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Admin: models, ingestion, sources</TooltipContent>
        </Tooltip>
        <Separator orientation="vertical" className="!h-4" />
        {user ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Account"
                className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setAccountOpen(true)}
              >
                <img
                  src={user.picture}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="size-7 rounded-full border border-border"
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>{user.name}</TooltipContent>
          </Tooltip>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full"
            onClick={() => window.location.assign("/auth/google")}
          >
            <GoogleIcon />
            Sign in
          </Button>
        )}
      </div>

      {user && (
        <AccountDialog open={accountOpen} onOpenChange={setAccountOpen} />
      )}
    </header>
  )
}

/** Google "G" in brand colors, sized to match lucide icons. */
function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" data-icon="inline-start">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}
