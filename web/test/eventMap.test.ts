// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.hoisted(() => vi.stubEnv("VITE_MAPBOX_TOKEN", "test-token"))
vi.mock("@/lib/api", () => ({ api: {} }))
vi.mock("@/lib/supabase", () => ({ supabase: null }))

const { markers, maps, FakeMarker, FakeMap } = vi.hoisted(() => {
  class FakeMap {
    container: HTMLElement
    offset = 0
    sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>()
    layers = new Map<string, object>()
    addImage = vi.fn()
    updateImage = vi.fn()
    removeImage = vi.fn()
    setFilter = vi.fn()
    queryRenderedFeatures = vi.fn(() => [] as { properties: { key: string } }[])
    listeners = new Map<string, ((event: object) => void)[]>()
    constructor({ container }: { container: HTMLElement }) {
      this.container = container
      maps.push(this)
    }
    addControl() {}
    setConfigProperty() {}
    on(name: string, callback: (event: object) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback])
    }
    off(name: string, callback: (event: object) => void) {
      this.listeners.set(
        name,
        (this.listeners.get(name) ?? []).filter((f) => f !== callback)
      )
    }
    fire(name: string, event: object = {}) {
      for (const callback of this.listeners.get(name) ?? []) callback(event)
    }
    isStyleLoaded() {
      return true
    }
    isMoving() {
      return false
    }
    getCanvas() {
      return this.container
    }
    getSource(id: string) {
      return this.sources.get(id)
    }
    addSource(id: string) {
      this.sources.set(id, { setData: vi.fn() })
    }
    addLayer(layer: { id: string }) {
      this.layers.set(layer.id, layer)
    }
    getContainer() {
      return this.container
    }
    project({ lng }: { lng: number }) {
      return { x: (lng + 117.16) * 1000 + this.offset, y: 0 }
    }
    getZoom() {
      return 11.8
    }
    getPitch() {
      return 35
    }
    getBearing() {
      return 20
    }
    flyTo = vi.fn()
    remove() {}
  }
  const maps: FakeMap[] = []
  const markers: FakeMarker[] = []
  class FakeMarker {
    element: HTMLElement
    position = { lng: 0, lat: 0 }
    constructor({ element }: { element: HTMLElement }) {
      this.element = element
      markers.push(this)
    }
    setLngLat = vi.fn(([lng, lat]: [number, number]) => {
      this.position = { lng, lat }
      return this
    })
    getLngLat = () => this.position
    getElement = () => this.element
    addTo = (map: { container: HTMLElement }) => {
      map.container.append(this.element)
      return this
    }
    remove = vi.fn(() => this.element.remove())
  }
  return { markers, maps, FakeMarker, FakeMap }
})

vi.mock("mapbox-gl", () => ({
  default: {
    Map: FakeMap,
    Marker: FakeMarker,
    NavigationControl: class {},
  },
}))

import { EventMap } from "@/components/map/EventMap"
import { useGrapevine } from "@/lib/store"
import { DEFAULT_FILTERS, type CityEvent } from "@/lib/types"

