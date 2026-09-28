/**
 * Geometry for the "Near me" filter. The zone is a Mapbox isochrone
 * (GeoJSON polygons of "reachable within N minutes of driving"), so
 * membership is a point-in-polygon test. When the isochrone API is
 * unreachable the hook falls back to a plain radius derived from city
 * driving speed, tested with haversine.
 */

/** One polygon as GeoJSON rings: [outer, hole, hole…], each a [lng,lat] list. */
export type PolygonRings = [number, number][][]

/** Ray-cast one ring; on-edge points count as inside (good enough for a filter). */
function inRing(pt: [number, number], ring: [number, number][]): boolean {
  const [x, y] = pt
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** Inside the outer ring and outside every hole, for any of the polygons. */
export function pointInPolygons(
  pt: [number, number],
  polygons: PolygonRings[]
): boolean {
  for (const rings of polygons) {
    if (!rings.length) continue
    if (!inRing(pt, rings[0])) continue
    if (rings.slice(1).some((hole) => inRing(pt, hole))) continue
    return true
  }
  return false
}

const EARTH_R_KM = 6371

/** Great-circle distance between two [lng, lat] points, in km. */
export function haversineKm(a: [number, number], b: [number, number]): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b[1] - a[1])
  const dLng = rad(b[0] - a[0])
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R_KM * Math.asin(Math.sqrt(s))
}
