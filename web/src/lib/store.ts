import { create } from "zustand"
import { persist } from "zustand/middleware"
import type {
  Category,
  CityEvent,
  Filters,
  Interests,
  Settings,
  Source,
  User,
} from "./types"
import { DEFAULT_FILTERS } from "./types"

interface GrapevineState {
  // data
  events: CityEvent[]
  settings: Settings | null
  sources: Source[]
  user: User | null
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

  // preferences (persisted)
  filters: Filters
  interests: Interests

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
  setFilters: (patch: Partial<Filters>) => void
  toggleCategory: (c: Category) => void
  setInterests: (i: Interests) => void
  signOut: () => Promise<void>
  upsertEvent: (e: CityEvent) => void
  refreshEvents: () => Promise<void>
  setSettings: (s: Settings) => void
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
    const { user, filters, interests } = get()
    if (user) api.savePrefs({ filters, interests }).catch(() => {})
  }, 800)
}

export const useGrapevine = create<GrapevineState>()(
  persist(
    (set, get) => ({
      events: [],
      settings: null,
      sources: [],
      user: null,
      loaded: false,

      now: new Date(),
      selectedId: null,
      detailOpen: false,
      adminOpen: false,
      interestsOpen: false,
      carouselOn: true,
      carouselIdx: 0,
      trafficOn: false,
      userPos: null,

      filters: DEFAULT_FILTERS,
      interests: { loves: [], avoids: [] },

      async load() {
        const [events, settings, sources, me] = await Promise.all([
          api.events(),
          api.settings(),
          api.sources(),
          api.me().catch(() => ({ user: null })),
        ])
        // Signed in: account prefs win over what this browser had locally,
        // so filters/interests follow the user across devices.
        const prefs = me.user?.prefs
        set({
          events,
          settings,
          sources,
          user: me.user,
          loaded: true,
          ...(prefs?.filters && { filters: { ...DEFAULT_FILTERS, ...prefs.filters } }),
          ...(prefs?.interests && { interests: prefs.interests }),
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

      async signOut() {
        clearTimeout(prefsTimer)
        await api.logout().catch(() => {})
        set({ user: null })
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
    }),
    {
      name: "grapevine-prefs",
      partialize: (s) => ({
        filters: s.filters,
        interests: s.interests,
        trafficOn: s.trafficOn,
      }),
    },
  ),
)
