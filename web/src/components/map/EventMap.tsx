import { createElement, useEffect, useMemo, useRef } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"
import { useGrapevine } from "@/lib/store"
import { carouselEvents, visibleEvents } from "@/lib/score"
import { isLive } from "@/lib/time"
import { CATEGORY_META, type Category, type CityEvent } from "@/lib/types"

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN as string

const TRAFFIC_SOURCE = "gv-traffic"
const TRAFFIC_LAYER = "gv-traffic-line"

/** Zoom at which marker labels fade in, mirroring Mapbox's own POI labels. */
const LABEL_MIN_ZOOM = 13

// Markers are plain DOM, so Mapbox renders them at a fixed pixel size at every
// zoom — full size at street zoom is right, but pulled back to the whole county
// those same dots turn oversized and pile into an unreadable clump. Scale them
// with zoom instead, receding as you zoom out the way Mapbox's own POIs do.
const MARKER_MIN_SCALE = 0.6
function markerScaleForZoom(zoom: number): number {
  const t = Math.min(Math.max((zoom - 10) / (LABEL_MIN_ZOOM + 1 - 10), 0), 1)
  return MARKER_MIN_SCALE + t * (1 - MARKER_MIN_SCALE)
}

// Seed camera so the map boots (WebGL, style, tiles) in parallel with the API
// fetch instead of behind it; settings recenter it on arrival if they differ.
const FALLBACK_CENTER: [number, number] = [-117.1611, 32.7157] // San Diego

// Traffic source+layer are added on first toggle, not at style load — the
// layer starts hidden by default, so eager-adding only buys a wasted TileJSON
// fetch on the critical path.
function addTrafficLayer(map: mapboxgl.Map) {
  if (map.getSource(TRAFFIC_SOURCE)) return
  map.addSource(TRAFFIC_SOURCE, {
    type: "vector",
    url: "mapbox://mapbox.mapbox-traffic-v1",
  })
  map.addLayer({
    id: TRAFFIC_LAYER,
    type: "line",
    source: TRAFFIC_SOURCE,
    "source-layer": "traffic",
    slot: "middle",
    layout: { "line-join": "round" },
    paint: {
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 14, 2.5, 18, 5],
      "line-color": [
        "match",
        ["get", "congestion"],
        "low", "#3fae6a",
        "moderate", "#e3b74f",
        "heavy", "#e2683f",
        "severe", "#c43a4b",
        "#3fae6a",
      ],
      "line-opacity": 0.8,
    },
  })
}

// Static SVG per category so plain-DOM markers can reuse the lucide icons.
const ICON_SVG = Object.fromEntries(
  (Object.keys(CATEGORY_META) as Category[]).map((c) => [
    c,
    renderToStaticMarkup(
      createElement(CATEGORY_META[c].icon, { size: 13, strokeWidth: 2.5 }),
    ),
  ]),
) as Record<Category, string>

