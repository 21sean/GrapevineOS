import type { Map as MapboxMap } from "mapbox-gl"
import { BASEMAP_LAYERS } from "@/lib/mapLayers"
import type { LightPreset } from "@/lib/time"

export function basemapConfig(
  lightPreset: LightPreset,
  layers: Record<string, boolean>
): Record<string, string | boolean> {
  return {
    lightPreset,
    ...Object.fromEntries(
      BASEMAP_LAYERS.map((layer) => [layer.config, layers[layer.key] !== false])
    ),
  }
}

/** Config setters invalidate style work even when given the current value. */
export function syncBasemapConfig(
  map: MapboxMap,
  config: ReturnType<typeof basemapConfig>
) {
  for (const [key, value] of Object.entries(config)) {
    if (map.getConfigProperty("basemap", key) !== value)
      map.setConfigProperty("basemap", key, value)
  }
}
