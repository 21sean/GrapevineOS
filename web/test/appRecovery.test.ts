// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"

const auth = vi.hoisted(() => ({
  listener: null as
    null | ((event: string, session: { user: { id: string } }) => void),
  unsubscribe: vi.fn(),
}))
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: null },
        error: new Error("Session unavailable"),
      }),
      onAuthStateChange: (callback: typeof auth.listener) => {
        auth.listener = callback
        return { data: { subscription: { unsubscribe: auth.unsubscribe } } }
      },
    },
  },
}))
vi.mock("@/components/map/EventMap", () => ({ EventMap: () => null }))
vi.mock("@/hooks/useNearZone", () => ({ useNearZone: () => {} }))
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }))
vi.mock("sonner", () => ({ toast: { error: vi.fn() }, Toaster: () => null }))
import { App } from "@/App"
import { toast } from "sonner"
import { useGrapevine } from "@/lib/store"

it("recovers bootstrap failures and handles deferred auth/session errors", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const original = useGrapevine.getState()
  const load = vi.fn().mockRejectedValue(new Error("Connection unavailable"))
  useGrapevine.setState({ loaded: false, user: null, userPos: null, load })
  window.history.replaceState(null, "", "/?calendar=oauth")
  const host = document.createElement("div")
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(App)))
    expect(host.textContent).toContain("Events couldn't load")
    expect(toast.error).toHaveBeenCalledWith(
      "Google Calendar didn't connect",
      expect.any(Object)
    )
    const calls = load.mock.calls.length
    auth.listener!("SIGNED_IN", { user: { id: "test-user" } })
    expect(load).toHaveBeenCalledTimes(calls)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(toast.error).toHaveBeenCalledWith(
      "Your account couldn't refresh",
      expect.any(Object)
    )
    load.mockResolvedValue(undefined)
    await act(async () =>
      host
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }))
    )
    expect(host.textContent).not.toContain("Events couldn't load")
    expect(host.querySelector('[aria-label="Loading events"]')).not.toBeNull()
  } finally {
    act(() => root.unmount())
    useGrapevine.setState(original, true)
    window.history.replaceState(null, "", "/")
    vi.unstubAllGlobals()
  }
})
