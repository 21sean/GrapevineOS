import { create } from "zustand"
import { persist } from "zustand/middleware"
import type {
  CalendarStatus,
  Category,
  CityEvent,
  Filters,
  Interests,
  Reaction,
  Settings,
  SortKey,
  Source,
  User,
} from "./types"
import { DEFAULT_FILTERS, normalizeFilters } from "./types"
import { DEFAULT_MAP_LAYERS, type MapLayerKey } from "./mapLayers"
import type { MapTheme } from "./time"
import type { PolygonRings } from "./geo"

/**
 * The resolved "Near me" zone for the current filters.nearMinutes + origin.
 * `key` ties it to the request that produced it, so a stale zone is never
 * applied to fresher filters. Either real isochrone polygons or the
 * straight-line fallback when the isochrone API is unreachable.
 */
export interface NearZone {
  key: string
  polygons?: PolygonRings[]
  circle?: { center: [number, number]; km: number }
}

export interface GrapevineState {
  // data
  events: CityEvent[]
  settings: Settings | null
  sources: Source[]
  user: User | null
  calendar: CalendarStatus | null
  loaded: boolean

  // ui
  now: Date
  selectedId: string | null
  detailOpen: boolean
  adminOpen: boolean
  interestsOpen: boolean
  carouselOn: boolean
  carouselIdx: number
  trafficOn: boolean
  // per-basemap-layer visibility (device-local); true = shown. Keyed by the
  // Standard-style config toggles in lib/mapLayers.
  mapLayers: Record<MapLayerKey, boolean>
  // basemap lighting: "auto" follows the city's wall clock, light/dark pin it
  // (device-local; see selectLightPreset)
  mapTheme: MapTheme
  userPos: [number, number] | null
  // width of the left event-list rail, in px (device-local, resizable)
  railWidth: number
  // width of the event-detail side panel, in px (device-local, resizable)
  detailWidth: number
  // "happening now" carousel card: minimized + resizable width (device-local)
  carouselMin: boolean
  carouselWidth: number
  // phone bottom sheet position; the tour card hides above "peek"
  dockState: "peek" | "half" | "full"
  // "Ask Grapevine" agent overlay
  askOpen: boolean
  // provider picker ("Sign in with Google / GitHub")
  signInOpen: boolean
  // in-app Google Calendar popup
  calendarOpen: boolean
  // "Your week" personalized digest panel
  weekOpen: boolean
  // events the agent pinned on the map; seq bumps so repeat highlights re-fly
  agentHighlight: { ids: string[]; fit: boolean; seq: number } | null
  // event-list search box (session-only) and sort order (device-local)
  searchQuery: string
  sortBy: SortKey

  // the fetched "Near me" isochrone (session-only; see useNearZone)
  nearZone: NearZone | null

  // preferences (persisted)
  filters: Filters
  interests: Interests
  // events the user pinned to the top of the list
  pinnedIds: string[]
  // events the user hid from the list and map (restorable)
  hiddenIds: string[]
  // venues/sources the user muted — every event from them drops off the map
  mutedVenues: string[]
  mutedSources: string[]
  // per-event feedback ("going" / "went — great" / "not for me"); server-backed
  // when signed in, this browser otherwise
  reactions: Record<string, Reaction>

