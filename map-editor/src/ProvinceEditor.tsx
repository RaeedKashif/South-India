import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { TERRAIN, TerrainType } from './types'
import './App.css'

interface ViewBox { x: number; y: number; w: number; h: number }
interface Province {
  id: string
  name: string
  terrain: TerrainType
  notes: string
  d: string
}
type Mode = 'paint' | 'select'

const TRANSITION = 'transform 0.22s cubic-bezier(0.25, 0.46, 0.45, 0.94)'
const LAND_FILL = '#e9e3d4' // unpainted province (none)
const DEFAULT_SVG = '/pakistan-provinces.svg'

// Count coordinate numbers in a path's `d` — used to discard degenerate paths.
const coordCount = (d: string) => (d.match(/-?\d+\.?\d*/g) || []).length

// Parse province polygons + the national border out of an SVG document.
function parseProvinces(text: string): { provinces: Province[]; border: string[]; viewBox: ViewBox } | null {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  if (doc.querySelector('parsererror')) return null
  const paths = Array.from(doc.querySelectorAll('path'))
  if (!paths.length) return null

  const provinces: Province[] = []
  const border: string[] = []
  let n = 1
  for (const p of paths) {
    const d = p.getAttribute('d') || ''
    if (coordCount(d) < 50) continue // skip dots / metadata stubs
    const style = (p.getAttribute('style') || '') + ';' + (p.getAttribute('stroke-width') || '')
    const swMatch = style.match(/stroke-width\s*:?\s*([0-9.]+)/)
    const sw = swMatch ? parseFloat(swMatch[1]) : 1
    if (sw >= 2) {
      border.push(d) // thick outline = national boundary, not a fillable region
    } else {
      provinces.push({ id: p.getAttribute('id') || `p${n}`, name: `Province ${n}`, terrain: 'none', notes: '', d })
      n++
    }
  }
  if (!provinces.length) return null

  // Measure the combined bounding box via a real (offscreen) SVG.
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('style', 'position:absolute;left:-99999px;top:0')
  document.body.appendChild(svg)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  try {
    for (const prov of [...provinces.map(p => p.d), ...border]) {
      const el = document.createElementNS(NS, 'path')
      el.setAttribute('d', prov)
      svg.appendChild(el)
      const b = el.getBBox()
      if (b.x < minX) minX = b.x
      if (b.y < minY) minY = b.y
      if (b.x + b.width > maxX) maxX = b.x + b.width
      if (b.y + b.height > maxY) maxY = b.y + b.height
    }
  } finally {
    document.body.removeChild(svg)
  }
  const pad = 12
  const viewBox: ViewBox = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
  return { provinces, border, viewBox }
}