function event(id: string, patch: Partial<CityEvent> = {}): CityEvent {
  return {
    id,
    title: `Jazz ${id}`,
    description: "Live music",
    category: "music",
    tags: [],
    venue: "The Park",
    lng: -117.16,
    lat: 32.72,
    start: "2026-09-28T18:00:00Z",
    end: "2026-09-28T22:00:00Z",
    price: "Free",
    free: true,
    source: "test",
    sourceKind: "manual",
    rating: 4,
    promoted: false,
    rarity: "common",
    ...patch,
  }
}

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("matchMedia", () => ({ matches: false }))
  markers.length = 0
  maps.length = 0
  useGrapevine.setState(
    {
      ...useGrapevine.getInitialState(),
      now: new Date("2026-09-28T19:00:00Z"),
      filters: { ...DEFAULT_FILTERS, dateFrom: null, dateTo: null },
      events: [event("a"), event("b", { lng: -117.2 })],
    },
    true
  )
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(createElement(EventMap)))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("map marker updates", () => {
  async function enableCanvas() {
    act(() => root.unmount())
    vi.stubGlobal(
      "Image",
      class {
        src = ""
        decode = () => Promise.resolve()
      }
    )
    const ctx = {
      scale: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      drawImage: vi.fn(),
      roundRect: vi.fn(),
      fillText: vi.fn(),
      measureText: (text: string) => ({ width: text.length * 6 }),
      getImageData: () => ({
        width: 128,
        height: 96,
        data: new Uint8ClampedArray(128 * 96 * 4),
      }),
    }
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D
    )
    root = createRoot(container)
    await act(async () => {
      root.render(createElement(EventMap))
    })
    return maps.at(-1)!
  }

  it("renders ordinary pins in the canvas and restores HTML on keyboard focus", async () => {
    const map = await enableCanvas()
    expect(map.layers.has("gv-event-pins")).toBe(true)
    const proxies = container.querySelectorAll(".gv-marker-proxy")
    expect(proxies).toHaveLength(2)
    const data = map.getSource("gv-event-locations")!.setData
    data.mockClear()
    act(() => useGrapevine.getState().select("a"))
    act(() => useGrapevine.getState().setDetailOpen(false))
    expect(data).not.toHaveBeenCalled()
    const trigger =
      proxies[0].querySelector<HTMLButtonElement>(".gv-marker-trigger")!
    act(() => trigger.focus())
    expect(document.activeElement).toBe(trigger)
    expect(trigger.closest(".gv-marker-proxy")).toBeNull()
    expect(
      container.querySelectorAll(".gv-marker-root:not(.gv-marker-proxy)")
    ).toHaveLength(1)
    await act(async () => trigger.blur())
    expect(container.querySelectorAll(".gv-marker-proxy")).toHaveLength(2)
    // Ordinary navigation does not rebuild images or change layer filters.
    map.addImage.mockClear()
    map.updateImage.mockClear()
    map.setFilter.mockClear()
    map.fire("moveend")
    expect(map.addImage).not.toHaveBeenCalled()
    expect(map.updateImage).not.toHaveBeenCalled()
    expect(map.setFilter).not.toHaveBeenCalled()
  })

  it("keeps a hovered pin visible when the pointer crosses from canvas to its controls", async () => {
    const map = await enableCanvas()
    const trigger =
      container.querySelector<HTMLButtonElement>(".gv-marker-trigger")!
    map.queryRenderedFeatures.mockReturnValue([
      { properties: { key: "-117.1600,32.7200" } },
    ])
    map.fire("mousemove", {
      point: { x: 0, y: -13 },
      originalEvent: { target: map.container },
    })
    expect(trigger.closest(".gv-marker-proxy")).toBeNull()
    map.fire("mouseout", { originalEvent: { relatedTarget: trigger } })
    expect(trigger.closest(".gv-marker-proxy")).toBeNull()
    map.fire("mouseout", { originalEvent: { relatedTarget: document.body } })
    expect(trigger.closest(".gv-marker-proxy")).not.toBeNull()
  })

  it("selects canvas pins, pages their faces, and recovers after a style reload", async () => {
    act(() => useGrapevine.setState({ events: [event("a"), event("b")] }))
    const map = await enableCanvas()
    const key = "-117.1600,32.7200"
    const source = map.getSource("gv-event-locations")!
    expect(source.setData.mock.lastCall?.[0].features).toHaveLength(1)
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Next event at this spot"]'
        )!
        .click()
    )
    expect(
      container.querySelector(".gv-marker-trigger")?.getAttribute("aria-label")
    ).toContain("Jazz b")
    map.queryRenderedFeatures.mockReturnValue([{ properties: { key } }])
    act(() => map.fire("click", { point: { x: 0, y: 0 } }))
    expect(useGrapevine.getState().selectedId).toBe("b")
    expect(
      container.querySelectorAll(".gv-marker-root:not(.gv-marker-proxy)")
    ).toHaveLength(1)
    // A new style discards the application's sources, layers, and sprites.
    map.sources.clear()
    map.layers.clear()
    map.fire("style.load")
    expect(map.layers.has("gv-event-pins")).toBe(true)
    expect(
      map.getSource("gv-event-locations")!.setData.mock.lastCall?.[0].features
    ).toHaveLength(1)
    expect(map.addImage.mock.calls.length).toBe(4)
  })
  it("detaches offscreen pins and restores their pager state when they return", () => {
    act(() => useGrapevine.setState({ events: [event("a"), event("b")] }))
    const marker = markers[0]
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Next event at this spot"]'
        )!
        .click()
    )
    maps[0].offset = 1000
    maps[0].fire("moveend")
    expect(container.querySelector(".gv-marker")).toBeNull()
    maps[0].offset = 0
    maps[0].fire("moveend")
    expect(container.querySelector(".gv-marker-root")).toBe(marker.element)
    expect(
      marker.element
        .querySelector(".gv-marker-trigger")
        ?.getAttribute("aria-label")
    ).toContain("Jazz b")
  })

  it("keeps keyboard focus attached and restores motion effects after moving", () => {
    const trigger =
      container.querySelector<HTMLButtonElement>(".gv-marker-trigger")!
    trigger.focus()
    maps[0].fire("movestart")
    expect(document.documentElement.classList.contains("gv-map-moving")).toBe(
      true
    )
    maps[0].offset = 1000
    maps[0].fire("moveend")
    expect(document.activeElement).toBe(trigger)
    expect(trigger.isConnected).toBe(true)
    expect(document.documentElement.classList.contains("gv-map-moving")).toBe(
      false
    )
    trigger.blur()
    maps[0].fire("resize")
    expect(container.querySelector(".gv-marker")).toBeNull()
  })

  it("preserves the user's camera orientation when selecting an event", () => {
    act(() => useGrapevine.getState().select("a"))
    expect(maps[0].flyTo).toHaveBeenCalledWith(
      expect.objectContaining({
        pitch: 35,
        bearing: 20,
        duration: 900,
        essential: false,
      })
    )
  })

  it("labels native event buttons and keeps stack paging separate from selection", () => {
    act(() => useGrapevine.setState({ events: [event("a"), event("b")] }))
    const trigger =
      container.querySelector<HTMLButtonElement>(".gv-marker-trigger")!
    const pager = container.querySelector<HTMLButtonElement>(
      '[aria-label="Next event at this spot"]'
    )!
    expect(trigger.tagName).toBe("BUTTON")
    expect(trigger.closest('[role="group"]')?.getAttribute("aria-label")).toBe(
      "Events at this spot"
    )
    expect(trigger.contains(pager)).toBe(false)
    expect(trigger.getAttribute("aria-label")).toBe(
      "Show Jazz a at The Park (event 1 of 2)"
    )
    act(() => pager.click())
    expect(useGrapevine.getState().detailOpen).toBe(false)
    expect(trigger.getAttribute("aria-label")).toBe(
      "Show Jazz b at The Park (event 2 of 2)"
    )
    act(() => trigger.click())
    expect(useGrapevine.getState().selectedId).toBe("b")
    expect(useGrapevine.getState().detailOpen).toBe(true)
  })

  it("searches and selects without repositioning unchanged pins", () => {
    expect(markers).toHaveLength(2)
    markers.forEach((m) => m.setLngLat.mockClear())
    act(() => useGrapevine.getState().setSearchQuery("Jazz a"))
    expect(container.querySelectorAll('[data-dimmed="true"]')).toHaveLength(1)
    act(() => useGrapevine.getState().select("a"))
    expect(container.querySelectorAll('[data-selected="true"]')).toHaveLength(1)
    act(() => useGrapevine.getState().setDetailOpen(false))
    for (const marker of markers)
      expect(marker.setLngLat).not.toHaveBeenCalled()
    expect(markers).toHaveLength(2)
  })

  it("refreshes text without moving pins, but applies corrected coordinates", () => {
    const marker = markers.find((m) => m.position.lng === -117.16)!
    marker.setLngLat.mockClear()
    act(() =>
      useGrapevine.setState({ events: [event("a", { title: "New title" })] })
    )
    expect(marker.element.textContent).toContain("New title")
    expect(marker.setLngLat).not.toHaveBeenCalled()
    // Within the same rounded venue key: update in place, don't recreate.
    act(() =>
      useGrapevine.setState({ events: [event("a", { lng: -117.16001 })] })
    )
    expect(marker.setLngLat).toHaveBeenCalledExactlyOnceWith([
      -117.16001, 32.72,
    ])
    expect(markers).toHaveLength(2)
    expect(markers.find((m) => m !== marker)!.remove).toHaveBeenCalledOnce()
  })
})