  // actions
  load: () => Promise<void>
  tick: () => void
  select: (id: string | null, opts?: { openDetail?: boolean }) => void
  setDetailOpen: (open: boolean) => void
  setAdminOpen: (open: boolean) => void
  setInterestsOpen: (open: boolean) => void
  setCarousel: (on: boolean) => void
  advanceCarousel: (idx: number) => void
  setTraffic: (on: boolean) => void
  setMapLayer: (key: MapLayerKey, visible: boolean) => void
  setMapTheme: (theme: MapTheme) => void
  resetMapLayers: () => void
  setUserPos: (pos: [number, number] | null) => void
  setRailWidth: (px: number) => void
  setDetailWidth: (px: number) => void
  setCarouselMin: (v: boolean) => void
  setCarouselWidth: (px: number) => void
  setDockState: (s: "peek" | "half" | "full") => void
  setAskOpen: (open: boolean) => void
  setSignInOpen: (open: boolean) => void
  setCalendarOpen: (open: boolean) => void
  setWeekOpen: (open: boolean) => void
  setReaction: (id: string, reaction: Reaction | null) => void
  setAgentHighlight: (ids: string[], fit?: boolean) => void
  clearAgentHighlight: () => void
  setSearchQuery: (q: string) => void
  setSortBy: (s: SortKey) => void
  setFilters: (patch: Partial<Filters>) => void
  toggleCategory: (c: Category) => void
  setInterests: (i: Interests) => void
  togglePin: (id: string) => void
  hideEvent: (id: string) => void
  unhideEvent: (id: string) => void
  clearHidden: () => void
  setNearZone: (z: NearZone | null) => void
  muteVenue: (venue: string) => void
  unmuteVenue: (venue: string) => void
  muteSource: (source: string) => void
  unmuteSource: (source: string) => void
  clearMuted: () => void
  signOut: () => Promise<void>
  upsertEvent: (e: CityEvent) => void
  refreshEvents: () => Promise<void>
  setSettings: (s: Settings) => void
  setCalendar: (c: CalendarStatus | null) => void
  refreshCalendar: () => Promise<void>
}

import { api } from "./api"
import { supabase } from "./supabase"

// Debounced push of filters/interests to the signed-in user's account, so a
// burst of filter toggles becomes one PUT. Fire-and-forget: local state is
// the source of truth while the tab is open.
let prefsTimer: ReturnType<typeof setTimeout> | undefined
function schedulePrefsSync(get: () => GrapevineState) {
  if (!get().user) return
  clearTimeout(prefsTimer)
  prefsTimer = setTimeout(() => {
    const { user, filters, interests, pinnedIds, hiddenIds, mutedVenues, mutedSources } =
      get()
    if (user)
      api
        .savePrefs({ filters, interests, pinnedIds, hiddenIds, mutedVenues, mutedSources })
        .catch(() => {})
  }, 800)
}