export function EventMap() {
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const markersRef = useRef(new Map<string, { marker: mapboxgl.Marker; el: HTMLDivElement }>())
  const userMarkerRef = useRef<mapboxgl.Marker | null>(null)
  const styleReadyRef = useRef(false)
  // Once the user (or the tour) moves the camera, a late settings fetch must
  // not yank the view back to the configured center.
  const cameraTouchedRef = useRef(false)

  const settings = useGrapevine((s) => s.settings)
  const events = useGrapevine((s) => s.events)
  const filters = useGrapevine((s) => s.filters)
  const interests = useGrapevine((s) => s.interests)
  const now = useGrapevine((s) => s.now)
  const selectedId = useGrapevine((s) => s.selectedId)
  const carouselOn = useGrapevine((s) => s.carouselOn)
  const carouselIdx = useGrapevine((s) => s.carouselIdx)
  const trafficOn = useGrapevine((s) => s.trafficOn)
  const userPos = useGrapevine((s) => s.userPos)
  const select = useGrapevine((s) => s.select)

  const visible = useMemo(
    () => visibleEvents(events, filters, interests, now),
    [events, filters, interests, now],
  )
  const tour = useMemo(
    () => carouselEvents(events, filters, interests, now),
    [events, filters, interests, now],
  )

  // --- init (once per mount; cleanup per mapbox-web-integration-patterns) ---
  useEffect(() => {
    if (!containerRef.current) return
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/standard",
      config: { basemap: { lightPreset: "night" } },
      center: FALLBACK_CENTER,
      zoom: 11.8,
      pitch: 52,
      bearing: -12,
      attributionControl: false,
    })
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "bottom-right")

    // originalEvent is only set for user gestures, not programmatic moves
    map.on("movestart", (e) => {
      if (e.originalEvent) cameraTouchedRef.current = true
    })

    // POI-style labels only past neighborhood zoom, so downtown doesn't clutter;
    // markers scale with zoom (via a CSS var that cascades to every .gv-marker).
    const applyZoom = () => {
      const zoom = map.getZoom()
      const el = containerRef.current
      if (!el) return
      el.classList.toggle("gv-labels-on", zoom >= LABEL_MIN_ZOOM)
      el.style.setProperty("--gv-marker-scale", markerScaleForZoom(zoom).toFixed(3))
    }
    map.on("zoom", applyZoom)
    applyZoom()

    map.on("style.load", () => {
      styleReadyRef.current = true
      map.setConfigProperty("basemap", "lightPreset", "night")
      // trafficOn is persisted; restore it once the style can take layers
      if (useGrapevine.getState().trafficOn) addTrafficLayer(map)
    })

    mapRef.current = map
    return () => {
      styleReadyRef.current = false
      markersRef.current.forEach(({ marker }) => marker.remove())
      markersRef.current.clear()
      userMarkerRef.current = null
      map.remove()
      mapRef.current = null
    }
  }, [])

  // --- settings arrive after the map booted: recenter if nothing moved yet ---
  useEffect(() => {
    const map = mapRef.current
    if (!map || !settings || cameraTouchedRef.current) return
    const [lng, lat] = settings.center
    const cur = map.getCenter()
    if (Math.abs(cur.lng - lng) > 1e-6 || Math.abs(cur.lat - lat) > 1e-6) {
      map.jumpTo({ center: settings.center })
    }
  }, [settings])

  // --- markers: diff by id so pulses don't restart on unrelated renders ---
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const wanted = new Map(visible.map((e) => [e.id, e]))

    for (const [id, { marker }] of markersRef.current) {
      if (!wanted.has(id)) {
        marker.remove()
        markersRef.current.delete(id)
      }
    }

    for (const e of visible) {
      const existing = markersRef.current.get(e.id)
      if (existing) {
        decorate(existing.el, e, now, selectedId)
        continue
      }
      // Mapbox owns the outer element (positions it via inline transform);
      // visuals + scale/pulse animations live on an inner element so they
      // never fight that transform. Styling the mapbox element directly is
      // what pushed every marker out of place and re-triggered transitions
      // on each animation frame.
      const root = document.createElement("div")
      const el = document.createElement("div")
      el.className = "gv-marker"
      const icon = document.createElement("span")
      icon.className = "gv-marker-icon"
      const label = document.createElement("div")
      label.className = "gv-marker-label"
      el.append(icon, label)
      root.appendChild(el)
      decorate(el, e, now, selectedId)
      root.addEventListener("click", (ev) => {
        ev.stopPropagation()
        select(e.id)
      })
      const marker = new mapboxgl.Marker({ element: root, anchor: "center" })
        .setLngLat([e.lng, e.lat])
        .addTo(map)
      markersRef.current.set(e.id, { marker, el })
    }
  }, [visible, now, selectedId, select])

  // --- traffic visibility (layer created lazily on first enable) ---
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReadyRef.current) return
    if (trafficOn) {
      addTrafficLayer(map)
      map.setLayoutProperty(TRAFFIC_LAYER, "visibility", "visible")
    } else if (map.getLayer(TRAFFIC_LAYER)) {
      map.setLayoutProperty(TRAFFIC_LAYER, "visibility", "none")
    }
  }, [trafficOn])

  // --- user position dot ---
  useEffect(() => {
    const map = mapRef.current
    if (!map || !userPos) return
    if (!userMarkerRef.current) {
      const el = document.createElement("div")
      el.className = "gv-user-dot"
      userMarkerRef.current = new mapboxgl.Marker({ element: el })
        .setLngLat(userPos)
        .addTo(map)
    } else {
      userMarkerRef.current.setLngLat(userPos)
    }
  }, [userPos])

  // --- camera: carousel tour or manual selection ---
  const focus: CityEvent | undefined = carouselOn
    ? tour[tour.length ? carouselIdx % tour.length : 0]
    : visible.find((e) => e.id === selectedId) ??
      events.find((e) => e.id === selectedId)

  const focusId = focus?.id
  const focusSeq = carouselOn ? carouselIdx : -1
  useEffect(() => {
    const map = mapRef.current
    if (!map || !focus) return
    cameraTouchedRef.current = true
    map.flyTo({
      center: [focus.lng, focus.lat],
      zoom: carouselOn ? 14.6 : 15.2,
      pitch: 60,
      bearing: -30 + ((focusSeq >= 0 ? focusSeq : 0) % 5) * 18,
      duration: carouselOn ? 3200 : 2200,
      essential: false, // respect prefers-reduced-motion
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, focusSeq, carouselOn])

  // mapbox-gl.css forces `position: relative` on the container, so size it
  // explicitly instead of relying on absolute inset-0.
  return <div ref={containerRef} className="size-full" />
}

function decorate(
  el: HTMLDivElement,
  e: CityEvent,
  now: Date,
  selectedId: string | null,
) {
  el.style.setProperty("--marker-color", CATEGORY_META[e.category].color)
  el.dataset.live = String(isLive(e, now))
  el.dataset.selected = String(e.id === selectedId)
  if (el.dataset.category !== e.category) {
    el.dataset.category = e.category
    const icon = el.querySelector<HTMLSpanElement>(".gv-marker-icon")
    if (icon) icon.innerHTML = ICON_SVG[e.category]
  }
  const label = el.querySelector<HTMLDivElement>(".gv-marker-label")
  if (label && label.textContent !== e.title) label.textContent = e.title
}
