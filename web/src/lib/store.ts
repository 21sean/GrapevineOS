import { create } from "zustand"
import { persist } from "zustand/middleware"
import type {
  CalendarStatus,
  Category,
  CityEvent,
  Filters,
  Interests,
  Settings,
  SortKey,
  Source,
  User,
} from "./types"
import { DEFAULT_FILTERS, normalizeFilters } from "./types"

interface GrapevineState {
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
  userPos: [number, number] | null
  // width of the left event-list rail, in px (device-local, resizable)
  railWidth: number
  // "happening now" carousel card: minimized + resizable width (device-local)
  carouselMin: boolean
  carouselWidth: number
  // phone bottom sheet position; the tour card hides above "peek"
  dockState: "peek" | "half" | "full"
  // "Ask Grapevine" agent overlay
  askOpen: boolean
  // in-app Google Calendar popup
  calendarOpen: boolean
  // events the agent pinned on the map; seq bumps so repeat highlights re-fly
  agentHighlight: { ids: string[]; fit: boolean; seq: number } | null
  // event-list search box (session-only) and sort order (device-local)
  searchQuery: string
  sortBy: SortKey

  // preferences (persisted)
  filters: Filters
  interests: Interests
  // events the user pinned to the top of the list
  pinnedIds: string[]
  // events the user hid from the list and map (restorable)
  hiddenIds: string[]

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
  setUserPos: (pos: [number, number] | null) => void
  setRailWidth: (px: number) => void
  setCarouselMin: (v: boolean) => void
  setCarouselWidth: (px: number) => void
  setDockState: (s: "peek" | "half" | "full") => void
  setAskOpen: (open: boolean) => void
  setCalendarOpen: (open: boolean) => void
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
  signOut: () => Promise<void>
  upsertEvent: (e: CityEvent) => void
  refreshEvents: () => Promise<void>
  setSettings: (s: Settings) => void
  setCalendar: (c: CalendarStatus | null) => void
  refreshCalendar: () => Promise<void>
}

import { api } from "./api"

// Debounced push of filters/interests to the signed-in user's account, so a
// burst of filter toggles becomes one PUT. Fire-and-forget: local state is
// the source of truth while the tab is open.
let prefsTimer: ReturnType<typeof setTimeout> | undefined
function schedulePrefsSync(get: () => GrapevineState) {
  if (!get().user) return
  clearTimeout(prefsTimer)
  prefsTimer = setTimeout(() => {
    const { user, filters, interests, pinnedIds, hiddenIds } = get()
    if (user) api.savePrefs({ filters, interests, pinnedIds, hiddenIds }).catch(() => {})
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
      carouselOn: true,
      carouselIdx: 0,
      trafficOn: true,
      userPos: null,
      railWidth: 340,
      carouselMin: false,
      carouselWidth: 440,
      dockState: "peek",
      askOpen: false,
      calendarOpen: false,
      agentHighlight: null,
      searchQuery: "",
      sortBy: "relevance",

      filters: DEFAULT_FILTERS,
      interests: { loves: [], avoids: [] },
      pinnedIds: [],
      hiddenIds: [],

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
      setUserPos: (userPos) => set({ userPos }),
      setRailWidth: (railWidth) => set({ railWidth }),
      setCarouselMin: (carouselMin) => set({ carouselMin }),
      setCarouselWidth: (carouselWidth) => set({ carouselWidth }),
      setDockState: (dockState) => set({ dockState }),

      setAskOpen(askOpen) {
        // Opening pauses the tour; closing retires the agent's map pins.
        set({ askOpen, ...(askOpen ? { carouselOn: false } : { agentHighlight: null }) })
      },

      setCalendarOpen: (calendarOpen) => set({ calendarOpen }),

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

      async signOut() {
        clearTimeout(prefsTimer)
        await api.logout().catch(() => {})
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
      version: 2,
      partialize: (s) => ({
        filters: s.filters,
        interests: s.interests,
        pinnedIds: s.pinnedIds,
        hiddenIds: s.hiddenIds,
        railWidth: s.railWidth,
        carouselWidth: s.carouselWidth,
        carouselMin: s.carouselMin,
        sortBy: s.sortBy,
      }),
      // v0 persisted a `trafficOn` toggle; traffic is now always on, so drop
      // the stored value and let the `true` default win.
      // v2 replaced filters.farmersOnly with the tri-state filters.farmers.
      migrate: (persisted, version) => {
        const p = persisted as Record<string, unknown> | undefined
        if (version < 1 && p && typeof p === "object") {
          delete p.trafficOn
        }
        if (version < 2 && p && typeof p === "object" && p.filters) {
          p.filters = normalizeFilters(p.filters)
        }
        return persisted as GrapevineState
      },
    },
  ),
)
