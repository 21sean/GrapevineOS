import { createElement, useEffect, useMemo, useRef } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"
import { useGrapevine } from "@/lib/store"
import {
  selectBookedLines,
  selectLightPreset,
  selectLiveIds,
  selectRendered,
  selectSearched,
  selectTour,
  selectVisible,
} from "@/lib/derived"
import {
  BOOKED_COLOR,
  CATEGORY_META,
  DEFAULT_CITY,
  type Category,
  type CityEvent,
} from "@/lib/types"
import { BASEMAP_LAYERS } from "@/lib/mapLayers"
import {
  EventPinLayer,
  EVENT_PIN_LAYER,
  type PinSnapshot,
} from "./EventPinLayer"

const MAPBOX_TOKEN =
  (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) ?? ""
mapboxgl.accessToken = MAPBOX_TOKEN

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
const FALLBACK_CENTER = DEFAULT_CITY.center

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
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        1,
        14,
        2.5,
        18,
        5,
      ],
      "line-color": [
        "match",
        ["get", "congestion"],
        "low",
        "#3fae6a",
        "moderate",
        "#e3b74f",
        "heavy",
        "#e2683f",
        "severe",
        "#c43a4b",
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
      createElement(CATEGORY_META[c].icon, { size: 13, strokeWidth: 2.5 })
    ),
  ])
) as Record<Category, string>

// Events within ~10 m of each other share one marker (a "stack") — separate
// pins at the same venue just paint over each other into an unreadable pile.
function locKey(e: CityEvent): string {
  return `${e.lng.toFixed(4)},${e.lat.toFixed(4)}`
}

/** One marker representing every event at a location; idx picks the face. */
interface Stack {
  marker: mapboxgl.Marker
  attached: boolean
  html: boolean
  el: HTMLDivElement
  triggerEl: HTMLButtonElement
  iconEl: HTMLSpanElement
  labelMainEl: HTMLSpanElement
  labelSubEl: HTMLSpanElement
  countEl: HTMLSpanElement
  numEl: HTMLSpanElement
  events: CityEvent[]
  idx: number
}

/** Write-if-changed so full-set walks (selection, liveness flips) only touch
 *  the markers whose decoration actually moved. */
function setData(el: HTMLElement, key: string, value: string) {
  if (el.dataset[key] !== value) el.dataset[key] = value
}

function setText(el: HTMLElement, value: string) {
  if (el.textContent !== value) el.textContent = value
}

// Detached markers keep their pager state, but Mapbox no longer projects them
// or checks their occlusion on every frame. A screen-space buffer lets pins
// enter smoothly during a drag, including when the map is pitched or rotated.
function syncViewportMarkers(
  map: mapboxgl.Map,
  stacks: Map<string, Stack>,
  pins?: EventPinLayer | null,
  hoveredKey?: string | null
) {
  const container = map.getContainer()
  const width = container.clientWidth
  const height = container.clientHeight
  const focused = document.activeElement
  const padding = 200
  const htmlKeys: string[] = []
  // Read viewport geometry before attaching/removing DOM, avoiding forced
  // layout between each pair of pins crossing the viewport boundary.
  const changes = [...stacks].map(([key, stack]) => {
    const point = map.project(stack.marker.getLngLat())
    const visible =
      (point.x >= -padding &&
        point.x <= width + padding &&
        point.y >= -padding &&
        point.y <= height + padding) ||
      stack.el.contains(focused)
    const html =
      visible &&
      (!pins?.ready ||
        key === hoveredKey ||
        stack.el.dataset.selected === "true" ||
        stack.el.contains(focused))
    if (html) htmlKeys.push(key)
    return { stack, visible, html }
  })
  for (const { stack, visible, html } of changes) {
    if (visible === stack.attached && html === stack.html) continue
    const root = stack.marker.getElement()
    if (stack.html) stack.marker.remove()
    else root.remove()
    stack.attached = visible
    stack.html = html
    root.classList.toggle("gv-marker-proxy", !html)
    if (html) stack.marker.addTo(map)
    else if (visible) container.append(root)
    // Reparenting a proxy to Mapbox's marker container may drop focus.
    if (
      focused instanceof HTMLElement &&
      stack.el.contains(focused) &&
      document.activeElement !== focused
    )
      focused.focus({ preventScroll: true })
  }
  pins?.setHtmlKeys(htmlKeys)
}