export const useGrapevine = create<GrapevineState>()(
  persist(
    (set, get) => ({
      events: [],
      settings: null,
      sources: [],
      user: null,
      calendar: null,
      loaded: false,

      now: new Date(),
      selectedId: null,
      detailOpen: false,
      adminOpen: false,
      interestsOpen: false,
      // Off by default: the map opens static (no auto-fly through events).
      // The "happening now" card shows a Play button to start the tour by hand.
      carouselOn: false,
      carouselIdx: 0,
      trafficOn: true,
      mapLayers: { ...DEFAULT_MAP_LAYERS },
      mapTheme: "auto",
      userPos: null,
      railWidth: 340,
      detailWidth: 448,
      carouselMin: false,
      carouselWidth: 440,
      dockState: "peek",
      askOpen: false,
      signInOpen: false,
      calendarOpen: false,
      weekOpen: false,
      agentHighlight: null,
      searchQuery: "",
      sortBy: "relevance",
      nearZone: null,

      filters: DEFAULT_FILTERS,
      interests: { loves: [], avoids: [] },
      pinnedIds: [],
      hiddenIds: [],
      mutedVenues: [],
      mutedSources: [],
      reactions: {},

      async load() {
        const [events, settings, sources, me, calendar] = await Promise.all([
          api.events(),
          api.settings(),
          api.sources(),
          api.me().catch(() => ({ user: null })),
          api.calendarStatus().catch(() => null),
        ])
        // Signed in: account prefs win over what this browser had locally,
        // so filters/interests follow the user across devices.
        const prefs = me.user?.prefs
        // Reactions live in their own table; the account copy is the truth.
        const reactions = me.user
          ? await api
              .reactions()
              .then((r) =>
                Object.fromEntries(r.reactions.map((x) => [x.eventId, x.reaction])),
              )
              .catch(() => null)
          : null
        set({
          events,
          settings,
          sources,
          user: me.user,
          calendar,
          loaded: true,
          ...(prefs?.filters && { filters: normalizeFilters(prefs.filters) }),
          ...(prefs?.interests && { interests: prefs.interests }),
          ...(prefs?.pinnedIds && { pinnedIds: prefs.pinnedIds }),
          ...(prefs?.hiddenIds && { hiddenIds: prefs.hiddenIds }),
          ...(prefs?.mutedVenues && { mutedVenues: prefs.mutedVenues }),
          ...(prefs?.mutedSources && { mutedSources: prefs.mutedSources }),
          ...(reactions && { reactions }),
        })
        // First sign-in from this browser: seed the account with local prefs.
        if (me.user && !prefs) schedulePrefsSync(get)
      },

      tick: () => set({ now: new Date() }),

      select(id, opts) {
        set({
          selectedId: id,
          detailOpen: id !== null && (opts?.openDetail ?? true),
          ...(id !== null && { carouselOn: false }),
        })
      },

      setDetailOpen: (detailOpen) => set({ detailOpen }),
      setAdminOpen: (adminOpen) => set({ adminOpen }),
      setInterestsOpen: (interestsOpen) => set({ interestsOpen }),

      setCarousel(on) {
        set({ carouselOn: on, ...(on && { detailOpen: false, selectedId: null }) })
      },

      advanceCarousel: (carouselIdx) => set({ carouselIdx }),

      setTraffic: (trafficOn) => set({ trafficOn }),

      setMapLayer: (key, visible) =>
        set({ mapLayers: { ...get().mapLayers, [key]: visible } }),

      setMapTheme: (mapTheme) => set({ mapTheme }),

      resetMapLayers: () =>
        set({ mapLayers: { ...DEFAULT_MAP_LAYERS }, trafficOn: true, mapTheme: "auto" }),

      setUserPos: (userPos) => set({ userPos }),
      setRailWidth: (railWidth) => set({ railWidth }),
      setDetailWidth: (detailWidth) => set({ detailWidth }),
      setCarouselMin: (carouselMin) => set({ carouselMin }),
      setCarouselWidth: (carouselWidth) => set({ carouselWidth }),
      setDockState: (dockState) => set({ dockState }),

      setAskOpen(askOpen) {
        // Opening pauses the tour; closing retires the agent's map pins.
        set({ askOpen, ...(askOpen ? { carouselOn: false } : { agentHighlight: null }) })
      },

      setSignInOpen: (signInOpen) => set({ signInOpen }),

      setCalendarOpen: (calendarOpen) => set({ calendarOpen }),

      setWeekOpen: (weekOpen) => set({ weekOpen }),

      setReaction(id, reaction) {
        const next = { ...get().reactions }
        if (reaction) next[id] = reaction
        else delete next[id]
        set({ reactions: next })
        // Fire-and-forget like prefs: local state is the source of truth
        // while the tab is open; signed-out reactions stay in this browser.
        if (get().user) api.setReaction(id, reaction).catch(() => {})
      },

      setAgentHighlight(ids, fit = true) {
        set({
          agentHighlight: { ids, fit, seq: (get().agentHighlight?.seq ?? 0) + 1 },
        })
      },

      clearAgentHighlight: () => set({ agentHighlight: null }),

      setSearchQuery: (searchQuery) => set({ searchQuery }),
      setSortBy: (sortBy) => set({ sortBy }),

      setFilters(patch) {
        set({ filters: { ...get().filters, ...patch } })
        schedulePrefsSync(get)
      },

      toggleCategory(c) {
        const cur = get().filters.categories
        const categories = cur.includes(c)
          ? cur.filter((x) => x !== c)
          : [...cur, c]
        set({ filters: { ...get().filters, categories } })
        schedulePrefsSync(get)
      },

      setInterests(interests) {
        set({ interests })
        schedulePrefsSync(get)
      },

      togglePin(id) {
        const cur = get().pinnedIds
        const pinnedIds = cur.includes(id)
          ? cur.filter((x) => x !== id)
          : [id, ...cur]
        set({ pinnedIds })
        schedulePrefsSync(get)
      },

      hideEvent(id) {
        const { hiddenIds, pinnedIds, selectedId } = get()
        if (hiddenIds.includes(id)) return
        set({
          hiddenIds: [id, ...hiddenIds],
          // hiding and pinning contradict each other — the newer intent wins
          ...(pinnedIds.includes(id) && {
            pinnedIds: pinnedIds.filter((x) => x !== id),
          }),
          ...(selectedId === id && { selectedId: null, detailOpen: false }),
        })
        schedulePrefsSync(get)
      },

      unhideEvent(id) {
        set({ hiddenIds: get().hiddenIds.filter((x) => x !== id) })
        schedulePrefsSync(get)
      },

      clearHidden() {
        set({ hiddenIds: [] })
        schedulePrefsSync(get)
      },

      setNearZone: (nearZone) => set({ nearZone }),

      muteVenue(venue) {
        const cur = get().mutedVenues
        if (cur.some((v) => v.toLowerCase() === venue.toLowerCase())) return
        set({ mutedVenues: [venue, ...cur] })
        schedulePrefsSync(get)
      },

      unmuteVenue(venue) {
        set({
          mutedVenues: get().mutedVenues.filter(
            (v) => v.toLowerCase() !== venue.toLowerCase(),
          ),
        })
        schedulePrefsSync(get)
      },

      muteSource(source) {
        const cur = get().mutedSources
        if (cur.some((v) => v.toLowerCase() === source.toLowerCase())) return
        set({ mutedSources: [source, ...cur] })
        schedulePrefsSync(get)
      },

      unmuteSource(source) {
        set({
          mutedSources: get().mutedSources.filter(
            (v) => v.toLowerCase() !== source.toLowerCase(),
          ),
        })
        schedulePrefsSync(get)
      },

      clearMuted() {
        set({ mutedVenues: [], mutedSources: [] })
        schedulePrefsSync(get)
      },

      async signOut() {
        clearTimeout(prefsTimer)
        // Supabase Auth owns the session; local scope keeps other devices
        // signed in.
        await supabase?.auth.signOut({ scope: "local" }).catch(() => {})
        set({ user: null, calendar: null })
      },

      upsertEvent(e) {
        set({
          events: get().events.some((x) => x.id === e.id)
            ? get().events.map((x) => (x.id === e.id ? e : x))
            : [...get().events, e],
        })
      },

      async refreshEvents() {
        set({ events: await api.events() })
      },

      setSettings: (settings) => set({ settings }),

      setCalendar: (calendar) => set({ calendar }),

      async refreshCalendar() {
        set({ calendar: await api.calendarStatus().catch(() => null) })
      },
    }),
    {
      name: "grapevine-prefs",
      version: 5,
      partialize: (s) => ({
        filters: s.filters,
        interests: s.interests,
        pinnedIds: s.pinnedIds,
        hiddenIds: s.hiddenIds,
        mutedVenues: s.mutedVenues,
        mutedSources: s.mutedSources,
        reactions: s.reactions,
        railWidth: s.railWidth,
        detailWidth: s.detailWidth,
        carouselWidth: s.carouselWidth,
        carouselMin: s.carouselMin,
        sortBy: s.sortBy,
        mapLayers: s.mapLayers,
        mapTheme: s.mapTheme,
      }),
      // v0 persisted a `trafficOn` toggle; traffic is now always on, so drop
      // the stored value and let the `true` default win.
      // v2 replaced filters.farmersOnly with the tri-state filters.farmers.
      // v3 added filters.nearMinutes (normalize fills the missing key).
      // v4 added filters.hideCategories (normalize fills the missing key).
      // v5 added mapLayers (fill any missing basemap toggle with its default).
      // mapTheme needs no migration: it's a scalar, so an older payload simply
      // leaves it absent and persist's shallow merge keeps the "auto" default.
      migrate: (persisted, version) => {
        const p = persisted as Record<string, unknown> | undefined
        if (version < 1 && p && typeof p === "object") {
          delete p.trafficOn
        }
        if (version < 4 && p && typeof p === "object" && p.filters) {
          p.filters = normalizeFilters(p.filters)
        }
        if (version < 5 && p && typeof p === "object") {
          p.mapLayers = {
            ...DEFAULT_MAP_LAYERS,
            ...(p.mapLayers as Partial<Record<MapLayerKey, boolean>> | undefined),
          }
        }
        return persisted as GrapevineState
      },
    },
  ),
)
