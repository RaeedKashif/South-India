/**
 * Geographic projection + point-in-polygon classification.
 *
 * The hex grid lives in a flat "world pixel" space. To anchor that grid to the
 * real planet (so a hex can know its lon/lat and which country it falls in) we
 * use a simple equirectangular projection over the region's bounding box.
 *
 * Equirectangular is fine at country/regional scale and keeps the math trivial
 * and invertible. If we later need a globe or true-area maps, only this file
 * changes — the hex math and game data are projection-agnostic.
 */

export interface BBox {
  lonMin: number
  latMin: number
  lonMax: number
  latMax: number
}

export class Projection {
  readonly width: number
  readonly height: number

  constructor(public readonly bbox: BBox, public readonly pxPerDeg: number) {
    this.width = (bbox.lonMax - bbox.lonMin) * pxPerDeg
    this.height = (bbox.latMax - bbox.latMin) * pxPerDeg
  }

  /** lon/lat -> world pixel (y grows downward, so latitude is flipped). */
  lonLatToPixel(lon: number, lat: number): { x: number; y: number } {
    return {
      x: (lon - this.bbox.lonMin) * this.pxPerDeg,
      y: (this.bbox.latMax - lat) * this.pxPerDeg,
    }
  }

  /** world pixel -> lon/lat. */
  pixelToLonLat(x: number, y: number): { lon: number; lat: number } {
    return {
      lon: this.bbox.lonMin + x / this.pxPerDeg,
      lat: this.bbox.latMax - y / this.pxPerDeg,
    }
  }
}

// ── Point-in-polygon (ray casting) ──────────────────────────────────────────
// GeoJSON coordinates are [lon, lat]; we test in lon/lat space directly.

type Ring = number[][]

function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/** A polygon = [outerRing, ...holes]. Inside outer and outside every hole. */
function pointInPolygon(lon: number, lat: number, polygon: Ring[]): boolean {
  if (!pointInRing(lon, lat, polygon[0])) return false
  for (let h = 1; h < polygon.length; h++) {
    if (pointInRing(lon, lat, polygon[h])) return false
  }
  return true
}

export interface GeoFeature {
  iso: string
  name: string
  /** Normalised to a list of polygons (Polygon -> 1, MultiPolygon -> many). */
  polygons: Ring[][]
  bbox: BBox // precomputed for fast rejection
}

/** Normalise a raw GeoJSON FeatureCollection into GeoFeature[] with bboxes. */
export function prepareFeatures(geojson: any): GeoFeature[] {
  const feats: GeoFeature[] = []
  for (const f of geojson.features) {
    const g = f.geometry
    const polygons: Ring[][] = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
    let lonMin = Infinity
    let latMin = Infinity
    let lonMax = -Infinity
    let latMax = -Infinity
    for (const poly of polygons) {
      for (const [lon, lat] of poly[0]) {
        if (lon < lonMin) lonMin = lon
        if (lon > lonMax) lonMax = lon
        if (lat < latMin) latMin = lat
        if (lat > latMax) latMax = lat
      }
    }
    feats.push({
      iso: f.properties.iso,
      name: f.properties.name,
      polygons,
      bbox: { lonMin, latMin, lonMax, latMax },
    })
  }
  return feats
}

/** Which feature (country) contains this point? null = sea / outside all. */
export function classifyPoint(lon: number, lat: number, features: GeoFeature[]): GeoFeature | null {
  for (const feat of features) {
    const b = feat.bbox
    if (lon < b.lonMin || lon > b.lonMax || lat < b.latMin || lat > b.latMax) continue
    for (const poly of feat.polygons) {
      if (pointInPolygon(lon, lat, poly)) return feat
    }
  }
  return null
}
