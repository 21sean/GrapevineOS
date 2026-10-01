// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
vi.mock("@/lib/api", () => ({
  api: { eta: vi.fn(async () => ({ minutes: 12, km: 4 })) },
}))
vi.mock("@/lib/supabase", () => ({ supabase: null }))
import { api } from "@/lib/api"
import { useEta } from "@/hooks/useEta"
import { useGrapevine } from "@/lib/store"
import type { CityEvent } from "@/lib/types"

it("shares concurrent venue ETAs and refreshes when coordinates change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  useGrapevine.setState({ userPos: null, settings: null })
  const el = document.createElement("div")
  const root = createRoot(el)
  function View({ lng }: { lng: number }) {
    const a = useEta({ id: "a", lng, lat: 32.799 } as CityEvent)
    const b = useEta({ id: "b", lng, lat: 32.799 } as CityEvent)
    return createElement("span", null, `${a?.minutes}/${b?.minutes}`)
  }
  try {
    await act(async () => root.render(createElement(View, { lng: -117.199 })))
    expect(api.eta).toHaveBeenCalledTimes(1)
    expect(el.textContent).toBe("12/12")
    await act(async () => root.render(createElement(View, { lng: -117.299 })))
    expect(api.eta).toHaveBeenCalledTimes(2)
    expect(api.eta).toHaveBeenLastCalledWith([-117.299, 32.799], undefined)
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
