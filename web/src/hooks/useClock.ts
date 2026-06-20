import { useGrapevine } from "@/lib/store"

/**
 * The store's shared 30s clock, subscribed only while `active`. Inactive
 * consumers (closed dialogs/panels) keep rendering with the moment they froze
 * at — right for a close animation — and skip the twice-a-minute re-render
 * entirely until they're opened again.
 */
export function useClock(active: boolean = true): Date {
  const ticking = useGrapevine((s) => (active ? s.now : null))
  return ticking ?? useGrapevine.getState().now
}
