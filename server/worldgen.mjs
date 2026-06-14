// World generator — produces the full-planet hex grid and classifies every hex
// against real country borders. Pure JS port of the client hex/geo math so the
// authoritative map can be generated and stored server-side.

import { colorForIso } from './regions.mjs'

const SQRT3 = Math.sqrt(3)
const axialKey = (q, r) => `${q},${r}`

const NEIGHBORS = [
  [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
]

function climateFor(lat, elevation) {
  if (elevation > 2500) return 'highland'
  const a = Math.abs(lat)
  if (a < 12) return 'tropical'
  if (a < 23) return 'arid'
  if (a < 35) return 'temperate'
  return 'continental'
}

// ── point-in-polygon ────────────────────────────────────────────────────────
function pointInRing(lon, lat, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function pointInPolygon(lon, lat, polygon) {
  if (!pointInRing(lon, lat, polygon[0])) return false
  for (let h = 1; h < polygon.length; h++) if (pointInRing(lon, lat, polygon[h])) return false
  return true
}

function prepareFeatures(geojson) {
  const feats = []
  for (const f of geojson.features) {
    const g = f.geometry
    if (!g) continue
    const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
    let lonMin = Infinity, latMin = Infinity, lonMax = -Infinity, latMax = -Infinity
    for (const poly of polygons)
      for (const [lon, lat] of poly[0]) {
        if (lon < lonMin) lonMin = lon
        if (lon > lonMax) lonMax = lon
        if (lat < latMin) latMin = lat
        if (lat > latMax) latMax = lat
      }
    const iso = f.properties.ISO_A3 && f.properties.ISO_A3 !== '-99' ? f.properties.ISO_A3 : f.properties.ADM0_A3
    feats.push({ iso, name: f.properties.ADMIN || f.properties.NAME, polygons, bbox: [lonMin, latMin, lonMax, latMax] })
  }
  return feats
}

function classify(lon, lat, feats) {
  for (const f of feats) {
    const [a, b, c, d] = f.bbox
    if (lon < a || lon > c || lat < b || lat > d) continue
    for (const poly of f.polygons) if (pointInPolygon(lon, lat, poly)) return f
  }
  return null
}

function representativePoint(feat) {
  let best = feat.polygons[0][0]
  for (const poly of feat.polygons) if (poly[0].length > best.length) best = poly[0]
  let lon = 0, lat = 0
  for (const [x, y] of best) { lon += x; lat += y }
  return { lon: lon / best.length, lat: lat / best.length }
}

export function generateWorld(geojson, cfg) {
  const { bbox, pxPerDeg, hexSize } = cfg
  const width = (bbox.lonMax - bbox.lonMin) * pxPerDeg
  const height = (bbox.latMax - bbox.latMin) * pxPerDeg
  const px2lon = (x) => bbox.lonMin + x / pxPerDeg
  const px2lat = (y) => bbox.latMax - y / pxPerDeg
  const lonlat2px = (lon, lat) => ({ x: (lon - bbox.lonMin) * pxPerDeg, y: (bbox.latMax - lat) * pxPerDeg })
  const feats = prepareFeatures(geojson)

  const hexes = []
  const index = new Map()
  const colSpan = hexSize * SQRT3
  const rMax = Math.ceil(height / (hexSize * 1.5)) + 1
  const margin = hexSize
  let id = 0
  for (let r = -1; r <= rMax; r++) {
    const qMin = Math.floor(-r / 2 - 1)
    const qMax = Math.ceil(width / colSpan - r / 2) + 1
    for (let q = qMin; q <= qMax; q++) {
      const x = hexSize * SQRT3 * (q + r / 2)
      const y = hexSize * 1.5 * r
      if (x < -margin || x > width + margin || y < -margin || y > height + margin) continue
      const lon = px2lon(x)
      const lat = px2lat(y)
      const feat = classify(lon, lat, feats)
      hexes.push({
        hexId: id, q, r,
        lon: Math.round(lon * 1000) / 1000,
        lat: Math.round(lat * 1000) / 1000,
        terrain: feat ? 'plain' : 'water',
        elevation: 0,
        climate: climateFor(lat, 0),
        isLand: !!feat,
        isCoastal: false,
        provinceId: null,
        countryId: feat ? feat.iso : null,
        resourceId: null,
        population: 0,
        infrastructure: 0,
      })
      index.set(axialKey(q, r), id)
      id++
    }
  }

  // Ensure every country gets at least one hex.
  const present = new Set(hexes.filter((h) => h.countryId).map((h) => h.countryId))
  for (const feat of feats) {
    if (!feat.iso || present.has(feat.iso)) continue
    const rep = representativePoint(feat)
    const { x, y } = lonlat2px(rep.lon, rep.lat)
    const q = Math.round(((SQRT3 / 3) * x - (1 / 3) * y) / hexSize)
    // use proper rounding via index neighbourhood: snap to nearest stored hex
    let bestId, bestD = Infinity
    for (let dr = -1; dr <= 1; dr++)
      for (let dq = -1; dq <= 1; dq++) {
        const nid = index.get(axialKey(q + dq, Math.round((2 / 3) * y / hexSize) + dr))
        if (nid === undefined) continue
        const hh = hexes[nid]
        const cx = hexSize * SQRT3 * (hh.q + hh.r / 2)
        const cy = hexSize * 1.5 * hh.r
        const d = (cx - x) ** 2 + (cy - y) ** 2
        if (d < bestD) { bestD = d; bestId = nid }
      }
    if (bestId !== undefined) {
      const h = hexes[bestId]
      h.isLand = true
      h.countryId = feat.iso
      h.terrain = 'plain'
      present.add(feat.iso)
    }
  }

  // Coastal pass.
  for (const h of hexes) {
    if (!h.isLand) continue
    for (const [dq, dr] of NEIGHBORS) {
      const nid = index.get(axialKey(h.q + dq, h.r + dr))
      if (nid === undefined || !hexes[nid].isLand) { h.isCoastal = true; break }
    }
  }

  // Country roster (only those that ended up on the map).
  const seen = new Map()
  for (const f of feats) if (f.iso && present.has(f.iso) && !seen.has(f.iso))
    seen.set(f.iso, { id: f.iso, name: f.name, color: colorForIso(f.iso) })

  const meta = { bbox, pxPerDeg, hexSize, width, height, count: hexes.length }
  return { meta, hexes, countries: [...seen.values()] }
}
