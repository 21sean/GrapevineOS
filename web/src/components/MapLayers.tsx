import type { ReactNode } from "react"
import {
  LayersIcon,
  MoonIcon,
  SunIcon,
  SunMoonIcon,
  TrafficConeIcon,
  type LucideIcon,
} from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useGrapevine } from "@/lib/store"
import { selectAutoLightPreset } from "@/lib/derived"
import { BASEMAP_LAYERS } from "@/lib/mapLayers"
import type { MapTheme } from "@/lib/time"
import { cn } from "@/lib/utils"

/** Lighting override: follow the city's clock, or pin the map light/dark. */
const THEME_OPTIONS = [
  { value: "auto", label: "Auto", icon: SunMoonIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
] as const satisfies readonly {
  value: MapTheme
  label: string
  icon: LucideIcon
}[]

/**
 * Map layers control: a floating glass button on the map that opens a popover
 * (collapsed by default) for hiding Mapbox basemap layers (POI labels, place
 * names, streets, transit, 3D buildings, walking paths) plus the live-traffic
 * overlay and the lighting override. Every toggle drives a Standard-style
 * config property through the store (see lib/mapLayers + EventMap); traffic is
 * the one custom overlay.
 */
export function MapLayers() {
  const mapLayers = useGrapevine((s) => s.mapLayers)
  const setMapLayer = useGrapevine((s) => s.setMapLayer)
  const resetMapLayers = useGrapevine((s) => s.resetMapLayers)
  const trafficOn = useGrapevine((s) => s.trafficOn)
  const setTraffic = useGrapevine((s) => s.setTraffic)
  const mapTheme = useGrapevine((s) => s.mapTheme)
  const setMapTheme = useGrapevine((s) => s.setMapTheme)
  // What the clock would pick, shown as the hint so "Auto" says what it means.
  const autoPreset = useGrapevine(selectAutoLightPreset)

  const hiddenCount =
    BASEMAP_LAYERS.filter((l) => mapLayers[l.key] === false).length +
    (trafficOn ? 0 : 1)
  // The badge counts hidden layers only, but Reset clears the lighting
  // override too, so it has to appear when that alone is off-default.
  const customized = hiddenCount > 0 || mapTheme !== "auto"

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Map layers"
          title="Map layers"
          className="glass absolute top-20 right-4 z-10 grid size-11 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=open]:text-foreground"
        >
          <LayersIcon className="size-[18px]" />
          {hiddenCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-wine font-mono text-[9px] font-medium text-white">
              {hiddenCount}
            </span>
          )}
        </button>
      </PopoverTrigger>

      {/* The lighting row pushed the panel past a short viewport, so cap it at
          the space Radix measured and let it scroll rather than run off-screen. */}
      <PopoverContent
        align="end"
        sideOffset={8}
        className="max-h-(--radix-popover-content-available-height) w-64 overflow-y-auto p-3"
      >
        <PopoverHeader className="mb-1 flex-row items-center justify-between">
          <PopoverTitle className="flex items-center gap-2">
            <LayersIcon className="size-3.5 text-muted-foreground" />
            Map layers
          </PopoverTitle>
          {customized && (
            <button
              type="button"
              onClick={resetMapLayers}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Reset
            </button>
          )}
        </PopoverHeader>

        <SectionLabel>Lighting</SectionLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={mapTheme}
          // Radix clears the value when the active item is pressed again; the
          // lighting always has to be one of the three, so ignore the empty.
          onValueChange={(v) => v && setMapTheme(v as MapTheme)}
          className="mt-1 mb-0.5 w-full"
        >
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <ToggleGroupItem
              key={value}
              value={value}
              aria-label={`${label} map`}
              className="flex-1 gap-1.5 text-xs"
            >
              <Icon className="size-3.5" />
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="px-1.5 text-xs text-muted-foreground">
          {mapTheme === "auto"
            ? `Follows the local clock — ${autoPreset} right now`
            : "Pinned, ignoring the time of day"}
        </span>

        <Separator className="my-1.5" />
        <SectionLabel>Basemap</SectionLabel>
        <div className="flex flex-col">
          {BASEMAP_LAYERS.map((l) => (
            <LayerRow
              key={l.key}
              icon={l.icon}
              label={l.label}
              hint={l.hint}
              checked={mapLayers[l.key] !== false}
              onChange={(v) => setMapLayer(l.key, v)}
            />
          ))}
        </div>

        <Separator className="my-1.5" />
        <SectionLabel>Overlays</SectionLabel>
        <div className="flex flex-col">
          <LayerRow
            icon={TrafficConeIcon}
            label="Live traffic"
            hint="Congestion colors"
            checked={trafficOn}
            onChange={setTraffic}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="px-1.5 font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
      {children}
    </span>
  )
}

function LayerRow({
  icon: Icon,
  label,
  hint,
  checked,
  onChange,
}: {
  icon: LucideIcon
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center justify-between gap-3 rounded-md px-1.5 py-1.5 transition-colors hover:bg-accent/60",
        !checked && "opacity-60"
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm leading-tight">{label}</span>
          <span className="truncate text-xs text-muted-foreground">{hint}</span>
        </span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
