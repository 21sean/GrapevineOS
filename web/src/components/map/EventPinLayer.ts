import type { FeatureCollection, Point } from "geojson"
import type { GeoJSONSource, Map as MapboxMap } from "mapbox-gl"

export const EVENT_PIN_LAYER = "gv-event-pins"
const SOURCE = "gv-event-locations"
const LABEL_LAYER = "gv-event-labels"
const SCALE = ["interpolate", ["linear"], ["zoom"], 10, 0.6, 14, 1] as const

export interface PinSnapshot {
  key: string
  coordinates: [number, number]
  category: string
  color: string
  count: string
  main: string
  sub: string
  booked: boolean
  live: boolean
  agent: boolean
  dimmed: boolean
}

interface Sprite {
  signature: string
}

function canvas(width: number, height: number) {
  const el = document.createElement("canvas")
  el.width = width * 2
  el.height = height * 2
  const ctx = el.getContext("2d")!
  ctx.scale(2, 2)
  return { el, ctx }
}

function dot(pin: PinSnapshot, glyph: HTMLImageElement) {
  const { el, ctx } = canvas(64, 48)
  ctx.fillStyle = pin.color
  ctx.shadowColor = pin.agent ? "#c15c97" : pin.live ? "#ecc663" : "#0008"
  ctx.shadowBlur = pin.agent || pin.live ? 14 : 8
  ctx.shadowOffsetY = 2
  ctx.beginPath()
  ctx.arc(32, 24, 11, 0, Math.PI * 2)
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0
  ctx.strokeStyle = "#29232b"
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.drawImage(glyph, 25.5, 17.5, 13, 13)
  if (pin.count) {
    ctx.fillStyle = "#f3f4f6"
    ctx.font = "700 10px Arial"
    const width = Math.max(15, ctx.measureText(pin.count).width + 6)
    ctx.beginPath()
    ctx.roundRect(38, 6, width, 15, 7.5)
    ctx.fill()
    ctx.fillStyle = "#29232b"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(pin.count, 38 + width / 2, 14)
  }
  return ctx.getImageData(0, 0, el.width, el.height)
}

function label(pin: PinSnapshot) {
  // Rasterize only when the face changes, not during pan/zoom. Keeping text
  // in the sprite also avoids a separate glyph request on first label reveal.
  const { el, ctx } = canvas(164, 96)
  const maxWidth = pin.booked ? 150 : 118
  const lines: { text: string; color: string; font: string }[] = []
  const append = (text: string, color: string, font: string) => {
    ctx.font = font
    let line = ""
    for (const word of text.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push({ text: line, color, font })
        line = word
      } else line = next
    }
    if (line) lines.push({ text: line, color, font })
  }
  append(
    pin.main,
    pin.booked ? pin.color : "#f3f4f6",
    `${pin.booked ? 600 : 500} 11.5px Arial`
  )
  if (pin.sub) append(pin.sub, "#f3f4f6", "500 11px Arial")
  const height = Math.min(lines.length, 5) * 14 + 4
  const width = Math.min(
    152,
    Math.max(
      ...lines.map((line) => {
        ctx.font = line.font
        return ctx.measureText(line.text).width
      }),
      0
    ) + 14
  )
  if (!pin.booked) {
    ctx.shadowColor = "#0007"
    ctx.shadowBlur = 8
    ctx.shadowOffsetY = 2
    ctx.fillStyle = "#211d29eb"
    ctx.beginPath()
    ctx.roundRect(82 - width / 2, 6, width, height, 7)
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
    ctx.strokeStyle = "#ffffff1f"
    ctx.lineWidth = 1
    ctx.stroke()
  }
  ctx.textAlign = "center"
  ctx.textBaseline = "top"
  lines.slice(0, 5).forEach((line, i) => {
    ctx.font = line.font
    ctx.fillStyle = line.color
    if (pin.booked) {
      ctx.shadowColor = "#211d29"
      ctx.shadowBlur = 4
    }
    ctx.fillText(line.text, 82, 8 + i * 14, maxWidth)
  })
  return ctx.getImageData(0, 0, el.width, el.height)
}

/** Ordinary pins live in Mapbox's canvas. HTML is reserved for inspection. */
export class EventPinLayer {
  ready = false
  private disposed = false
  private pins: PinSnapshot[] = []
  private sprites = new Map<string, Sprite>()
  private glyphs = new Map<string, HTMLImageElement>()
  private glyphsReady = false
  private htmlKeys: string[] = []
  private htmlSignature = ""
  private installed = false
  private dataSignature = ""
  private map: MapboxMap
  private onReady: () => void

