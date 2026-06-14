/**
 * HexCanvas — the map view.
 *
 * Performance model (the important part):
 *   - The whole static grid is rasterised ONCE into an offscreen canvas in
 *     world coordinates (`baseRef`). It is only re-rasterised when the data or
 *     style actually changes (resolution, edits, view mode, layer toggles).
 *   - Every frame (pan / zoom / hover) just blits that bitmap with a transform
 *     and draws 1–2 vector outlines on top. So interaction cost is O(1), not
 *     O(hex count) — this is what removes the lag at "fine" resolution.
 *   - Rendering is driven by requestAnimationFrame, NOT by React re-renders.
 *
 * Authoring:
 *   - Inspect tool: click selects a hex.
 *   - Paint tool ("pencil"): drag to stamp a country/terrain onto hexes. Each
 *     stamped hex is drawn incrementally onto the base bitmap for instant
 *     feedback; the batch is committed to the edit overlay on pointer-up.
 *   - Space or middle-mouse always pans; in Inspect, left-drag also pans.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TERRAIN, TerrainType } from '../types'
import { hexCorners, axialKey, hexDistance } from '../hex/coords'
import { hexUnionOutline } from '../hex/contour'
import { hexAt } from '../world/buildWorld'
import { applyPatch, EditOverlay, HexPatch } from '../world/store'
import { RegionDef, countryColor } from '../world/region'
import { CountryId, World } from '../world/types'

export type ViewMode = 'terrain' | 'country' | 'elevation' | 'population'
export type Tool = 'inspect' | 'paint' | 'transform'
export type PaintTarget = 'country' | 'terrain' | 'province'
export type MapStyle = 'political' | 'hex'

// Resize-tool geometry. A country is scaled as its real (smooth) vector shape —
// no hexes, no distortion — so borders stay crisp. Geometry is GeoJSON-style
// coordinates in lon/lat: number[][][] (polygons → rings → [lon,lat]).
type MultiPolygon = number[][][][] // [polygon][ring][point][lon,lat]
interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}
type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const HANDLE_PX = 7 // half-size of a handle square, in screen px

interface Props {
  world: World
  region: RegionDef
  edits: EditOverlay
  geojson: any // geographic vector layer (FeatureCollection w/ per-feature color)
  mapStyle: MapStyle
  editCountries: boolean // political map driven by hex ownership (paint to reshape)
  showSmoothOwnership: boolean // overlay smooth outlines derived from hex ownership
  showProvinceBorders: boolean // overlay smooth province borders generated from hexes
  selectedProvinceId: number | null
  viewMode: ViewMode
  showSea: boolean
  showGrid: boolean
  showBorders: boolean
  selectedId: number | null
  onSelect: (id: number | null) => void
  onHover: (id: number | null) => void
  tool: Tool
  paintTarget: PaintTarget
  brushCountry: CountryId | null
  brushTerrain: TerrainType
  brushSize: number // paint radius in hex rings (1 = single hex)
  activeProvinceId: number | null
  onPaintCommit: (patches: Map<number, HexPatch>) => void
  countryShapes: Map<string, MultiPolygon> // iso -> scaled vector shape (overrides geojson)
  onCountryShape: (iso: string, shape: MultiPolygon) => void
}

const OCEAN = '#a7c7dd'
const LAND_NEUTRAL = '#d8d0bd'
// Default map tilt so South Asia sits at a slight angle (negative = anticlockwise).
const DEFAULT_ROT_DEG = -12

function lerpColor(a: number[], b: number[], t: number): string {
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(
    a[2] + (b[2] - a[2]) * t,
  )})`
}
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

// ── Vector geometry helpers (lon/lat MultiPolygons) ──────────────────────────
// Normalise any GeoJSON geometry to a MultiPolygon coordinate array.
const polysOfGeom = (geom: any): MultiPolygon =>
  !geom ? [] : geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates

// lon/lat bounding box of a MultiPolygon.
function shapeBBox(shape: MultiPolygon) {
  let a = Infinity,
    b = Infinity,
    c = -Infinity,
    d = -Infinity
  for (const poly of shape)
    for (const ring of poly)
      for (const [x, y] of ring) {
        if (x < a) a = x
        if (x > c) c = x
        if (y < b) b = y
        if (y > d) d = y
      }
  return { lonMin: a, latMin: b, lonMax: c, latMax: d }
}

// Uniform scale by `s` about lon/lat centre, then translate — the only edit the
// resize tool applies. Uniform keeps real proportions (no distortion).
function transformShape(shape: MultiPolygon, s: number, clon: number, clat: number, dlon: number, dlat: number): MultiPolygon {
  return shape.map((poly) =>
    poly.map((ring) => ring.map(([x, y]) => [clon + (x - clon) * s + dlon, clat + (y - clat) * s + dlat])),
  )
}
// Deterministic province tint (matches the sidebar swatch hue). Low alpha so it
// reads as a region overlay on top of the country/terrain colour underneath.
const provinceTint = (pid: number, alpha: number) => `hsla(${(pid * 47) % 360}, 55%, 52%, ${alpha})`

export default function HexCanvas(props: Props) {
  const { world, region, edits, geojson, mapStyle, editCountries, countryShapes, showSmoothOwnership, showProvinceBorders, selectedProvinceId, viewMode, showSea, showGrid, showBorders, selectedId } =
    props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [zoomPct, setZoomPct] = useState(100)
  const [rotDeg, setRotDeg] = useState(DEFAULT_ROT_DEG)

  // ── Mutable render state (kept out of React to avoid re-render churn) ──────
  // `rot` is the map tilt in radians, applied about the canvas centre on top of
  // the scale/offset. All hit-testing/pan/zoom invert it (see `unrotate`).
  const view = useRef({ scale: 1, ox: 0, oy: 0, rot: (DEFAULT_ROT_DEG * Math.PI) / 180 })
  const hoverRef = useRef<number | null>(null)
  const baseRef = useRef<HTMLCanvasElement | null>(null)
  const ssRef = useRef(1)
  const scratchRef = useRef<Map<number, HexPatch>>(new Map())
  const dprRef = useRef(window.devicePixelRatio || 1)
  const rafRef = useRef(0)
  const spaceRef = useRef(false)
  const fitted = useRef(false)

  // ── Resize tool state (vector country scaling) ─────────────────────────────
  // The currently selected country, its live (possibly mid-drag) shape, and the
  // shape it had before any edits this session (so we can erase the original
  // footprint when it moves/shrinks). All shapes are lon/lat MultiPolygons.
  const tf = useRef<{ iso: string; shape: MultiPolygon; baseShape: MultiPolygon } | null>(null)
  const tfDrag = useRef<{ mode: 'none' | 'resize' | 'move'; cx: number; cy: number; d0: number; sx: number; sy: number; start: MultiPolygon }>({ mode: 'none', cx: 0, cy: 0, d0: 0, sx: 0, sy: 0, start: [] })
  const [selIso, setSelIso] = useState<string | null>(null)

  // Keep latest props reachable from imperative handlers without re-binding.
  const propsRef = useRef(props)
  propsRef.current = props

  const popMax = useMemo(() => {
    let m = 1
    for (const h of world.hexes) {
      const p = (edits.get(h.hexId)?.population ?? h.population) || 0
      if (p > m) m = p
    }
    return m
  }, [world, edits])

  const cornerOffsets = useMemo(
    () => hexCorners(0, 0, world.hexSize).map((p) => [p.x, p.y] as [number, number]),
    [world.hexSize],
  )
  const centerX = useCallback(
    (q: number, r: number) => world.hexSize * Math.sqrt(3) * (q + r / 2) - world.originX,
    [world.hexSize, world.originX],
  )
  const centerY = useCallback((r: number) => world.hexSize * 1.5 * r - world.originY, [world.hexSize, world.originY])

  // lon/lat ↔ world-pixel (same projection the vector layer is drawn with).
  const lonLatToWorld = useCallback(
    (lon: number, lat: number) => ({ x: (lon - region.bbox.lonMin) * region.pxPerDeg, y: (region.bbox.latMax - lat) * region.pxPerDeg }),
    [region],
  )
  const worldToLonLat = useCallback(
    (x: number, y: number) => ({ lon: region.bbox.lonMin + x / region.pxPerDeg, lat: region.bbox.latMax - y / region.pxPerDeg }),
    [region],
  )
  // The current vector shape for a country: an applied override, else the raw
  // polygons from the geojson (all features sharing that ISO, merged).
  const shapeForIso = useCallback(
    (iso: string): MultiPolygon => {
      if (countryShapes.has(iso)) return countryShapes.get(iso)!
      const polys: MultiPolygon = []
      if (geojson?.features) for (const f of geojson.features) if (f.properties?.iso === iso) polys.push(...polysOfGeom(f.geometry))
      return polys
    },
    [countryShapes, geojson],
  )

  // ── Colour for a hex (base + edits + in-progress paint scratch) ────────────
  const colorFor = useCallback(
    (id: number): string | null => {
      const base = world.byId.get(id)!
      const h = applyPatch(applyPatch(base, edits.get(id)), scratchRef.current.get(id))
      const isSea = !h.isLand && !h.countryId && h.terrain === 'water'
      if (isSea) return showSea ? OCEAN : null
      switch (viewMode) {
        case 'country':
          return countryColor(region, h.countryId) ?? LAND_NEUTRAL
        case 'elevation': {
          const t = clamp(h.elevation / 6000, 0, 1)
          return t < 0.5
            ? lerpColor([74, 124, 89], [180, 150, 110], t * 2)
            : lerpColor([180, 150, 110], [246, 246, 246], (t - 0.5) * 2)
        }
        case 'population':
          return lerpColor([238, 234, 222], [176, 42, 42], clamp(h.population / popMax, 0, 1))
        case 'terrain':
        default:
          return TERRAIN[h.terrain].color
      }
    },
    [world, region, viewMode, showSea, edits, popMax],
  )

  // ── Province outline loops, cached (recomputed only when membership changes) ─
  // The contour walk is O(hexes); doing it per frame would lag pan/zoom. We
  // compute the smooth loops once here and just stroke them in the composite.
  const provinceLoops = useMemo(() => {
    const groups = new Map<number, { q: number; r: number }[]>()
    for (const hx of world.hexes) {
      const pid = edits.get(hx.hexId)?.provinceId ?? hx.provinceId
      if (pid == null) continue
      const arr = groups.get(pid)
      if (arr) arr.push(hx)
      else groups.set(pid, [hx])
    }
    const out = new Map<number, { x: number; y: number }[][]>()
    for (const [pid, cells] of groups)
      out.set(pid, hexUnionOutline(cells, world.hexSize, world.originX, world.originY, 2))
    return out
  }, [world, edits])

  const tracePath = (ctx: CanvasRenderingContext2D, cx: number, cy: number) => {
    ctx.beginPath()
    ctx.moveTo(cx + cornerOffsets[0][0], cy + cornerOffsets[0][1])
    for (let i = 1; i < 6; i++) ctx.lineTo(cx + cornerOffsets[i][0], cy + cornerOffsets[i][1])
    ctx.closePath()
  }

  // ── Build / rebuild the offscreen base bitmap ──────────────────────────────
  const renderBase = useCallback(() => {
    let base = baseRef.current
    const ss = clamp(Math.min(2, 3072 / Math.max(world.width, world.height)), 1, 2)
    ssRef.current = ss
    const bw = Math.ceil(world.width * ss)
    const bh = Math.ceil(world.height * ss)
    if (!base) {
      base = document.createElement('canvas')
      baseRef.current = base
    }
    if (base.width !== bw || base.height !== bh) {
      base.width = bw
      base.height = bh
    }
    const ctx = base.getContext('2d')!
    ctx.setTransform(ss, 0, 0, ss, 0, 0)
    ctx.clearRect(0, 0, world.width, world.height)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'

    const { lonMin, latMax } = region.bbox
    const pd = region.pxPerDeg
    // Trace a GeoJSON feature's polygons (outer rings + holes) into the path.
    const traceFeature = (f: any) => tracePolys(polysOfGeom(f.geometry))
    // Trace a MultiPolygon (lon/lat) into the current path.
    const tracePolys = (shape: MultiPolygon) => {
      ctx.beginPath()
      for (const poly of shape)
        for (const ring of poly)
          for (let i = 0; i < ring.length; i++) {
            const px = (ring[i][0] - lonMin) * pd
            const py = (latMax - ring[i][1]) * pd
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
          }
    }

    const haveVector = !!(geojson && geojson.features && geojson.features.length)
    if (mapStyle === 'political') {
      if (editCountries) {
        // EDITABLE political map: country shapes are reconstructed from which
        // hexes each country owns, smoothed into soft polygons. Painting a
        // country onto a neighbour's hexes therefore expands/shrinks it live.
        // Neutral landmass underlay (smooth union of every land hex) so unowned
        // land and coastlines read correctly beneath the country fills.
        const landCells = world.hexes.filter((h) => h.isLand)
        ctx.fillStyle = LAND_NEUTRAL
        ctx.beginPath()
        for (const loop of hexUnionOutline(landCells, world.hexSize, world.originX, world.originY, 2))
          for (let i = 0; i < loop.length; i++) i === 0 ? ctx.moveTo(loop[i].x, loop[i].y) : ctx.lineTo(loop[i].x, loop[i].y)
        ctx.fill('evenodd')

        // Group owned hexes by country and fill each country's smooth region.
        const groups = new Map<CountryId, { q: number; r: number }[]>()
        for (const hx of world.hexes) {
          const cid = edits.get(hx.hexId)?.countryId ?? hx.countryId
          if (!cid) continue
          const arr = groups.get(cid)
          if (arr) arr.push(hx)
          else groups.set(cid, [hx])
        }
        const countryLoops = new Map<CountryId, { x: number; y: number }[][]>()
        for (const [cid, cells] of groups) {
          const loops = hexUnionOutline(cells, world.hexSize, world.originX, world.originY, 2)
          countryLoops.set(cid, loops)
          ctx.fillStyle = countryColor(region, cid) ?? LAND_NEUTRAL
          ctx.beginPath()
          for (const loop of loops)
            for (let i = 0; i < loop.length; i++) i === 0 ? ctx.moveTo(loop[i].x, loop[i].y) : ctx.lineTo(loop[i].x, loop[i].y)
          ctx.fill('evenodd')
        }
        if (showGrid) {
          ctx.lineWidth = 0.4
          ctx.strokeStyle = 'rgba(20,30,45,0.12)'
          for (const hx of world.hexes) {
            tracePath(ctx, centerX(hx.q, hx.r), centerY(hx.r))
            ctx.stroke()
          }
        }
        if (showBorders) {
          ctx.lineWidth = 1.4
          ctx.strokeStyle = 'rgba(25,32,45,0.85)'
          for (const loops of countryLoops.values())
            for (const loop of loops) {
              ctx.beginPath()
              for (let i = 0; i < loop.length; i++) i === 0 ? ctx.moveTo(loop[i].x, loop[i].y) : ctx.lineTo(loop[i].x, loop[i].y)
              ctx.closePath()
              ctx.stroke()
            }
        }
      } else if (haveVector) {
        // VISUAL layer: the real country polygons (accurate, smooth shapes). A
        // country that has been resized is drawn at its overridden shape; its
        // original footprint is erased to neutral land first so no ghost remains.
        const overridden = (f: any) => countryShapes.has(f.properties?.iso)
        if (countryShapes.size) {
          ctx.fillStyle = LAND_NEUTRAL
          for (const f of geojson.features) if (overridden(f)) { traceFeature(f); ctx.fill('evenodd') }
        }
        for (const f of geojson.features) {
          if (overridden(f)) continue
          traceFeature(f)
          ctx.fillStyle = f.properties?.color || LAND_NEUTRAL
          ctx.fill('evenodd')
        }
        if (showGrid) {
          ctx.lineWidth = 0.4
          ctx.strokeStyle = 'rgba(20,30,45,0.12)'
          for (const hx of world.hexes) {
            tracePath(ctx, centerX(hx.q, hx.r), centerY(hx.r))
            ctx.stroke()
          }
        }
        if (showBorders) {
          ctx.lineWidth = 1.2
          ctx.strokeStyle = 'rgba(25,32,45,0.85)'
          for (const f of geojson.features) {
            if (overridden(f)) continue
            traceFeature(f)
            ctx.stroke()
          }
        }
        // Resized countries last (fill + border) so they sit cleanly on top.
        for (const [iso, shape] of countryShapes) {
          tracePolys(shape)
          ctx.fillStyle = countryColor(region, iso) ?? LAND_NEUTRAL
          ctx.fill('evenodd')
          if (showBorders) {
            ctx.lineWidth = 1.2
            ctx.strokeStyle = 'rgba(25,32,45,0.85)'
            tracePolys(shape)
            ctx.stroke()
          }
        }
      } else {
        // Fallback (vector borders not loaded yet / backend without /api/borders):
        // colour land hexes by their owning country so the map is never blank.
        for (const hx of world.hexes) {
          const cid = edits.get(hx.hexId)?.countryId ?? hx.countryId
          if (!hx.isLand && !cid) continue
          tracePath(ctx, centerX(hx.q, hx.r), centerY(hx.r))
          ctx.fillStyle = countryColor(region, cid) ?? LAND_NEUTRAL
          ctx.fill()
        }
        if (showGrid) {
          ctx.lineWidth = 0.4
          ctx.strokeStyle = 'rgba(20,30,45,0.12)'
          for (const hx of world.hexes) {
            tracePath(ctx, centerX(hx.q, hx.r), centerY(hx.r))
            ctx.stroke()
          }
        }
      }
    } else {
      // GAMEPLAY (hex) style: per-hex fills coloured by the active view mode.
      for (const hx of world.hexes) {
        const fill = colorFor(hx.hexId)
        if (!fill) continue
        tracePath(ctx, centerX(hx.q, hx.r), centerY(hx.r))
        ctx.fillStyle = fill
        ctx.fill()
        if (showGrid) {
          ctx.lineWidth = 0.5
          ctx.strokeStyle = 'rgba(40,50,62,0.10)'
          ctx.stroke()
        }
      }
      if (showBorders && geojson) {
        ctx.lineWidth = 1.3
        ctx.strokeStyle = 'rgba(30,38,50,0.7)'
        for (const f of geojson.features) {
          traceFeature(f)
          ctx.stroke()
        }
      }
    }

    // Smooth ownership outlines generated FROM the hex data (the bridge from
    // discrete cells to a smooth border). Off by default; demonstrates how a
    // country's owned hexes become a soft polygon without matching real borders.
    if (showSmoothOwnership) {
      const groups = new Map<string, { q: number; r: number }[]>()
      for (const hx of world.hexes) {
        const cid = edits.get(hx.hexId)?.countryId ?? hx.countryId
        if (!cid) continue
        const arr = groups.get(cid)
        if (arr) arr.push(hx)
        else groups.set(cid, [hx])
      }
      ctx.lineWidth = 2
      for (const [cid, cells] of groups) {
        ctx.strokeStyle = countryColor(region, cid) ?? '#2b2b2b'
        for (const loop of hexUnionOutline(cells, world.hexSize, world.originX, world.originY, 2)) {
          ctx.beginPath()
          for (let i = 0; i < loop.length; i++) i === 0 ? ctx.moveTo(loop[i].x, loop[i].y) : ctx.lineTo(loop[i].x, loop[i].y)
          ctx.closePath()
          ctx.stroke()
        }
      }
    }

    // Province *regions*: tint every owned hex so the province's extent is
    // visible as a solid patch even when zoomed out (fills survive the base
    // bitmap downscale; thin strokes do not). The crisp smooth border itself is
    // stroked in the per-frame composite (see `paint`) at constant screen width.
    if (showProvinceBorders || selectedProvinceId != null) {
      for (const hx of world.hexes) {
        const pid = edits.get(hx.hexId)?.provinceId ?? hx.provinceId
        if (pid == null) continue
        if (!showProvinceBorders && pid !== selectedProvinceId) continue
        tracePath(ctx, centerX(hx.q, hx.r), centerY(hx.r))
        ctx.fillStyle = provinceTint(pid, pid === selectedProvinceId ? 0.58 : 0.42)
        ctx.fill()
      }
    }
  }, [world, region, geojson, mapStyle, editCountries, countryShapes, showSmoothOwnership, showProvinceBorders, selectedProvinceId, viewMode, showSea, showGrid, showBorders, edits, colorFor, centerX, centerY])

  // Stamp one hex onto the base bitmap (incremental paint feedback).
  const stampHex = useCallback(
    (id: number) => {
      const base = baseRef.current
      if (!base) return
      const ctx = base.getContext('2d')!
      const ss = ssRef.current
      ctx.setTransform(ss, 0, 0, ss, 0, 0)
      const hx = world.byId.get(id)!
      const cx = centerX(hx.q, hx.r)
      const cy = centerY(hx.r)
      tracePath(ctx, cx, cy)
      ctx.fillStyle = colorFor(id) ?? OCEAN
      ctx.fill()
      // Live feedback while painting a province: tint the hex with the active
      // province colour immediately (the path is still current after the fill).
      const p = propsRef.current
      if (p.tool === 'paint' && p.paintTarget === 'province' && p.activeProvinceId != null) {
        ctx.fillStyle = provinceTint(p.activeProvinceId, 0.5)
        ctx.fill()
      }
      if (showGrid) {
        ctx.lineWidth = 0.5
        ctx.strokeStyle = 'rgba(40,50,62,0.10)'
        ctx.stroke()
      }
    },
    [world, colorFor, showGrid, centerX, centerY],
  )

  // ── Per-frame composite (blit base + outlines) ─────────────────────────────
  const paint = useCallback(() => {
    const canvas = canvasRef.current
    const base = baseRef.current
    if (!canvas || !base) return
    const ctx = canvas.getContext('2d')!
    const dpr = dprRef.current
    const { w, h } = size
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }
    const { scale, ox, oy, rot } = view.current
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = OCEAN
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    // Compose scale → rotate-about-canvas-centre → offset into one matrix so the
    // base bitmap and every overlay share the tilt. (See `unrotate` for inverse.)
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    const px = w / 2
    const py = h / 2
    const a = scale * cos
    const b = scale * sin
    const tx = cos * (ox - px) - sin * (oy - py) + px
    const ty = sin * (ox - px) + cos * (oy - py) + py
    ctx.setTransform(a * dpr, b * dpr, -b * dpr, a * dpr, tx * dpr, ty * dpr)
    ctx.drawImage(base, 0, 0, world.width, world.height)

    // Smooth province borders, stroked live on top of the base bitmap. Drawing
    // here (not into the downscaled base) keeps them crisp at a constant on-
    // screen width regardless of zoom. Loops are cached in `provinceLoops`.
    if (showProvinceBorders || selectedProvinceId != null) {
      ctx.lineJoin = 'round'
      for (const [pid, loops] of provinceLoops) {
        if (!showProvinceBorders && pid !== selectedProvinceId) continue
        const isSel = pid === selectedProvinceId
        ctx.lineWidth = (isSel ? 2.6 : 1.5) / scale
        ctx.strokeStyle = isSel ? '#15489e' : 'rgba(15,23,38,0.9)'
        for (const loop of loops) {
          ctx.beginPath()
          for (let i = 0; i < loop.length; i++)
            i === 0 ? ctx.moveTo(loop[i].x, loop[i].y) : ctx.lineTo(loop[i].x, loop[i].y)
          ctx.closePath()
          ctx.stroke()
        }
      }
    }

    const outline = (id: number, color: string, width: number) => {
      const hx = world.byId.get(id)!
      tracePath(ctx, centerX(hx.q, hx.r), centerY(hx.r))
      ctx.lineWidth = width / scale
      ctx.strokeStyle = color
      ctx.stroke()
    }
    const hov = hoverRef.current
    if (hov != null && hov !== selectedId) outline(hov, 'rgba(255,255,255,0.95)', 2)
    if (selectedId != null) outline(selectedId, '#15489e', 3)

    // ── Resize tool overlay: live scaled-country preview + selection box ──────
    const t = tf.current
    if (propsRef.current.tool === 'transform' && t) {
      const traceShapeWorld = (shape: MultiPolygon) => {
        ctx.beginPath()
        for (const poly of shape)
          for (const ring of poly)
            for (let i = 0; i < ring.length; i++) {
              const w = lonLatToWorld(ring[i][0], ring[i][1])
              i === 0 ? ctx.moveTo(w.x, w.y) : ctx.lineTo(w.x, w.y)
            }
      }
      // While dragging, draw the preview on top: erase the committed footprint
      // with neutral land, then paint the scaled shape + crisp border.
      if (tfDrag.current.mode === 'resize' || tfDrag.current.mode === 'move') {
        ctx.fillStyle = LAND_NEUTRAL
        traceShapeWorld(t.baseShape)
        ctx.fill('evenodd')
        traceShapeWorld(t.shape)
        ctx.fillStyle = countryColor(region, t.iso) ?? LAND_NEUTRAL
        ctx.fill('evenodd')
        ctx.lineWidth = 1.4 / scale
        ctx.strokeStyle = 'rgba(25,32,45,0.85)'
        traceShapeWorld(t.shape)
        ctx.stroke()
      }
      // Selection box + handles around the current shape.
      const box = selBoxWorld()
      if (box) {
        ctx.save()
        ctx.lineWidth = 1.5 / scale
        ctx.setLineDash([6 / scale, 4 / scale])
        ctx.strokeStyle = '#15489e'
        ctx.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0)
        ctx.setLineDash([])
        const hs = HANDLE_PX / scale
        ctx.lineWidth = 1.2 / scale
        for (const h of handlesOf(box)) {
          ctx.fillStyle = '#ffffff'
          ctx.strokeStyle = '#15489e'
          ctx.fillRect(h.x - hs, h.y - hs, hs * 2, hs * 2)
          ctx.strokeRect(h.x - hs, h.y - hs, hs * 2, hs * 2)
        }
        ctx.restore()
      }
    }
  }, [size, world, region, selectedId, provinceLoops, showProvinceBorders, selectedProvinceId, lonLatToWorld, centerX, centerY])

  const requestPaint = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      paint()
    })
  }, [paint])

  // ── Wiring: rebuild base only when content changes; repaint on view change ──
  useEffect(() => {
    renderBase()
    requestPaint()
  }, [renderBase]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    requestPaint()
  }, [size, selectedId, requestPaint])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      dprRef.current = window.devicePixelRatio || 1
      setSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fitView = useCallback(() => {
    const s = Math.min(size.w / world.width, size.h / world.height) * 0.95
    view.current = { ...view.current, scale: s, ox: (size.w - world.width * s) / 2, oy: (size.h - world.height * s) / 2 }
    setZoomPct(Math.round(s * 100))
    requestPaint()
  }, [size, world.width, world.height, requestPaint])

  // Leaving the resize tool drops any active selection.
  useEffect(() => {
    if (props.tool !== 'transform') {
      tf.current = null
      tfDrag.current = { mode: 'none', cx: 0, cy: 0, d0: 0, sx: 0, sy: 0, start: [] }
      if (selIso) setSelIso(null)
      requestPaint()
    }
  }, [props.tool]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fit once per world load, after the real canvas size is known.
  useEffect(() => {
    fitted.current = false
  }, [world])
  useEffect(() => {
    if (!fitted.current && size.w > 1 && baseRef.current) {
      fitView()
      fitted.current = true
    }
  }, [size, world, fitView])

  // ── Keyboard: space = pan modifier ─────────────────────────────────────────
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e.target)) {
        e.preventDefault()
        spaceRef.current = true
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceRef.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // ── Wheel: pan, or ctrl/⌘ zoom-at-cursor ───────────────────────────────────
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const v = view.current
      const cos = Math.cos(v.rot)
      const sin = Math.sin(v.rot)
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect()
        // Zoom toward the cursor, in unrotated screen space.
        const dx = e.clientX - rect.left - rect.width / 2
        const dy = e.clientY - rect.top - rect.height / 2
        const mx = cos * dx + sin * dy + rect.width / 2
        const my = -sin * dx + cos * dy + rect.height / 2
        const ns = clamp(v.scale * (e.deltaY > 0 ? 0.9 : 1.1), 0.05, 16)
        view.current = { ...v, scale: ns, ox: mx - (mx - v.ox) * (ns / v.scale), oy: my - (my - v.oy) * (ns / v.scale) }
        setZoomPct(Math.round(ns * 100))
      } else {
        // Pan in screen direction → rotate the scroll delta into unrotated space.
        const dux = cos * e.deltaX + sin * e.deltaY
        const duy = -sin * e.deltaX + cos * e.deltaY
        view.current = { ...v, ox: v.ox - dux, oy: v.oy - duy }
      }
      requestPaint()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [requestPaint])

  // ── Pointer interaction ────────────────────────────────────────────────────
  const drag = useRef({ panning: false, press: false, painting: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 })

  // Undo the map tilt: map a canvas-relative screen point back into the
  // unrotated (scale+offset only) screen space used by ox/oy/scale.
  const unrotate = (sx: number, sy: number) => {
    const { rot } = view.current
    const px = size.w / 2
    const py = size.h / 2
    const dx = sx - px
    const dy = sy - py
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    return { x: cos * dx + sin * dy + px, y: -sin * dx + cos * dy + py }
  }

  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const v = view.current
    const u = unrotate(clientX - rect.left, clientY - rect.top)
    return { x: (u.x - v.ox) / v.scale, y: (u.y - v.oy) / v.scale }
  }

  const brushPatch = (): HexPatch => {
    const p = propsRef.current
    if (p.paintTarget === 'country') return { countryId: p.brushCountry }
    if (p.paintTarget === 'province') return { provinceId: p.activeProvinceId }
    return { terrain: p.brushTerrain }
  }

  const paintAt = (clientX: number, clientY: number) => {
    const { x, y } = toWorld(clientX, clientY)
    const centerId = hexAt(world, x, y)
    if (centerId === undefined) return
    const p = propsRef.current
    const patch = brushPatch()
    const radius = Math.max(1, Math.round(p.brushSize))
    const center = world.byId.get(centerId)!
    let changed = false
    // Paint every hex within `radius` rings of the cursor hex so a drag fills a
    // solid swath (the brush), not a single cell — this is what makes a country
    // visibly expand/shrink as you drag the border.
    for (let dq = -(radius - 1); dq <= radius - 1; dq++) {
      for (let dr = -(radius - 1); dr <= radius - 1; dr++) {
        const q = center.q + dq
        const r = center.r + dr
        if (hexDistance({ q: center.q, r: center.r }, { q, r }) > radius - 1) continue
        const id = world.index.get(axialKey(q, r))
        if (id === undefined) continue
        // Country brush reshapes land only, so borders stay on the coastline
        // instead of bleeding into the ocean.
        if (p.paintTarget === 'country') {
          const base = world.byId.get(id)!
          const owned = (edits.get(id)?.countryId ?? base.countryId) != null
          if (!base.isLand && !owned) continue
        }
        const prev = scratchRef.current.get(id)
        if (prev && prev.countryId === patch.countryId && prev.terrain === patch.terrain && prev.provinceId === patch.provinceId)
          continue
        scratchRef.current.set(id, patch)
        stampHex(id)
        changed = true
      }
    }
    if (changed) requestPaint()
  }

  // ── Resize tool helpers (vector country scaling) ───────────────────────────
  // The selection box = the current shape's bounding box, in world pixels.
  const selBoxWorld = (): Box | null => {
    if (!tf.current) return null
    const bb = shapeBBox(tf.current.shape)
    const a = lonLatToWorld(bb.lonMin, bb.latMax) // lat max → top (smaller y)
    const b = lonLatToWorld(bb.lonMax, bb.latMin)
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y }
  }
  const handlesOf = (b: Box): { id: HandleId; x: number; y: number }[] => {
    const mx = (b.x0 + b.x1) / 2
    const my = (b.y0 + b.y1) / 2
    return [
      { id: 'nw', x: b.x0, y: b.y0 },
      { id: 'n', x: mx, y: b.y0 },
      { id: 'ne', x: b.x1, y: b.y0 },
      { id: 'e', x: b.x1, y: my },
      { id: 'se', x: b.x1, y: b.y1 },
      { id: 's', x: mx, y: b.y1 },
      { id: 'sw', x: b.x0, y: b.y1 },
      { id: 'w', x: b.x0, y: my },
    ]
  }
  const hitHandle = (p: { x: number; y: number }): HandleId | null => {
    const box = selBoxWorld()
    if (!box) return null
    const tol = 14 / view.current.scale // generous grab radius (~14 screen px)
    let best: HandleId | null = null
    let bestD = Infinity
    for (const h of handlesOf(box)) {
      const d = Math.max(Math.abs(p.x - h.x), Math.abs(p.y - h.y))
      if (d <= tol && d < bestD) {
        bestD = d
        best = h.id
      }
    }
    return best
  }
  const insideBox = (p: { x: number; y: number }, b: Box) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1

  // Select the country under a point (via the hex it sits on). Captures its
  // current smooth shape (an applied override, else the raw geojson outline).
  const selectCountryAt = (clientX: number, clientY: number) => {
    const { x, y } = toWorld(clientX, clientY)
    const id = hexAt(world, x, y)
    const iso = id !== undefined ? edits.get(id)?.countryId ?? world.byId.get(id)?.countryId ?? null : null
    if (!iso) {
      tf.current = null
      setSelIso(null)
      return false
    }
    const shape = shapeForIso(iso)
    tf.current = { iso, shape, baseShape: shape }
    setSelIso(iso)
    return true
  }

  // Resize-tool pointer flow (returns true if it consumed the event).
  const transformPointerDown = (e: React.PointerEvent): boolean => {
    if (propsRef.current.tool !== 'transform' || spaceRef.current || e.button !== 0) return false
    const p = toWorld(e.clientX, e.clientY)
    if (tf.current) {
      const handle = hitHandle(p)
      const box = selBoxWorld()
      if (handle && box) {
        const cx = (box.x0 + box.x1) / 2
        const cy = (box.y0 + box.y1) / 2
        const d0 = Math.hypot(p.x - cx, p.y - cy) || 1
        tfDrag.current = { mode: 'resize', cx, cy, d0, sx: p.x, sy: p.y, start: tf.current.shape }
        return true
      }
      if (box && insideBox(p, box)) {
        tfDrag.current = { mode: 'move', cx: 0, cy: 0, d0: 0, sx: p.x, sy: p.y, start: tf.current.shape }
        return true
      }
    }
    // Otherwise (re)select whichever country was clicked.
    selectCountryAt(e.clientX, e.clientY)
    requestPaint()
    return true
  }

  const transformPointerMove = (e: React.PointerEvent): boolean => {
    const d = tfDrag.current
    if (d.mode === 'none' || !tf.current) return false
    const p = toWorld(e.clientX, e.clientY)
    if (d.mode === 'resize') {
      const factor = clamp(Math.hypot(p.x - d.cx, p.y - d.cy) / d.d0, 0.1, 10)
      const c = worldToLonLat(d.cx, d.cy)
      tf.current.shape = transformShape(d.start, factor, c.lon, c.lat, 0, 0)
    } else if (d.mode === 'move') {
      const dlon = (p.x - d.sx) / region.pxPerDeg
      const dlat = -(p.y - d.sy) / region.pxPerDeg
      tf.current.shape = transformShape(d.start, 1, 0, 0, dlon, dlat)
    }
    requestPaint()
    return true
  }

  const transformPointerUp = (): boolean => {
    const d = tfDrag.current
    if (d.mode === 'none') return false
    if (tf.current && (d.mode === 'resize' || d.mode === 'move')) {
      propsRef.current.onCountryShape(tf.current.iso, tf.current.shape)
      tf.current = { ...tf.current, baseShape: tf.current.shape } // re-anchor
    }
    tfDrag.current = { mode: 'none', cx: 0, cy: 0, d0: 0, sx: 0, sy: 0, start: [] }
    requestPaint()
    return true
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (transformPointerDown(e)) {
      canvasRef.current?.setPointerCapture(e.pointerId)
      return
    }
    const v = view.current
    canvasRef.current?.setPointerCapture(e.pointerId)
    const usePan = e.button === 1 || spaceRef.current
    if (usePan) {
      drag.current = { ...drag.current, panning: true, moved: false, sx: e.clientX, sy: e.clientY, ox: v.ox, oy: v.oy }
      return
    }
    if (e.button !== 0) return
    if (propsRef.current.tool === 'paint') {
      drag.current = { ...drag.current, painting: true, moved: true }
      paintAt(e.clientX, e.clientY)
    } else {
      // inspect: a press that may turn into a pan
      drag.current = { ...drag.current, press: true, moved: false, sx: e.clientX, sy: e.clientY, ox: v.ox, oy: v.oy }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (transformPointerMove(e)) return
    if (propsRef.current.tool === 'transform') return // no hex hover in resize tool
    const d = drag.current
    if (d.painting) {
      paintAt(e.clientX, e.clientY)
      return
    }
    if (d.panning || d.press) {
      const dx = e.clientX - d.sx
      const dy = e.clientY - d.sy
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true
      if (d.panning || d.moved) {
        // Drag follows the cursor on screen → rotate the delta into ox/oy space.
        const { rot } = view.current
        const cos = Math.cos(rot)
        const sin = Math.sin(rot)
        view.current = { ...view.current, ox: d.ox + cos * dx + sin * dy, oy: d.oy - sin * dx + cos * dy }
        requestPaint()
      }
      return
    }
    const { x, y } = toWorld(e.clientX, e.clientY)
    const id = hexAt(world, x, y) ?? null
    if (id !== hoverRef.current) {
      hoverRef.current = id
      propsRef.current.onHover(id)
      requestPaint()
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    canvasRef.current?.releasePointerCapture(e.pointerId)
    // In the resize tool, never fall through to hex select/paint.
    if (propsRef.current.tool === 'transform') {
      transformPointerUp()
      drag.current = { panning: false, press: false, painting: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 }
      return
    }
    if (transformPointerUp()) return
    const d = drag.current
    if (d.painting) {
      const patches = scratchRef.current
      scratchRef.current = new Map()
      if (patches.size) propsRef.current.onPaintCommit(patches)
    } else if (d.press && !d.moved && e.button === 0) {
      const { x, y } = toWorld(e.clientX, e.clientY)
      propsRef.current.onSelect(hexAt(world, x, y) ?? null)
    }
    drag.current = { panning: false, press: false, painting: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 }
  }

  const onPointerLeave = () => {
    if (hoverRef.current != null) {
      hoverRef.current = null
      propsRef.current.onHover(null)
      requestPaint()
    }
  }

  const zoomBy = (factor: number) => {
    const v = view.current
    const cx = size.w / 2
    const cy = size.h / 2
    const ns = clamp(v.scale * factor, 0.05, 16)
    view.current = { ...v, scale: ns, ox: cx - (cx - v.ox) * (ns / v.scale), oy: cy - (cy - v.oy) * (ns / v.scale) }
    setZoomPct(Math.round(ns * 100))
    requestPaint()
  }

  // Rotate the map about its centre. `delta` is degrees; `abs` sets absolutely.
  const rotateBy = (deltaDeg: number, abs = false) => {
    const next = abs ? deltaDeg : rotDeg + deltaDeg
    view.current = { ...view.current, rot: (next * Math.PI) / 180 }
    setRotDeg(next)
    requestPaint()
  }

  const cursor = props.tool === 'paint' ? 'cell' : props.tool === 'transform' ? 'crosshair' : 'pointer'

  return (
    <div className="hex-canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="hex-canvas"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="view-hud">
        <button className="hud-btn" onClick={() => zoomBy(1 / 1.2)}>
          −
        </button>
        <button className="hud-btn" onClick={fitView}>
          Fit
        </button>
        <button className="hud-btn" onClick={() => zoomBy(1.2)}>
          +
        </button>
        <span className="hud-zoom">{zoomPct}%</span>
        <span className="hud-sep" />
        <button className="hud-btn" title="Rotate anticlockwise" onClick={() => rotateBy(-6)}>
          ⟲
        </button>
        <button className="hud-btn" title="Reset rotation" onClick={() => rotateBy(0, true)}>
          ⟳0
        </button>
        <button className="hud-btn" title="Rotate clockwise" onClick={() => rotateBy(6)}>
          ⟳
        </button>
        <span className="hud-zoom">{Math.round(rotDeg)}°</span>
      </div>
    </div>
  )
}
