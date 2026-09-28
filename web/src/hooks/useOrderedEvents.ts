import { selectOrdered, selectSearched } from "@/lib/derived"
import { useGrapevine } from "@/lib/store"

/**
 * The event list as both surfaces (desktop rail, mobile dock) show it:
 * buzz-filtered, narrowed by the search box, ordered by the chosen sort key
 * (relevance by default), with pinned events floating to the top and keeping
 * that order among themselves.
 *
 * Both arrays come from the shared memoized selectors in lib/derived.ts, so
 * the two surfaces split one computation and keep the same reference across
 * clock ticks that don't change the outcome: no re-render, no re-sort.
 */
export function useOrderedEvents() {
  const visible = useGrapevine(selectSearched)
  const ordered = useGrapevine(selectOrdered)
  return { visible, ordered }
}
