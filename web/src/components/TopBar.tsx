import { useState } from "react"
import {
  CalendarDaysIcon,
  HeartIcon,
  LogInIcon,
  NewspaperIcon,
  Settings2Icon,
  SparklesIcon,
} from "lucide-react"
import { AccountDialog } from "@/components/AccountDialog"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { selectLiveCount } from "@/lib/derived"
import { useGrapevine } from "@/lib/store"
import { cn } from "@/lib/utils"

export function TopBar() {
  const city = useGrapevine((s) => s.settings?.city)
  // A number, not (events, now): the bar re-renders when the count changes,
  // not twice a minute for every clock tick.
  const liveCount = useGrapevine(selectLiveCount)
  const setInterestsOpen = useGrapevine((s) => s.setInterestsOpen)
  const setAdminOpen = useGrapevine((s) => s.setAdminOpen)
  const setAskOpen = useGrapevine((s) => s.setAskOpen)
  const setCalendarOpen = useGrapevine((s) => s.setCalendarOpen)
  const setWeekOpen = useGrapevine((s) => s.setWeekOpen)
  const setSignInOpen = useGrapevine((s) => s.setSignInOpen)
  const user = useGrapevine((s) => s.user)
  const [accountOpen, setAccountOpen] = useState(false)

  return (
    // Safe-area maxes keep the pills clear of the notch and rounded corners
    // when the app runs full-bleed (viewport-fit=cover / add-to-home-screen).
    <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 pt-[max(env(safe-area-inset-top),0.75rem)] pr-[max(env(safe-area-inset-right),0.75rem)] pl-[max(env(safe-area-inset-left),0.75rem)] sm:gap-4 sm:pt-4 sm:pr-4 sm:pl-4">
      <div className="glass pointer-events-auto flex h-11 items-center gap-2.5 rounded-full px-3.5 sm:gap-3 sm:px-4">
        <span className="font-heading text-base font-semibold italic tracking-tight sm:text-lg">
          Grapevine
        </span>
        {/* the city is ambient context — the live count earns the phone space */}
        <Separator orientation="vertical" className="!h-4 max-sm:hidden" />
        <span className="text-sm text-muted-foreground max-sm:hidden">
          {city}
        </span>
        <Separator orientation="vertical" className="!h-4" />
        <span className="inline-flex items-center gap-1.5 font-mono text-xs whitespace-nowrap">
          <span
            className={cn(
              "size-2 rounded-full",
              liveCount ? "animate-pulse bg-live" : "bg-muted-foreground/50",
            )}
          />
          {liveCount} live<span className="max-sm:hidden"> now</span>
        </span>
      </div>

      {/* The agent entry point doubles as the app's search box. */}
      <button
        type="button"
        onClick={() => setAskOpen(true)}
        className="glass pointer-events-auto hidden h-11 min-w-0 max-w-md flex-1 items-center gap-2.5 rounded-full px-4 text-sm text-muted-foreground transition-colors hover:text-foreground sm:flex"
      >
        <SparklesIcon className="size-4 shrink-0 text-wine" />
        <span className="truncate">Ask Grapevine</span>
        <kbd className="ml-auto rounded border border-border bg-secondary/60 px-1.5 py-0.5 font-mono text-[10px]">
          {navigator.userAgent.includes("Mac") ? "⌘K" : "Ctrl K"}
        </kbd>
      </button>

      <div className="glass pointer-events-auto flex h-11 items-center gap-1 rounded-full px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-full sm:hidden"
          aria-label="Ask Grapevine"
          onClick={() => setAskOpen(true)}
        >
          <SparklesIcon className="text-wine" />
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full max-sm:size-8 max-sm:p-0"
              aria-label="Interests"
              onClick={() => setInterestsOpen(true)}
            >
              <HeartIcon data-icon="inline-start" />
              <span className="max-sm:hidden">Interests</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Tune what floats to the top</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              aria-label="Your week"
              onClick={() => setWeekOpen(true)}
            >
              <NewspaperIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Your week — top picks by your taste</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              aria-label="Your calendar"
              onClick={() => setCalendarOpen(true)}
            >
              <CalendarDaysIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Your Google Calendar, right here</TooltipContent>
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
            onClick={() => setSignInOpen(true)}
          >
            <LogInIcon data-icon="inline-start" />
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