export default function App() {
  const [provinces, setProvinces] = useState<Province[]>([])
  const [border, setBorder] = useState<string[]>([])
  const [viewBox, setViewBox] = useState<ViewBox | null>(null)
  const [activeTerrain, setActiveTerrain] = useState<TerrainType>('plain')
  const [backgroundTerrain, setBackgroundTerrain] = useState<TerrainType>('water')
  const [mode, setMode] = useState<Mode>('paint')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [showGrid, setShowGrid] = useState(true)
  const [showBorder, setShowBorder] = useState(true)

  const canvasAreaRef = useRef<HTMLDivElement>(null)

  // ── View transform ────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState({ scale: 1, ox: 24, oy: 24 })
  const [animate, setAnimate] = useState(true)
  const zoomRef = useRef(zoom)
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)
  const panRef = useRef({ active: false, sx: 0, sy: 0, ox: 0, oy: 0 })
  const spaceRef = useRef(false)
  useEffect(() => { spaceRef.current = spaceHeld }, [spaceHeld])

  // ── Load the bundled provinces SVG (or a user-supplied one) ───────────────
  const applyParsed = useCallback((text: string) => {
    const parsed = parseProvinces(text)
    if (!parsed) return
    setProvinces(parsed.provinces)
    setBorder(parsed.border)
    setViewBox(parsed.viewBox)
    setSelectedId(null)
  }, [])

  useEffect(() => {
    fetch(DEFAULT_SVG).then(r => r.ok ? r.text() : Promise.reject()).then(applyParsed).catch(() => {})
  }, [applyParsed])

  // ── Fit to view whenever the map loads ────────────────────────────────────
  const fitView = useCallback(() => {
    const el = canvasAreaRef.current
    if (!el || !viewBox) return
    const rect = el.getBoundingClientRect()
    const s = Math.min(rect.width / viewBox.w, rect.height / viewBox.h) * 0.92
    setAnimate(true)
    setZoom({ scale: s, ox: (rect.width - viewBox.w * s) / 2, oy: (rect.height - viewBox.h * s) / 2 })
  }, [viewBox])
  useEffect(() => { fitView() }, [viewBox]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Wheel pan / ctrl-zoom ─────────────────────────────────────────────────
  useEffect(() => {
    const el = canvasAreaRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const { scale, ox, oy } = zoomRef.current
        const rect = el.getBoundingClientRect()
        const mx = e.clientX - rect.left
        const my = e.clientY - rect.top
        const step = e.deltaY > 0 ? -0.1 : 0.1
        const ns = Math.min(8, Math.max(0.1, Math.round((scale + step) * 10) / 10))
        setAnimate(true)
        setZoom({ scale: ns, ox: mx - (mx - ox) * (ns / scale), oy: my - (my - oy) * (ns / scale) })
      } else {
        setAnimate(false)
        setZoom(z => ({ ...z, ox: z.ox - e.deltaX, oy: z.oy - e.deltaY }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const zoomBy = (dir: 1 | -1) => {
    const el = canvasAreaRef.current
    if (!el) return
    const { scale, ox, oy } = zoomRef.current
    const rect = el.getBoundingClientRect()
    const mx = rect.width / 2
    const my = rect.height / 2
    const ns = Math.min(8, Math.max(0.1, Math.round((scale + dir * 0.1) * 10) / 10))
    setAnimate(true)
    setZoom({ scale: ns, ox: mx - (mx - ox) * (ns / scale), oy: my - (my - oy) * (ns / scale) })
  }

  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e.target)) { e.preventDefault(); setSpaceHeld(true) }
    }
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceHeld(false) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])

  useEffect(() => {
    const stop = () => { if (panRef.current.active) { panRef.current.active = false; setPanning(false) } }
    window.addEventListener('pointerup', stop)
    return () => window.removeEventListener('pointerup', stop)
  }, [])

  const onAreaDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
      e.preventDefault()
      panRef.current = { active: true, sx: e.clientX, sy: e.clientY, ox: zoomRef.current.ox, oy: zoomRef.current.oy }
      setPanning(true)
      canvasAreaRef.current?.setPointerCapture?.(e.pointerId)
    }
  }
  const onAreaMove = (e: React.PointerEvent) => {
    if (!panRef.current.active) return
    setAnimate(false)
    setZoom(z => ({ ...z, ox: panRef.current.ox + (e.clientX - panRef.current.sx), oy: panRef.current.oy + (e.clientY - panRef.current.sy) }))
  }

  // ── Province interaction ──────────────────────────────────────────────────
  const updateProvince = useCallback((id: string, patch: Partial<Province>) => {
    setProvinces(prev => prev.map(p => (p.id === id ? { ...p, ...patch } : p)))
  }, [])

  const onProvinceDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || spaceRef.current) return
    e.stopPropagation()
    setSelectedId(id)
    if (mode === 'paint') updateProvince(id, { terrain: activeTerrain })
  }
  const onProvinceContext = (e: React.MouseEvent, id: string) => {
    e.preventDefault()
    updateProvince(id, { terrain: 'none' })
  }

  // ── Hex overlay (cosmetic grid covering the map area) ─────────────────────
  const [hexSize, setHexSize] = useState(26)
  const hexEdges = useMemo(() => {
    if (!viewBox) return [] as { x1: number; y1: number; x2: number; y2: number }[]
    const w = hexSize            // flat-top: horizontal step = 1.5*w; vertical = sqrt3*w
    const stepX = 1.5 * w
    const stepY = Math.sqrt(3) * w
    const cols = Math.ceil(viewBox.w / stepX) + 1
    const rows = Math.ceil(viewBox.h / stepY) + 1
    const seen = new Set<string>()
    const edges: { x1: number; y1: number; x2: number; y2: number }[] = []
    const corner = (cx: number, cy: number, i: number) => {
      const a = (Math.PI / 180) * (60 * i)
      return { x: cx + w * Math.cos(a), y: cy + w * Math.sin(a) }
    }
    for (let q = 0; q < cols; q++) {
      for (let r = 0; r < rows; r++) {
        const cx = viewBox.x + q * stepX + w
        const cy = viewBox.y + r * stepY + (q % 2 ? stepY / 2 : 0) + stepY / 2
        for (let i = 0; i < 6; i++) {
          const a = corner(cx, cy, i)
          const b = corner(cx, cy, (i + 1) % 6)
          const id = `${Math.round(a.x)},${Math.round(a.y)}~${Math.round(b.x)},${Math.round(b.y)}`
          const rid = `${Math.round(b.x)},${Math.round(b.y)}~${Math.round(a.x)},${Math.round(a.y)}`
          if (seen.has(id) || seen.has(rid)) continue
          seen.add(id)
          edges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
        }
      }
    }
    return edges
  }, [viewBox, hexSize])

  // ── Export ────────────────────────────────────────────────────────────────
  const exportJSON = () => {
    const payload = {
      backgroundTerrain,
      viewBox,
      provinces: provinces.map(({ id, name, terrain, notes }) => ({ id, name, terrain, notes })),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'map.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const selected = provinces.find(p => p.id === selectedId) || null
  const cursor = panning ? 'grabbing' : spaceHeld ? 'grab' : (mode === 'paint' ? 'crosshair' : 'pointer')
  const vbStr = viewBox ? `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}` : '0 0 100 100'

  const fillFor = (p: Province) => (p.terrain === 'none' ? LAND_FILL : TERRAIN[p.terrain].color)

  return (
    <div className="app">
      <aside className="sidebar">
        <h1 className="logo">Province Editor</h1>

        <section className="panel">
          <h3>Map</h3>
          <p className="hint">{provinces.length} provinces loaded. Click a province to paint it.</p>
          <button className="btn-outline" onClick={() => document.getElementById('svg-in')?.click()}>
            Load provinces SVG…
          </button>
          <input
            id="svg-in" type="file" accept="image/svg+xml,.svg" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) f.text().then(applyParsed); e.currentTarget.value = '' }}
          />
        </section>

        <section className="panel">
          <h3>Mode</h3>
          <div className="seg">
            <button className={`seg-btn ${mode === 'paint' ? 'active' : ''}`} onClick={() => setMode('paint')}>Paint</button>
            <button className={`seg-btn ${mode === 'select' ? 'active' : ''}`} onClick={() => setMode('select')}>Select</button>
          </div>
          <p className="hint">
            {mode === 'paint'
              ? 'Click a province to fill with the active terrain · right-click to clear.'
              : 'Click a province to select & edit its info (no painting).'}
          </p>
        </section>

        <section className="panel">
          <h3>Terrain</h3>
          <div className="terrain-list">
            {(Object.keys(TERRAIN) as TerrainType[]).filter(t => t !== 'none').map(type => (
              <button
                key={type}
                className={`terrain-btn ${activeTerrain === type ? 'active' : ''}`}
                onClick={() => setActiveTerrain(type)}
              >
                <span className="swatch" style={{ background: TERRAIN[type].color, border: `1px solid ${TERRAIN[type].stroke}` }} />
                {TERRAIN[type].label}
              </button>
            ))}
          </div>
          <div className="slider-row" style={{ marginTop: 8 }}>
            <label>Sea</label>
            <select
              className="select"
              value={backgroundTerrain}
              onChange={e => setBackgroundTerrain(e.target.value as TerrainType)}
            >
              {(Object.keys(TERRAIN) as TerrainType[]).map(t => (
                <option key={t} value={t}>{t === 'none' ? 'White' : TERRAIN[t].label}</option>
              ))}
            </select>
          </div>
        </section>

        {selected && (
          <section className="panel">
            <h3>Selected Province</h3>
            <div className="field">
              <label>Name</label>
              <input className="text-in" value={selected.name} onChange={e => updateProvince(selected.id, { name: e.target.value })} />
            </div>
            <div className="field">
              <label>Terrain</label>
              <select className="select" value={selected.terrain} onChange={e => updateProvince(selected.id, { terrain: e.target.value as TerrainType })}>
                {(Object.keys(TERRAIN) as TerrainType[]).map(t => (
                  <option key={t} value={t}>{t === 'none' ? 'Unpainted' : TERRAIN[t].label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Notes / info</label>
              <textarea className="text-in" rows={3} value={selected.notes} onChange={e => updateProvince(selected.id, { notes: e.target.value })} />
            </div>
          </section>
        )}

        <section className="panel">
          <h3>Overlay</h3>
          <label className="check-row">
            <input type="checkbox" checked={showBorder} onChange={e => setShowBorder(e.target.checked)} />
            National border
          </label>
          <label className="check-row">
            <input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} />
            Hex grid
          </label>
          {showGrid && (
            <div className="slider-row">
              <label>Hex size</label>
              <input type="range" min={12} max={60} step={2} value={hexSize} onChange={e => setHexSize(Number(e.target.value))} />
              <span>{hexSize}</span>
            </div>
          )}
        </section>

        <section className="panel">
          <h3>View — {Math.round(zoom.scale * 100)}%</h3>
          <p className="hint">Scroll to pan · <kbd>Ctrl</kbd>+scroll to zoom · <kbd>Space</kbd>/middle-drag to pan</p>
          <div className="zoom-controls">
            <button className="btn-outline zoom-btn" onClick={() => zoomBy(-1)}>−</button>
            <button className="btn-outline zoom-btn" onClick={fitView}>Fit</button>
            <button className="btn-outline zoom-btn" onClick={() => zoomBy(1)}>+</button>
          </div>
        </section>

        <section className="panel">
          <h3>Actions</h3>
          <button className="btn-primary" onClick={exportJSON}>Export JSON</button>
          <button className="btn-danger" onClick={() => setProvinces(prev => prev.map(p => ({ ...p, terrain: 'none' })))}>Clear all terrain</button>
        </section>
      </aside>

      <main
        className="canvas-area"
        ref={canvasAreaRef}
        style={{ cursor }}
        onPointerDown={onAreaDown}
        onPointerMove={onAreaMove}
      >
        <div
          className="map-wrapper"
          style={{
            transform: `translate(${zoom.ox}px, ${zoom.oy}px) scale(${zoom.scale})`,
            transition: animate ? TRANSITION : 'none',
          }}
        >
          {viewBox && (
            <svg
              className="province-svg"
              width={viewBox.w}
              height={viewBox.h}
              viewBox={vbStr}
              onContextMenu={e => e.preventDefault()}
            >
              {/* Sea / background */}
              <rect
                x={viewBox.x} y={viewBox.y} width={viewBox.w} height={viewBox.h}
                fill={backgroundTerrain === 'none' ? '#ffffff' : TERRAIN[backgroundTerrain].color}
              />

              {/* Provinces */}
              {provinces.map(p => {
                const isSel = p.id === selectedId
                const isHov = p.id === hoveredId
                return (
                  <path
                    key={p.id}
                    d={p.d}
                    fill={fillFor(p)}
                    fillOpacity={0.92}
                    stroke={isSel ? '#1d4ed8' : '#5b6675'}
                    strokeWidth={isSel ? 2.4 : 1}
                    style={{ cursor: 'inherit', filter: isHov ? 'brightness(1.08)' : undefined }}
                    onPointerDown={e => onProvinceDown(e, p.id)}
                    onPointerEnter={() => setHoveredId(p.id)}
                    onPointerLeave={() => setHoveredId(h => (h === p.id ? null : h))}
                    onContextMenu={e => onProvinceContext(e, p.id)}
                  />
                )
              })}

              {/* National border (outline only, non-interactive) */}
              {showBorder && border.map((d, i) => (
                <path key={i} d={d} fill="none" stroke="#11161d" strokeWidth={2.2} pointerEvents="none" />
              ))}

              {/* Hex grid overlay */}
              {showGrid && (
                <g pointerEvents="none">
                  {hexEdges.map((e, i) => (
                    <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="rgba(30,40,55,0.16)" strokeWidth={0.6} />
                  ))}
                </g>
              )}
            </svg>
          )}
        </div>
      </main>
    </div>
  )
}
