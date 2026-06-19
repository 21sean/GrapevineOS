import { createElement, useEffect, useMemo, useRef } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"
import { useGrapevine } from "@/lib/store"
import { carouselEvents, visibleEvents } from "@/lib/score"
import { isLive, lightPresetForTime } from "@/lib/time"
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

// Lift markers a touch off their ground point so they read as floating above
// the pitched 3D basemap rather than lying flat on it.
const MARKER_LIFT = 16

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

// Events within ~10 m of each other share one marker (a "stack") — separate
// pins at the same venue just paint over each other into an unreadable pile.
function locKey(e: CityEvent): string {
  return `${e.lng.toFixed(4)},${e.lat.toFixed(4)}`
}

/** One marker representing every event at a location; idx picks the face. */
interface Stack {
  marker: mapboxgl.Marker
  el: HTMLDivElement
  iconEl: HTMLSpanElement
  labelEl: HTMLDivElement
  countEl: HTMLSpanElement
  numEl: HTMLSpanElement
  events: CityEvent[]
  idx: number
}

/** Write-if-changed so idle re-decorates (the 30s clock tick) mutate nothing. */
function setData(el: HTMLElement, key: string, value: string) {
  if (el.dataset[key] !== value) el.dataset[key] = value
}

function setText(el: HTMLElement, value: string) {
  if (el.textContent !== value) el.textContent = value
}