function pinSnapshots(stacks: Map<string, Stack>): PinSnapshot[] {
  return [...stacks].map(([key, stack]) => {
    const position = stack.marker.getLngLat()
    return {
      key,
      coordinates: [position.lng, position.lat],
      category: stack.el.dataset.category!,
      color: stack.el.dataset.color!,
      count: stack.countEl.textContent ?? "",
      main: stack.labelMainEl.textContent ?? "",
      sub: stack.labelSubEl.textContent ?? "",
      booked: stack.el.dataset.booked === "true",
      live: stack.el.dataset.live === "true",
      agent: stack.el.dataset.agent === "true",
      dimmed: stack.el.dataset.dimmed === "true",
    }
  })
}

function LiveMap() {
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stacksRef = useRef(new Map<string, Stack>())
  const pinLayerRef = useRef<EventPinLayer | null>(null)
  const hoveredKeyRef = useRef<string | null>(null)
  const userMarkerRef = useRef<mapboxgl.Marker | null>(null)
  const styleReadyRef = useRef(false)
  // Once the user (or the tour) moves the camera, a late settings fetch must
  // not yank the view back to the configured center.
  const cameraTouchedRef = useRef(false)

  const settings = useGrapevine((s) => s.settings)
  const events = useGrapevine((s) => s.events)
  const selectedId = useGrapevine((s) => s.selectedId)
  const detailOpen = useGrapevine((s) => s.detailOpen)
  const carouselOn = useGrapevine((s) => s.carouselOn)
  const carouselIdx = useGrapevine((s) => s.carouselIdx)
  const trafficOn = useGrapevine((s) => s.trafficOn)
  const mapLayers = useGrapevine((s) => s.mapLayers)
  const userPos = useGrapevine((s) => s.userPos)
  const select = useGrapevine((s) => s.select)
  const agentHighlight = useGrapevine((s) => s.agentHighlight)

  // Shared memoized selectors: one computation feeds the map, list, and
  // carousel, and each keeps its previous reference when a recompute lands on
  // the same result — so a 30s tick that changes nothing skips the marker
  // effect below entirely.
  const visible = useGrapevine(selectVisible)
  const rendered = useGrapevine(selectRendered)
  const tour = useGrapevine(selectTour)
  // Liveness as a stable Set of ids: markers need "is this event live", not
  // the raw clock, and the set's identity only changes when liveness flips.
  const liveIds = useGrapevine(selectLiveIds)
  // Booked events' Apple Maps-style calendar lines ("The Odyssey at 8:35PM"),
  // keyed by event id; identity moves only when a line actually changes.
  const bookedLines = useGrapevine(selectBookedLines)

  const agentIds = useMemo(
    () => new Set(agentHighlight?.ids ?? []),
    [agentHighlight]
  )

  // The search box narrows the map too: ids that survive the query, or null
  // when no search is active (nothing dims). Markers that miss the query
  // recede via data-dimmed instead of unmounting, so the city stays readable
  // and nothing churns while the user types.
  const searchQuery = useGrapevine((s) => s.searchQuery)
  const searched = useGrapevine(selectSearched)
  const searchIds = useMemo(
    () => (searchQuery.trim() ? new Set(searched.map((e) => e.id)) : null),
    [searched, searchQuery]
  )

  // A marker looks "selected" only while its detail sheet is open. Keeping
  // selectedId set through the sheet's close animation is what lets the sheet
  // fade out — but the marker must drop its selected look the moment the sheet
  // starts closing (click-off, Escape, X), not stay stuck highlighted.
  const activeId = detailOpen ? selectedId : null

  // Map lighting tracks the wall clock in the city's own timezone — Pacific for
  // San Diego — so the basemap moves through dawn/day/dusk/night with real time
  // instead of sitting on a fixed preset, unless the user pinned light or dark
  // in the map-layers panel (store.mapTheme). The clock ticks every 30s, but the
  // selector yields the same string until the hour crosses a boundary, so this
  // component doesn't re-render for it. Falls back to LA time until settings
  // arrive.
  const lightPreset = useGrapevine(selectLightPreset)
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
      // A gentler angle draws less distant geometry while keeping 3D depth.
      pitch: 40,
      bearing: -12,
      attributionControl: false,
    })
    map.addControl(
      new mapboxgl.NavigationControl({ visualizePitch: true }),
      "bottom-right"
    )
    const syncPins = () =>
      syncViewportMarkers(
        map,
        stacksRef.current,
        pinLayerRef.current,
        hoveredKeyRef.current
      )
    pinLayerRef.current = new EventPinLayer(map, ICON_SVG, syncPins)

    const hovered = (key: string | null) => {
      if (key === hoveredKeyRef.current) return
      hoveredKeyRef.current = key
      syncPins()
      map.getCanvas().style.cursor = key ? "pointer" : ""
    }
    const hitPin = (point: mapboxgl.PointLike) => {
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y]
      const scale = markerScaleForZoom(map.getZoom())
      let closest: string | null = null
      let distance = window.matchMedia("(pointer: coarse)").matches ? 22 : 20
      // Sprites include transparent padding for shadows. In a dense venue
      // cluster, choose the closest actual dot instead of that padding.
      for (const feature of map.queryRenderedFeatures(point, {
        layers: [EVENT_PIN_LAYER],
      })) {
        const key = feature.properties?.key as string
        const stack = stacksRef.current.get(key)
        if (!stack) continue
        const position = map.project(stack.marker.getLngLat())
        const delta = Math.hypot(
          position.x - x,
          position.y - MARKER_LIFT * scale - y
        )
        if (delta < distance) {
          closest = key
          distance = delta
        }
      }
      return closest
    }
    map.on("mousemove", (e) => {
      if (!pinLayerRef.current?.ready || map.isMoving()) return
      const target = e.originalEvent.target
      const root =
        target instanceof Element
          ? target.closest<HTMLElement>(".gv-marker-root")
          : null
      const key = root?.dataset.stackKey ?? hitPin(e.point)
      hovered(typeof key === "string" ? key : null)
    })
    map.on("mouseout", (e) => {
      const next = e.originalEvent.relatedTarget
      if (next instanceof Node && map.getContainer().contains(next)) return
      hovered(null)
    })
    map.on("click", (e) => {
      if (!pinLayerRef.current?.ready) return
      const key = hitPin(e.point)
      const stack = key ? stacksRef.current.get(key) : undefined
      if (stack) select(stack.events[stack.idx].id)
    })

    // originalEvent is only set for user gestures, not programmatic moves
    map.on("movestart", (e) => {
      if (e.originalEvent) cameraTouchedRef.current = true
      document.documentElement.classList.add("gv-map-moving")
      hovered(null)
    })
    // Reconcile at most ten times a second, outside React. Only attached
    // markers incur Mapbox's per-frame position and occlusion work.
    let lastViewportSync = 0
    const syncViewport = () => {
      syncPins()
      lastViewportSync = performance.now()
    }
    map.on("move", () => {
      if (performance.now() - lastViewportSync >= 100) syncViewport()
    })
    map.on("moveend", () => {
      syncViewport()
      document.documentElement.classList.remove("gv-map-moving")
    })
    map.on("resize", syncViewport)

    // POI-style labels only past neighborhood zoom, so downtown doesn't clutter;
    // markers scale with zoom (via a CSS var that cascades to every .gv-marker).
    // The var write invalidates style for every marker, and "zoom" fires per
    // animation frame during flyTo, so quantize the scale and skip no-op writes
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
      // Basemap layer toggles are persisted; a fresh style resets them to the
      // Standard defaults, so re-apply the stored visibility once it can take
      // config. (The [mapLayers] effect below is a no-op until this runs.)
      const st = useGrapevine.getState()
      for (const l of BASEMAP_LAYERS) {
        map.setConfigProperty(
          "basemap",
          l.config,
          st.mapLayers[l.key] !== false
        )
      }
      // trafficOn is persisted; restore it once the style can take layers
      if (st.trafficOn) addTrafficLayer(map)
    })

    mapRef.current = map
    const stacks = stacksRef.current
    return () => {
      document.documentElement.classList.remove("gv-map-moving")
      styleReadyRef.current = false
      pinLayerRef.current?.dispose()
      pinLayerRef.current = null
      stacks.forEach(({ marker }) => marker.remove())
      stacks.clear()
      userMarkerRef.current = null
      map.remove()
      mapRef.current = null
    }
  }, [select])

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
    : (visible.find((e) => e.id === selectedId) ??
      events.find((e) => e.id === selectedId))
  const focusId = focus?.id
  const focusSeq = carouselOn ? carouselIdx : -1

  // Latest decorate inputs for the stack pager handlers, which live in plain
  // DOM listeners outside React's render cycle. Synced in an effect (not
  // during render); listeners only fire after effects have run.
  const decorCtxRef = useRef({
    liveIds,
    activeId,
    agentIds,
    searchIds,
    bookedLines,
  })
  useEffect(() => {
    decorCtxRef.current = {
      liveIds,
      activeId,
      agentIds,
      searchIds,
      bookedLines,
    }
  }, [liveIds, activeId, agentIds, searchIds, bookedLines])
  // Snap a stack's face to the selected/toured/highlighted event only when
  // that target changes, never on unrelated re-runs, so a face the user
  // paged to by hand isn't yanked back by the next clock tick.
  const lastTargetRef = useRef<string | null>(null)
  const lastAgentSeqRef = useRef(0)
  const lastSearchRef = useRef("")
  const lastBookedRef = useRef<ReadonlyMap<string, string>>(new Map())

  // Search, selection, and liveness only change decoration. Reuse venue
  // groups until the rendered event data actually changes.
  const groups = useMemo(() => {
    const groups = new Map<string, CityEvent[]>()
    for (const e of rendered) {
      const k = locKey(e)
      const g = groups.get(k)
      if (g) g.push(e)
      else groups.set(k, [e])
    }
    return groups
  }, [rendered])

  // --- markers: one stack per location, diffed by location key ---
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

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
    const query = searchQuery.trim()
    const searchChanged = query !== lastSearchRef.current
    lastSearchRef.current = query
    const bookedChanged = bookedLines !== lastBookedRef.current
    lastBookedRef.current = bookedLines

    for (const [key, group] of groups) {
      let stack = stacksRef.current.get(key)
      if (!stack) {
        // Mapbox owns the outer element (positions it via inline transform);
        // visuals + scale/pulse animations live on an inner element so they
        // never fight that transform. Styling the mapbox element directly is
        // what pushed every marker out of place and re-triggered transitions
        // on each animation frame.
        const root = document.createElement("div")
        root.className = "gv-marker-root"
        root.dataset.stackKey = key
        const el = document.createElement("div")
        el.className = "gv-marker"
        // Keep the event button and pager buttons as siblings. A native
        // button gives Enter/Space activation without trapping map keys.
        const triggerEl = document.createElement("button")
        triggerEl.type = "button"
        triggerEl.className = "gv-marker-trigger"
        const iconEl = document.createElement("span")
        iconEl.className = "gv-marker-icon"
        triggerEl.append(iconEl)
        const countEl = document.createElement("span")
        countEl.className = "gv-marker-count"
        const labelEl = document.createElement("div")
        labelEl.className = "gv-marker-label"
        // two lines so a booked face can annotate Apple Maps-style: venue
        // name on top, "event at time" beneath; plain faces leave sub empty
        const labelMainEl = document.createElement("span")
        labelMainEl.className = "gv-marker-label-main"
        const labelSubEl = document.createElement("span")
        labelSubEl.className = "gv-marker-label-sub"
        labelEl.append(labelMainEl, labelSubEl)
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
        el.append(triggerEl, countEl, labelEl, pager)
        root.appendChild(el)

        const marker = new mapboxgl.Marker({
          element: root,
          anchor: "center",
          offset: [0, -MARKER_LIFT],
        }).setLngLat([group[0].lng, group[0].lat])
        // Mapbox assigns role="img" to custom markers. These contain
        // interactive controls, which must stay exposed to screen readers.
        root.setAttribute("role", "group")
        root.setAttribute("aria-label", "Events at this spot")
        const created: Stack = {
          marker,
          attached: false,
          html: false,
          el,
          triggerEl,
          iconEl,
          labelMainEl,
          labelSubEl,
          countEl,
          numEl,
          events: group,
          // a stack born holding a booked event leads with the user's plans
          idx: Math.max(
            0,
            group.findIndex((e) => bookedLines.has(e.id))
          ),
        }

        const cycle = (dir: number) => {
          const n = created.events.length
          if (n < 2) return
          created.idx = (created.idx + dir + n) % n
          const ctx = decorCtxRef.current
          decorateStack(
            created,
            ctx.liveIds,
            ctx.activeId,
            ctx.agentIds,
            ctx.searchIds,
            ctx.bookedLines
          )
          pinLayerRef.current?.update(pinSnapshots(stacksRef.current))
          // Sheet open means the user is inspecting this venue; retarget it.
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
        root.addEventListener("focusin", () => {
          syncViewportMarkers(
            map,
            stacksRef.current,
            pinLayerRef.current,
            hoveredKeyRef.current
          )
        })
        root.addEventListener("focusout", () => {
          // Wait for focus to reach the next button before reconciling.
          queueMicrotask(() => {
            if (mapRef.current === map)
              syncViewportMarkers(
                map,
                stacksRef.current,
                pinLayerRef.current,
                hoveredKeyRef.current
              )
          })
        })

        stack = created
        stacksRef.current.set(key, stack)
      } else if (stack.events !== group) {
        // keep whichever event this stack is showing across list refreshes
        const shownId = stack.events[stack.idx]?.id
        stack.events = group
        const keep = group.findIndex((e) => e.id === shownId)
        stack.idx = keep >= 0 ? keep : 0
        // setLngLat projects the marker again and schedules DOM work, even
        // for identical coordinates. A text/ranking refresh needs neither.
        const position = stack.marker.getLngLat()
        if (position.lng !== group[0].lng || position.lat !== group[0].lat) {
          stack.marker.setLngLat([group[0].lng, group[0].lat])
        }
      }

      if (targetChanged && target) {
        const i = group.findIndex((e) => e.id === target)
        if (i >= 0) stack.idx = i
      } else if (agentChanged && agentIds.size) {
        const i = group.findIndex((e) => agentIds.has(e.id))
        if (i >= 0) stack.idx = i
      } else if (searchChanged && searchIds) {
        // a stack whose shown face misses the query turns to a face that hits
        const i = group.findIndex((e) => searchIds.has(e.id))
        if (i >= 0) stack.idx = i
      } else if (bookedChanged && bookedLines.size) {
        // a fresh booking (or the calendar arriving) surfaces as the face
        const i = group.findIndex((e) => bookedLines.has(e.id))
        if (i >= 0) stack.idx = i
      }
      decorateStack(stack, liveIds, activeId, agentIds, searchIds, bookedLines)
    }
    pinLayerRef.current?.update(pinSnapshots(stacksRef.current))
    syncViewportMarkers(
      map,
      stacksRef.current,
      pinLayerRef.current,
      hoveredKeyRef.current
    )
  }, [
    groups,
    liveIds,
    activeId,
    selectedId,
    focusId,
    carouselOn,
    select,
    agentIds,
    agentHighlight?.seq,
    searchIds,
    searchQuery,
    bookedLines,
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

  // --- basemap layer visibility (Standard-style config toggles) ---
  // Runs on every mapLayers change; guarded until the style can take config,
  // with style.load handling the first apply. mapLayers keeps its reference
  // until setMapLayer swaps it, so unrelated re-renders don't re-apply.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReadyRef.current) return
    for (const l of BASEMAP_LAYERS) {
      map.setConfigProperty("basemap", l.config, mapLayers[l.key] !== false)
    }
  }, [mapLayers])

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
    // the overlays. (Media query, not a hook: read at fly time so rotating
    // the device mid-session picks the right frame.)
    const phone = window.matchMedia("(max-width: 767px)").matches
    map.flyTo({
      center: [focus.lng, focus.lat],
      zoom: carouselOn ? 14.6 : 15.2,
      pitch: carouselOn ? 45 : map.getPitch(),
      bearing: carouselOn ? -30 + (focusSeq % 5) * 18 : map.getBearing(),
      duration: carouselOn ? 2400 : 900,
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
        pitch: map.getPitch(),
        bearing: map.getBearing(),
        duration: 900,
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
  liveIds: ReadonlySet<string>,
  selectedId: string | null,
  agentIds?: Set<string>,
  searchIds?: ReadonlySet<string> | null,
  bookedLines?: ReadonlyMap<string, string>
) {
  const e = stack.events[stack.idx]
  if (!e) return
  const { el } = stack
  const label = `Show ${e.title} at ${e.venue}${
    stack.events.length > 1
      ? ` (event ${stack.idx + 1} of ${stack.events.length})`
      : ""
  }`
  if (stack.triggerEl.getAttribute("aria-label") !== label) {
    stack.triggerEl.setAttribute("aria-label", label)
  }
  // a booked face wears calendar-salmon head to toe (dot, ring, venue name),
  // the way Apple Maps paints a venue holding one of your calendar events
  const bookedLine = bookedLines?.get(e.id)
  const color = bookedLine ? BOOKED_COLOR : CATEGORY_META[e.category].color
  if (el.dataset.color !== color) {
    el.style.setProperty("--marker-color", color)
    el.dataset.color = color
  }
  setData(el, "live", String(liveIds.has(e.id)))
  setData(el, "selected", String(e.id === selectedId))
  setData(el, "agent", String(agentIds?.has(e.id) ?? false))
  setData(el, "booked", String(!!bookedLine))
  setData(el, "stack", String(stack.events.length > 1))
  // dim only when a search is active and nothing at this spot matches it;
  // agent pins stay lit, a dimmed recommendation is half a broken answer
  const dimmed =
    !!searchIds &&
    !stack.events.some((ev) => searchIds.has(ev.id) || agentIds?.has(ev.id))
  setData(el, "dimmed", String(dimmed))
  if (el.dataset.category !== e.category) {
    el.dataset.category = e.category
    stack.iconEl.innerHTML = ICON_SVG[e.category]
  }
  // booked: venue on top, "event at time" beneath; otherwise just the title
  setText(stack.labelMainEl, bookedLine ? e.venue : e.title)
  setText(stack.labelSubEl, bookedLine ?? "")
  setText(
    stack.countEl,
    stack.events.length > 1 ? String(stack.events.length) : ""
  )
  setText(stack.numEl, `${stack.idx + 1}/${stack.events.length}`)
}

/**
 * Without a token Mapbox GL throws at map construction and the whole app
 * white-screens. Say what is missing instead, the way the Supabase client
 * does, so a fresh clone fails in words.
 */
export function EventMap() {
  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background p-8 text-center">
        <div className="max-w-md space-y-2">
          <p className="font-heading text-lg font-semibold">
            The map needs a Mapbox token
          </p>
          <p className="text-sm text-muted-foreground">
            Set <span className="font-mono">VITE_MAPBOX_TOKEN</span> in{" "}
            <span className="font-mono">web/.env.local</span> (a public token
            scoped to styles and tiles) and reload. See web/.env.example.
          </p>
        </div>
      </div>
    )
  }
  return <LiveMap />
}
