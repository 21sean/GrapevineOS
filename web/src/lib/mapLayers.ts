import {
  Building2Icon,
  FootprintsIcon,
  SignpostIcon,
  StoreIcon,
  TrainFrontIcon,
  TypeIcon,
  type LucideIcon,
} from "lucide-react"

/**
 * The Mapbox Standard basemap layers the user can hide from the map. Each maps
 * to a Standard-style configuration property set via
 * `map.setConfigProperty("basemap", config, visible)`. Live traffic is a
 * separate custom overlay (see store.trafficOn / EventMap). It isn't part of
 * the basemap config, so it rides in the same panel but its own toggle.
 */
export interface BasemapLayer {
  /** Store key under state.mapLayers. */
  key: string
  /** Standard-style config property name. */
  config: string
  label: string
  hint: string
  icon: LucideIcon
}

export const BASEMAP_LAYERS = [
  {
    key: "poiLabels",
    config: "showPointOfInterestLabels",
    label: "Points of interest",
    hint: "Shops, cafes, businesses",
    icon: StoreIcon,
  },
  {
    key: "placeLabels",
    config: "showPlaceLabels",
    label: "Place names",
    hint: "Neighborhoods & cities",
    icon: TypeIcon,
  },
  {
    key: "roadLabels",
    config: "showRoadLabels",
    label: "Street names",
    hint: "Road names & shields",
    icon: SignpostIcon,
  },
  {
    key: "transitLabels",
    config: "showTransitLabels",
    label: "Transit",
    hint: "Stations & stops",
    icon: TrainFrontIcon,
  },
  {
    key: "buildings3d",
    config: "show3dObjects",
    label: "3D buildings",
    hint: "Buildings, trees & landmarks",
    icon: Building2Icon,
  },
  {
    key: "pedestrianRoads",
    config: "showPedestrianRoads",
    label: "Walking paths",
    hint: "Sidewalks, paths & trails",
    icon: FootprintsIcon,
  },
] as const satisfies readonly BasemapLayer[]

export type MapLayerKey = (typeof BASEMAP_LAYERS)[number]["key"]

/** Everything visible by default, mirroring the Standard style out of the box. */
export const DEFAULT_MAP_LAYERS = Object.fromEntries(
  BASEMAP_LAYERS.map((l) => [l.key, true])
) as Record<MapLayerKey, boolean>