export function EventMap() {
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stacksRef = useRef(new Map<string, Stack>())
  const userMarkerRef = useRef<mapboxgl.Marker | null>(null)
  const styleReadyRef = useRef(false)
  // Once the user (or the tour) moves the camera, a late settings fetch must
  // not yank the view back to the configured center.
  const cameraTouchedRef = useRef(false)

  const settings = useGrapevine((s) => s.settings)
  const events = useGrapevine((s) => s.events)
  const filters = useGrapevine((s) => s.filters)
  const interests = useGrapevine((s) => s.interests)
  const hiddenIds = useGrapevine((s) => s.hiddenIds)
  const now = useGrapevine((s) => s.now)
  const selectedId = useGrapevine((s) => s.selectedId)
  const detailOpen = useGrapevine((s) => s.detailOpen)
  const carouselOn = useGrapevine((s) => s.carouselOn)
  const carouselIdx = useGrapevine((s) => s.carouselIdx)
  const trafficOn = useGrapevine((s) => s.trafficOn)
  const userPos = useGrapevine((s) => s.userPos)
  const select = useGrapevine((s) => s.select)
  const agentHighlight = useGrapevine((s) => s.agentHighlight)

  const visible = useMemo(
    () => visibleEvents(events, filters, interests, now, settings?.tz, new Set(hiddenIds)),
    [events, filters, interests, now, settings?.tz, hiddenIds],
  )

  // The agent's picks render even when the user's filters would hide them
  // (e.g. hidePromoted) — a recommendation with no pin is a broken answer.
  const agentIds = useMemo(
    () => new Set(agentHighlight?.ids ?? []),
    [agentHighlight],
  )
  const rendered = useMemo(() => {
    if (!agentIds.size) return visible
    const shown = new Set(visible.map((e) => e.id))
    const extras = events.filter((e) => agentIds.has(e.id) && !shown.has(e.id))
    return extras.length ? [...visible, ...extras] : visible
  }, [visible, events, agentIds])
  const tour = useMemo(
    () => carouselEvents(events, filters, interests, now, settings?.tz, new Set(hiddenIds)),
    [events, filters, interests, now, settings?.tz, hiddenIds],
  )

  // A marker looks "selected" only while its detail sheet is open. Keeping
  // selectedId set through the sheet's close animation is what lets the sheet
  // fade out — but the marker must drop its selected look the moment the sheet
  // starts closing (click-off, Escape, X), not stay stuck highlighted.
  const activeId = detailOpen ? selectedId : null

  // Map lighting tracks the wall clock in the city's own timezone — Pacific for
  // San Diego — so the basemap moves through dawn/day/dusk/night with real time
  // instead of sitting on a fixed preset. `now` ticks every 30s, but the memo
  // only yields a new string when the hour crosses a boundary, so downstream
  // effects stay idle in between. Falls back to LA time until settings arrive.
  const lightPreset = useMemo(
    () => lightPresetForTime(now, settings?.tz ?? "America/Los_Angeles"),
    [now, settings?.tz],
  )
  // Latest preset for the init/style.load handlers, which run outside render.
  // Seeded from the mount-time value; kept current by the sync effect below.
  const lightPresetRef = useRef(lightPreset)

  // --- init (once per mount; cleanup per mapbox-web-integration-patterns) ---
  useEffect(() => {
    if (!containerRef.current) return
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/standard",
      config: { basemap: { lightPreset: lightPresetRef.current } },
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
    // The var write invalidates style for every marker, and "zoom" fires per
    // animation frame during flyTo — quantize the scale and skip no-op writes
    // so a 3s tour flight costs a handful of recalcs instead of ~200.
    let lastScale = ""
    let lastLabels: boolean | undefined
    const applyZoom = () => {
      const zoom = map.getZoom()
      const el = containerRef.current
      if (!el) return
      const labels = zoom >= LABEL_MIN_ZOOM
      if (labels !== lastLabels) {
        el.classList.toggle("gv-labels-on", labels)
        lastLabels = labels
      }
      const scale = markerScaleForZoom(zoom).toFixed(2)
      if (scale !== lastScale) {
        el.style.setProperty("--gv-marker-scale", scale)
        lastScale = scale
      }
    }
    map.on("zoom", applyZoom)
    applyZoom()

    map.on("style.load", () => {
      styleReadyRef.current = true
      map.setConfigProperty("basemap", "lightPreset", lightPresetRef.current)
      // trafficOn is persisted; restore it once the style can take layers
      if (useGrapevine.getState().trafficOn) addTrafficLayer(map)
    })

    mapRef.current = map
    return () => {
      styleReadyRef.current = false
      stacksRef.current.forEach(({ marker }) => marker.remove())
      stacksRef.current.clear()
      userMarkerRef.current = null
      map.remove()
      mapRef.current = null
    }
  }, [])

  // --- keep basemap lighting in sync as the hour (or city timezone) changes ---
  useEffect(() => {
    lightPresetRef.current = lightPreset
    const map = mapRef.current
    if (!map || !styleReadyRef.current) return
    map.setConfigProperty("basemap", "lightPreset", lightPreset)
  }, [lightPreset])

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

  // --- camera focus (also drives which face a stack shows during the tour) ---
  const focus: CityEvent | undefined = carouselOn
    ? tour[tour.length ? carouselIdx % tour.length : 0]
    : visible.find((e) => e.id === selectedId) ??
      events.find((e) => e.id === selectedId)
  const focusId = focus?.id
  const focusSeq = carouselOn ? carouselIdx : -1

  // Latest decorate inputs for the stack pager handlers, which live in plain
  // DOM listeners outside React's render cycle.
  const decorCtxRef = useRef({ now, activeId, agentIds })
  decorCtxRef.current = { now, activeId, agentIds }
  // Snap a stack's face to the selected/toured/highlighted event only when
  // that target changes — never on unrelated re-runs, so a face the user
  // paged to by hand isn't yanked back by the next clock tick.
  const lastTargetRef = useRef<string | null>(null)
  const lastAgentSeqRef = useRef(0)

  // --- markers: one stack per location, diffed by location key ---
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const groups = new Map<string, CityEvent[]>()
    for (const e of rendered) {
      const k = locKey(e)
      const g = groups.get(k)
      if (g) g.push(e)
      else groups.set(k, [e])
    }

    for (const [key, stack] of stacksRef.current) {
      if (!groups.has(key)) {
        stack.marker.remove()
        stacksRef.current.delete(key)
      }
    }

    const target = carouselOn ? focusId : selectedId
    const targetChanged = target !== lastTargetRef.current
    lastTargetRef.current = target ?? null
    const agentSeq = agentHighlight?.seq ?? 0
    const agentChanged = agentSeq !== lastAgentSeqRef.current
    lastAgentSeqRef.current = agentSeq

    for (const [key, group] of groups) {
      let stack = stacksRef.current.get(key)
      if (!stack) {
        // Mapbox owns the outer element (positions it via inline transform);
        // visuals + scale/pulse animations live on an inner element so they
        // never fight that transform. Styling the mapbox element directly is
        // what pushed every marker out of place and re-triggered transitions
        // on each animation frame.
        const root = document.createElement("div")
        const el = document.createElement("div")
        el.className = "gv-marker"
        const iconEl = document.createElement("span")
        iconEl.className = "gv-marker-icon"
        const countEl = document.createElement("span")
        countEl.className = "gv-marker-count"
        const labelEl = document.createElement("div")
        labelEl.className = "gv-marker-label"
        const pager = document.createElement("div")
        pager.className = "gv-stack-pager"
        const prev = document.createElement("button")
        prev.type = "button"
        prev.className = "gv-stack-btn"
        prev.textContent = "‹"
        prev.setAttribute("aria-label", "Previous event at this spot")
        const numEl = document.createElement("span")
        numEl.className = "gv-stack-num"
        const next = document.createElement("button")
        next.type = "button"
        next.className = "gv-stack-btn"
        next.textContent = "›"
        next.setAttribute("aria-label", "Next event at this spot")
        pager.append(prev, numEl, next)
        el.append(iconEl, countEl, labelEl, pager)
        root.appendChild(el)

        const marker = new mapboxgl.Marker({
          element: root,
          anchor: "center",
          offset: [0, -MARKER_LIFT],
        })
          .setLngLat([group[0].lng, group[0].lat])
          .addTo(map)
        const created: Stack = {
          marker,
          el,
          iconEl,
          labelEl,
          countEl,
          numEl,
          events: group,
          idx: 0,
        }

        const cycle = (dir: number) => {
          const n = created.events.length
          if (n < 2) return
          created.idx = (created.idx + dir + n) % n
          const ctx = decorCtxRef.current
          decorateStack(created, ctx.now, ctx.activeId, ctx.agentIds)
          // Sheet open means the user is inspecting this venue — retarget it.
          // Sheet closed, paging is a silent preview: no camera move, no popup.
          const st = useGrapevine.getState()
          if (st.detailOpen) st.select(created.events[created.idx].id)
        }
        root.addEventListener("click", (ev) => {
          ev.stopPropagation()
          select(created.events[created.idx].id)
        })
        // pager clicks page the stack; they must never fall through to select
        pager.addEventListener("click", (ev) => ev.stopPropagation())
        prev.addEventListener("click", () => cycle(-1))
        next.addEventListener("click", () => cycle(1))

        stack = created
        stacksRef.current.set(key, stack)
      } else {
        // keep whichever event this stack is showing across list refreshes
        const shownId = stack.events[stack.idx]?.id
        stack.events = group
        const keep = group.findIndex((e) => e.id === shownId)
        stack.idx = keep >= 0 ? keep : 0
        stack.marker.setLngLat([group[0].lng, group[0].lat])
      }

      if (targetChanged && target) {
        const i = group.findIndex((e) => e.id === target)
        if (i >= 0) stack.idx = i
      } else if (agentChanged && agentIds.size) {
        const i = group.findIndex((e) => agentIds.has(e.id))
        if (i >= 0) stack.idx = i
      }
      decorateStack(stack, now, activeId, agentIds)
    }
  }, [
    rendered,
    now,
    activeId,
    selectedId,
    focusId,
    carouselOn,
    select,
    agentIds,
    agentHighlight?.seq,
  ])

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
  useEffect(() => {
    const map = mapRef.current
    if (!map || !focus) return
    cameraTouchedRef.current = true
    // Phones: the top pills and the tour card + dock frame a clear strip of
    // map; pad the camera so the focused marker lands inside it, not under
    // the overlays. (Media query, not a hook — read at fly time so rotating
    // the device mid-session picks the right frame.)
    const phone = window.matchMedia("(max-width: 767px)").matches
    map.flyTo({
      center: [focus.lng, focus.lat],
      zoom: carouselOn ? 14.6 : 15.2,
      pitch: 60,
      bearing: -30 + ((focusSeq >= 0 ? focusSeq : 0) % 5) * 18,
      duration: carouselOn ? 3200 : 2200,
      padding: phone
        ? { top: 110, bottom: 300, left: 24, right: 24 }
        : { top: 0, bottom: 0, left: 0, right: 0 },
      essential: false, // respect prefers-reduced-motion
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, focusSeq, carouselOn])

  // --- camera: agent highlights (one pin flies, several fit together) ---
  // Padding keeps pins clear of the chat palette (top), the FilterRail
  // (desktop left), and the dock (phone bottom).
  useEffect(() => {
    const map = mapRef.current
    const hl = agentHighlight
    if (!map || !hl?.fit || !hl.ids.length) return
    const pts = events.filter((e) => hl.ids.includes(e.id))
    if (!pts.length) return
    cameraTouchedRef.current = true
    const phone = window.matchMedia("(max-width: 767px)").matches
    const padding = phone
      ? { top: 110, bottom: 300, left: 32, right: 32 }
      : { top: 340, bottom: 80, left: 380, right: 80 }
    if (pts.length === 1) {
      map.flyTo({
        center: [pts[0].lng, pts[0].lat],
        zoom: 15.2,
        pitch: 60,
        bearing: -18,
        duration: 2200,
        padding,
        essential: false,
      })
    } else {
      const bounds = new mapboxgl.LngLatBounds()
      for (const e of pts) bounds.extend([e.lng, e.lat])
      map.fitBounds(bounds, {
        padding,
        pitch: 45,
        bearing: -12,
        duration: 1800,
        maxZoom: 14.5,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentHighlight?.seq])

  // mapbox-gl.css forces `position: relative` on the container, so size it
  // explicitly instead of relying on absolute inset-0. The gv-map class scopes
  // the dark control overrides in index.css so they outrank mapbox's own CSS.
  return <div ref={containerRef} className="gv-map size-full" />
}

/** Paint a stack's marker as the event at `idx` (its current face). */
function decorateStack(
  stack: Stack,
  now: Date,
  selectedId: string | null,
  agentIds?: Set<string>,
) {
  const e = stack.events[stack.idx]
  if (!e) return
  const { el } = stack
  const color = CATEGORY_META[e.category].color
  if (el.dataset.color !== color) {
    el.style.setProperty("--marker-color", color)
    el.dataset.color = color
  }
  setData(el, "live", String(isLive(e, now)))
  setData(el, "selected", String(e.id === selectedId))
  setData(el, "agent", String(agentIds?.has(e.id) ?? false))
  setData(el, "stack", String(stack.events.length > 1))
  if (el.dataset.category !== e.category) {
    el.dataset.category = e.category
    stack.iconEl.innerHTML = ICON_SVG[e.category]
  }
  setText(stack.labelEl, e.title)
  setText(stack.countEl, stack.events.length > 1 ? String(stack.events.length) : "")
  setText(stack.numEl, `${stack.idx + 1}/${stack.events.length}`)
}