  constructor(
    map: MapboxMap,
    icons: Record<string, string>,
    onReady: () => void
  ) {
    this.map = map
    this.onReady = onReady
    map.on("style.load", this.install)
    void Promise.all(
      Object.entries(icons).map(async ([category, svg]) => {
        const img = new Image()
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/currentColor/g, "#332b44"))}`
        await img.decode()
        this.glyphs.set(category, img)
      })
    )
      .then(() => {
        this.glyphsReady = true
        if (!this.disposed && map.isStyleLoaded()) this.install()
      })
      .catch(() => {
        // The HTML renderer remains usable if image decoding is unavailable.
      })
  }

  private install = () => {
    if (this.disposed || !this.glyphsReady || this.map.getSource(SOURCE)) return
    this.installed = false
    this.ready = false
    this.sprites.clear()
    this.dataSignature = ""
    this.map.addSource(SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    })
    this.map.addLayer({
      id: EVENT_PIN_LAYER,
      type: "symbol",
      source: SOURCE,
      layout: {
        "icon-image": ["get", "dot"],
        "icon-size": [...SCALE],
        "icon-offset": [0, -16],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-pitch-alignment": "viewport",
        "icon-rotation-alignment": "viewport",
      },
      paint: { "icon-opacity": ["case", ["get", "dimmed"], 0.25, 1] },
    })
    this.map.addLayer({
      id: LABEL_LAYER,
      type: "symbol",
      source: SOURCE,
      layout: {
        "icon-image": ["get", "label"],
        "icon-size": [...SCALE],
        "icon-anchor": "top",
        "icon-offset": [0, -5],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-pitch-alignment": "viewport",
        "icon-rotation-alignment": "viewport",
      },
      paint: {
        "icon-opacity": [
          "step",
          ["zoom"],
          ["case", ["get", "booked"], 1, 0],
          13,
          ["case", ["get", "dimmed"], 0.25, 1],
        ],
      },
    })
    this.installed = true
    this.update(this.pins)
    this.htmlSignature = ""
    this.setHtmlKeys(this.htmlKeys)
    this.ready = true
    this.onReady()
  }

  update(pins: PinSnapshot[]) {
    this.pins = pins
    if (!this.installed) return
    const signature = JSON.stringify(pins)
    if (signature === this.dataSignature) return
    const wanted = new Set<string>()
    const data: FeatureCollection<Point> = {
      type: "FeatureCollection",
      features: pins.map((pin) => {
        const dotId = `gv-dot-${pin.key}`
        const labelId = `gv-label-${pin.key}`
        wanted.add(dotId)
        wanted.add(labelId)
        const dotSignature = JSON.stringify([
          pin.category,
          pin.color,
          pin.count,
          pin.live,
          pin.agent,
        ])
        const labelSignature = JSON.stringify([
          pin.main,
          pin.sub,
          pin.color,
          pin.booked,
        ])
        this.image(dotId, dotSignature, () =>
          dot(pin, this.glyphs.get(pin.category)!)
        )
        this.image(labelId, labelSignature, () => label(pin))
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: pin.coordinates },
          properties: {
            key: pin.key,
            dot: dotId,
            label: labelId,
            dimmed: pin.dimmed,
            booked: pin.booked,
          },
        }
      }),
    }
    ;(this.map.getSource(SOURCE) as GeoJSONSource).setData(data)
    this.dataSignature = signature
    for (const id of this.sprites.keys()) {
      if (wanted.has(id)) continue
      this.map.removeImage(id)
      this.sprites.delete(id)
    }
  }

  private image(id: string, signature: string, draw: () => ImageData) {
    const old = this.sprites.get(id)
    if (old?.signature === signature) return
    const data = draw()
    if (old) this.map.updateImage(id, data)
    else this.map.addImage(id, data, { pixelRatio: 2 })
    this.sprites.set(id, { signature })
  }

  setHtmlKeys(keys: string[]) {
    this.htmlKeys = keys
    if (!this.installed) return
    const signature = JSON.stringify(keys)
    if (signature === this.htmlSignature) return
    this.htmlSignature = signature
    const filter = ["!", ["in", ["get", "key"], ["literal", keys]]] as const
    this.map.setFilter(EVENT_PIN_LAYER, [...filter])
    this.map.setFilter(LABEL_LAYER, [...filter])
  }

  dispose() {
    this.disposed = true
    this.map.off("style.load", this.install)
    this.sprites.clear()
  }
}
