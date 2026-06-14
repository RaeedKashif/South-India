// World Game backend.
//
// Owns the authoritative map: generates the whole-world hex grid once, persists
// it to disk, and serves slices (a region bbox) plus the editable overlay.
//   GET  /api/meta                      world metadata + country roster
//   GET  /api/hexes?region=south_asia   hexes inside a named region (or ?bbox=)
//   GET  /api/edits                     the saved edit overlay { hexId: patch }
//   PUT  /api/edits                     replace the overlay (autosave target)

import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateWorld } from './worldgen.mjs'
import { WORLD, REGIONS, colorForIso } from './regions.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(__dirname, 'data')
const WORLD_FILE = path.join(DATA, 'world.json')
const EDITS_FILE = path.join(DATA, 'edits.json')
const PROVINCES_FILE = path.join(DATA, 'provinces.json')
const GEOJSON_FILE = path.join(DATA, 'ne_50m_countries.json')
const PORT = process.env.PORT || 5179

function loadOrGenerateWorld() {
  if (fs.existsSync(WORLD_FILE)) {
    console.log('Loading cached world from disk…')
    return JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8'))
  }
  console.log('Generating world (first run)… this takes a few seconds.')
  const geojson = JSON.parse(fs.readFileSync(GEOJSON_FILE, 'utf8'))
  const t = Date.now()
  const world = generateWorld(geojson, WORLD)
  fs.writeFileSync(WORLD_FILE, JSON.stringify(world))
  console.log(`Generated ${world.hexes.length} hexes in ${Date.now() - t}ms -> ${WORLD_FILE}`)
  return world
}

const world = loadOrGenerateWorld()
// Index hexes by id and (cheaply) keep them for region filtering.
const hexes = world.hexes
let edits = fs.existsSync(EDITS_FILE) ? JSON.parse(fs.readFileSync(EDITS_FILE, 'utf8')) : {}
// Province metadata { [id]: { id, name, countryId, color } }. Hex→province
// membership lives in the edit overlay (hex.provinceId), so provinces are
// reconstructed by intersecting this roster with the hexes that point at it.
let provinces = fs.existsSync(PROVINCES_FILE) ? JSON.parse(fs.readFileSync(PROVINCES_FILE, 'utf8')) : {}

// Geographic vector layer (real coastlines/borders) kept in memory for region
// queries. This is the VISUAL layer, separate from the hex gameplay layer.
const geo = fs.existsSync(GEOJSON_FILE) ? JSON.parse(fs.readFileSync(GEOJSON_FILE, 'utf8')) : null

const inBBox = (h, b) => h.lon >= b.lonMin && h.lon <= b.lonMax && h.lat >= b.latMin && h.lat <= b.latMax

// BBox of a single polygon's outer ring. Per-polygon (not per-feature) so that
// antimeridian-spanning countries (e.g. USA via the Aleutians) aren't falsely
// matched — only the polygons actually inside the region are kept.
function polyBBox(poly) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity
  for (const [x, y] of poly[0]) {
    if (x < a) a = x
    if (x > c) c = x
    if (y < b) b = y
    if (y > d) d = y
  }
  return [a, b, c, d]
}
const bboxHit = (fb, box) => !(fb[2] < box.lonMin || fb[0] > box.lonMax || fb[3] < box.latMin || fb[1] > box.latMax)
const isoOf = (p) => (p.ISO_A3 && p.ISO_A3 !== '-99' ? p.ISO_A3 : p.ADM0_A3)

const app = express()
app.use(cors())
app.use(express.json({ limit: '64mb' }))

app.get('/api/meta', (_req, res) => {
  res.json({
    world: world.meta,
    regions: REGIONS,
    countries: world.countries,
    counts: {
      total: hexes.length,
      land: hexes.reduce((n, h) => n + (h.isLand ? 1 : 0), 0),
    },
  })
})

app.get('/api/hexes', (req, res) => {
  let bbox
  if (req.query.region && REGIONS[req.query.region]) bbox = REGIONS[req.query.region].bbox
  else if (req.query.bbox) {
    const [lonMin, latMin, lonMax, latMax] = String(req.query.bbox).split(',').map(Number)
    bbox = { lonMin, latMin, lonMax, latMax }
  }
  const out = bbox ? hexes.filter((h) => inBBox(h, bbox)) : hexes
  res.json({ bbox: bbox ?? world.meta.bbox, count: out.length, hexes: out })
})

// Geographic vector layer: real country polygons intersecting a region, with a
// colour per country. The client fills these for smooth, accurate borders.
app.get('/api/borders', (req, res) => {
  if (!geo) return res.status(503).json({ error: 'geojson not available' })
  let bbox
  if (req.query.region && REGIONS[req.query.region]) bbox = REGIONS[req.query.region].bbox
  else if (req.query.bbox) {
    const [lonMin, latMin, lonMax, latMax] = String(req.query.bbox).split(',').map(Number)
    bbox = { lonMin, latMin, lonMax, latMax }
  }
  const r = (n) => Math.round(n * 1000) / 1000
  const round = (ring) => ring.map(([x, y]) => [r(x), r(y)])
  const features = []
  for (const f of geo.features) {
    if (!f.geometry) continue
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
    const kept = bbox ? polys.filter((p) => bboxHit(polyBBox(p), bbox)) : polys
    if (!kept.length) continue
    const iso = isoOf(f.properties)
    const coords = kept.map((poly) => poly.map(round))
    features.push({
      type: 'Feature',
      properties: { iso, name: f.properties.ADMIN || f.properties.NAME, color: colorForIso(iso) },
      geometry: coords.length === 1 ? { type: 'Polygon', coordinates: coords[0] } : { type: 'MultiPolygon', coordinates: coords },
    })
  }
  res.json({ type: 'FeatureCollection', features })
})

app.get('/api/edits', (_req, res) => res.json(edits))

app.put('/api/edits', (req, res) => {
  edits = req.body && typeof req.body === 'object' ? req.body : {}
  fs.writeFileSync(EDITS_FILE, JSON.stringify(edits))
  res.json({ ok: true, count: Object.keys(edits).length })
})

app.get('/api/provinces', (_req, res) => res.json(provinces))

app.put('/api/provinces', (req, res) => {
  provinces = req.body && typeof req.body === 'object' ? req.body : {}
  fs.writeFileSync(PROVINCES_FILE, JSON.stringify(provinces))
  res.json({ ok: true, count: Object.keys(provinces).length })
})

app.listen(PORT, () => console.log(`World Game API on http://localhost:${PORT}`))
