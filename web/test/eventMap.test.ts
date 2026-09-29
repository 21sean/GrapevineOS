// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.hoisted(() => vi.stubEnv("VITE_MAPBOX_TOKEN", "test-token"))
vi.mock("@/lib/api", () => ({ api: {} }))
vi.mock("@/lib/supabase", () => ({ supabase: null }))

const { markers, FakeMarker } = vi.hoisted(() => {
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
  return { markers, FakeMarker }
})

vi.mock("mapbox-gl", () => ({
  default: {
    Map: class {
      container: HTMLElement
      constructor({ container }: { container: HTMLElement }) {
        this.container = container
      }
      addControl() {}
      on() {}
      getZoom() {
        return 11.8
      }
      flyTo() {}
      remove() {}
    },
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
})

describe("map marker updates", () => {
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
