/**
 * World builder — turns a region definition + country GeoJSON into a fully
 * populated hex grid. This runs once when the map loads (or when resolution
 * changes) and is the bridge between geography and game data.
 *
 * Steps:
 *   1. Lay a pointy-top hex grid over the region's world-pixel rectangle.
 *   2. For each hex, project its centre back to lon/lat and classify it against
 *      the real country polygons -> land/sea + initial country assignment.
 *   3. Detect coastal hexes (land touching sea) via neighbour adjacency.
 *
 * Province/city layers are intentionally left empty here — they are authored on
 * top of this grid by the editor (next milestone).
 */

import { axialKey, axialToPixel, neighbors, pixelToAxial } from '../hex/coords'
import { Projection, prepareFeatures, classifyPoint, GeoFeature } from '../geo/projection'
import { RegionDef } from './region'
import { ClimateType, Hex, World } from './types'

/** A point guaranteed inside-ish a feature: centroid of its largest outer ring.
 *  Used so micro-states (e.g. Maldives) still get a hex even when every hex
 *  centre misses their tiny islands. */
function representativePoint(feat: GeoFeature): { lon: number; lat: number } {
  let best = feat.polygons[0][0]
  for (const poly of feat.polygons) if (poly[0].length > best.length) best = poly[0]
  let lon = 0
  let lat = 0
  for (const [x, y] of best) {
    lon += x
    lat += y
  }
  return { lon: lon / best.length, lat: lat / best.length }
}

/** Very rough climate guess from latitude — placeholder for a real model. */
function climateFor(lat: number, elevation: number): ClimateType {
  if (elevation > 2500) return 'highland'
  const a = Math.abs(lat)
  if (a < 12) return 'tropical'
  if (a < 23) return 'arid'
  if (a < 35) return 'temperate'
  return 'continental'
}

export function buildWorld(region: RegionDef, hexSize: number, geojson: any): World {
  const proj = new Projection(region.bbox, region.pxPerDeg)
  const features = prepareFeatures(geojson)

  const hexes: Hex[] = []
  const index = new Map<string, number>()

  // r covers vertical extent; for each r, q covers horizontal extent.
  const rMax = Math.ceil(proj.height / (hexSize * 1.5)) + 1
  const margin = hexSize

  let id = 0
  for (let r = -1; r <= rMax; r++) {
    // Solve q-range so hex centres span [0, width]. x = size*sqrt3*(q + r/2).
    const colSpan = hexSize * Math.sqrt(3)
    const qMin = Math.floor(-r / 2 - 1)
    const qMax = Math.ceil(proj.width / colSpan - r / 2) + 1
    for (let q = qMin; q <= qMax; q++) {
      const { x, y } = axialToPixel(q, r, hexSize)
      if (x < -margin || x > proj.width + margin || y < -margin || y > proj.height + margin) continue

      const { lon, lat } = proj.pixelToLonLat(x, y)
      const feat = classifyPoint(lon, lat, features)
      const isLand = feat !== null
      const elevation = 0 // refined later from a DEM; flat for now

      hexes.push({
        hexId: id,
        q,
        r,
        lon: Math.round(lon * 1000) / 1000,
        lat: Math.round(lat * 1000) / 1000,
        terrain: isLand ? 'plain' : 'water',
        elevation,
        climate: climateFor(lat, elevation),
        isLand,
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

  // Guarantee every country is represented even if too small for the grid.
  const present = new Set<string>()
  for (const h of hexes) if (h.countryId) present.add(h.countryId)
  for (const feat of features) {
    if (present.has(feat.iso)) continue
    const rep = representativePoint(feat)
    const { x, y } = proj.lonLatToPixel(rep.lon, rep.lat)
    const { q, r } = pixelToAxial(x, y, hexSize)
    const fid = index.get(axialKey(q, r))
    if (fid === undefined) continue
    const h = hexes[fid]
    h.isLand = true
    h.countryId = feat.iso
    h.terrain = 'plain'
    h.climate = climateFor(h.lat, 0)
  }

  // Coastal pass: a land hex with at least one sea (or off-grid) neighbour.
  for (const h of hexes) {
    if (!h.isLand) continue
    for (const n of neighbors(h.q, h.r)) {
      const nid = index.get(axialKey(n.q, n.r))
      if (nid === undefined || !hexes[nid].isLand) {
        h.isCoastal = true
        break
      }
    }
  }

  return {
    regionId: region.id,
    hexSize,
    width: proj.width,
    height: proj.height,
    originX: 0,
    originY: 0,
    hexes,
    byId: new Map(hexes.map((h) => [h.hexId, h])),
    index,
    provinces: new Map(),
    cities: new Map(),
    countries: new Map(),
  }
}

/** Hit-test: render-pixel point -> hexId (or undefined if no hex there).
 *  Adds the slice origin back so global axial coords line up. */
export function hexAt(world: World, x: number, y: number): number | undefined {
  const { q, r } = pixelToAxial(x + world.originX, y + world.originY, world.hexSize)
  return world.index.get(axialKey(q, r))
}

export interface WorldStats {
  total: number
  land: number
  sea: number
  coastal: number
  byCountry: Record<string, number>
}

export function worldStats(world: World): WorldStats {
  const s: WorldStats = { total: 0, land: 0, sea: 0, coastal: 0, byCountry: {} }
  for (const h of world.hexes) {
    s.total++
    if (h.isLand) {
      s.land++
      if (h.isCoastal) s.coastal++
      if (h.countryId) s.byCountry[h.countryId] = (s.byCountry[h.countryId] ?? 0) + 1
    } else s.sea++
  }
  return s
}
