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
    zoom = 11.8
    listeners = new Map<string, ((event: object) => void)[]>()
    constructor({ container }: { container: HTMLElement }) {
      this.container = container
      maps.push(this)
    }
    addControl() {}
    on(name: string, callback: (event: object) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback])
    }
    fire(name: string) {
      for (const callback of this.listeners.get(name) ?? []) callback({})
    }
    getContainer() {
      return this.container
    }
    project({ lng }: { lng: number }) {
      return { x: (lng + 117.16) * 1000 + this.offset, y: 0 }
    }
    getZoom() {
      return this.zoom
    }
    setConfigProperty = vi.fn()
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
      trafficOn: false,
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
})

describe("map marker updates", () => {
  it("shows detailed landmarks only at close zoom without flapping at the boundary", () => {
    const map = maps[0]
    map.fire("style.load")
    expect(map.setConfigProperty).toHaveBeenCalledWith(
      "basemap",
      "show3dObjects",
      true
    )
    expect(map.setConfigProperty).toHaveBeenCalledWith(
      "basemap",
      "show3dLandmarks",
      false
    )
    map.setConfigProperty.mockClear()
    map.zoom = 16
    map.fire("zoom")
    expect(map.setConfigProperty).toHaveBeenCalledExactlyOnceWith(
      "basemap",
      "show3dLandmarks",
      true
    )
    map.setConfigProperty.mockClear()
    map.zoom = 15.8
    map.fire("zoom")
    expect(map.setConfigProperty).not.toHaveBeenCalled()
    map.zoom = 15.4
    map.fire("zoom")
    expect(map.setConfigProperty).toHaveBeenCalledExactlyOnceWith(
      "basemap",
      "show3dLandmarks",
      false
    )
    map.setConfigProperty.mockClear()
    map.zoom = 15.8
    map.fire("zoom")
    expect(map.setConfigProperty).not.toHaveBeenCalled()
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
