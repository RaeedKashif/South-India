import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { TERRAIN, TerrainType } from './types'
import { SOUTH_ASIA, countryName } from './world/region'
import { CountryId, World } from './world/types'
import { worldStats } from './world/buildWorld'
import { applyPatch, download, EditOverlay, exportSnapshot, HexPatch, overlayFromSnapshot } from './world/store'
import {
  fetchBorders,
  fetchEdits,
  fetchMeta,
  fetchProvinces,
  fetchRegionHexes,
  ProvinceMeta,
  saveEditsApi,
  saveProvincesApi,
  WorldMeta,
} from './world/api'
import { buildWorldFromApi } from './world/fromApi'
import HexCanvas, { MapStyle, PaintTarget, Tool, ViewMode } from './components/HexCanvas'

// Deterministic, distinct colour for a province id.
const provinceColor = (id: number) => `hsl(${(id * 47) % 360}, 55%, 62%)`
import HexInfoPanel from './components/HexInfoPanel'

const region = SOUTH_ASIA
const REGION_ID = 'south_asia'

export default function App() {
  const [world, setWorld] = useState<World | null>(null)
  const [meta, setMeta] = useState<WorldMeta | null>(null)
  const [geojson, setGeojson] = useState<any>(null)
  const [edits, setEdits] = useState<EditOverlay>(new Map())
  const [error, setError] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [hoveredId, setHoveredId] = useState<number | null>(null)

  const [mapStyle, setMapStyle] = useState<MapStyle>('political')
  const [editCountries, setEditCountries] = useState(false)
  const [showSmoothOwnership, setShowSmoothOwnership] = useState(false)
  const [showProvinceBorders, setShowProvinceBorders] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('country')
  const [showSea, setShowSea] = useState(true)
  const [showGrid, setShowGrid] = useState(true)
  const [showBorders, setShowBorders] = useState(true)

  const [provinces, setProvinces] = useState<Map<number, ProvinceMeta>>(new Map())
  const [activeProvinceId, setActiveProvinceId] = useState<number | null>(null)
  const [selectedProvinceId, setSelectedProvinceId] = useState<number | null>(null)

  const [tool, setTool] = useState<Tool>('inspect')
  const [paintTarget, setPaintTarget] = useState<PaintTarget>('country')
  const [brushCountry, setBrushCountry] = useState<CountryId | null>('PAK')
  const [brushTerrain, setBrushTerrain] = useState<TerrainType>('plain')
  const [brushSize, setBrushSize] = useState(3)
  // Resized country shapes (iso -> scaled vector MultiPolygon, lon/lat).
  const [countryShapes, setCountryShapes] = useState<Map<string, number[][][][]>>(new Map())
  const onCountryShape = useCallback((iso: string, shape: number[][][][]) => {
    setCountryShapes((prev) => new Map(prev).set(iso, shape))
  }, [])

  // ── Load: world meta + South Asia slice + saved edits + borders ────────────
  useEffect(() => {
    let alive = true
    Promise.all([fetchMeta(), fetchRegionHexes(REGION_ID), fetchEdits(), fetchProvinces()])
      .then(([m, slice, savedEdits, savedProvinces]) => {
        if (!alive) return
        setMeta(m)
        setWorld(buildWorldFromApi(m, REGION_ID, slice.hexes))
        setEdits(savedEdits)
        setProvinces(savedProvinces)
      })
      .catch(() => alive && setError('Cannot reach the backend. Start it with: cd server && npm start'))
    fetchBorders(REGION_ID)
      .then((g) => alive && setGeojson(g))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // ── Autosave edits to the backend (debounced) ──────────────────────────────
  const firstSave = useRef(true)
  useEffect(() => {
    if (!world) return
    if (firstSave.current) {
      firstSave.current = false
      return
    } // don't re-save what we just loaded
    const t = setTimeout(() => saveEditsApi(edits).catch(() => {}), 500)
    return () => clearTimeout(t)
  }, [edits, world])

  const firstProvSave = useRef(true)
  useEffect(() => {
    if (!world) return
    if (firstProvSave.current) {
      firstProvSave.current = false
      return
    }
    const t = setTimeout(() => saveProvincesApi(provinces).catch(() => {}), 500)
    return () => clearTimeout(t)
  }, [provinces, world])

  // hex count per province (effective membership, incl. unsaved edits)
  const provinceCounts = useMemo(() => {
    const m = new Map<number, number>()
    if (world) for (const h of world.hexes) {
      const pid = edits.get(h.hexId)?.provinceId ?? h.provinceId
      if (pid != null) m.set(pid, (m.get(pid) ?? 0) + 1)
    }
    return m
  }, [world, edits])

  const stats = useMemo(() => (world ? worldStats(world) : null), [world])

  const selectedHex = useMemo(() => {
    if (!world || selectedId == null) return null
    const base = world.byId.get(selectedId)
    return base ? applyPatch(base, edits.get(selectedId)) : null
  }, [world, selectedId, edits])

  const hoveredHex = useMemo(() => {
    if (!world || hoveredId == null) return null
    const base = world.byId.get(hoveredId)
    return base ? applyPatch(base, edits.get(hoveredId)) : null
  }, [world, hoveredId, edits])

  const patchSelected = useCallback(
    (patch: HexPatch) => {
      if (selectedId == null) return
      setEdits((prev) => new Map(prev).set(selectedId, { ...prev.get(selectedId), ...patch }))
    },
    [selectedId],
  )

  const resetSelected = useCallback(() => {
    if (selectedId == null) return
    setEdits((prev) => {
      const next = new Map(prev)
      next.delete(selectedId)
      return next
    })
  }, [selectedId])

  const onPaintCommit = useCallback((patches: Map<number, HexPatch>) => {
    setEdits((prev) => {
      const next = new Map(prev)
      for (const [id, patch] of patches) next.set(id, { ...prev.get(id), ...patch })
      return next
    })
  }, [])

  // ── Province registry operations ───────────────────────────────────────────
  const createProvince = useCallback(() => {
    const id = (provinces.size ? Math.max(...provinces.keys()) : 0) + 1
    const meta: ProvinceMeta = { id, name: `Province ${id}`, countryId: null, color: provinceColor(id) }
    setProvinces((prev) => new Map(prev).set(id, meta))
    setActiveProvinceId(id)
    setSelectedProvinceId(id)
    setTool('paint')
    setPaintTarget('province')
  }, [provinces])

  const updateProvince = useCallback((id: number, patch: Partial<ProvinceMeta>) => {
    setProvinces((prev) => {
      const cur = prev.get(id)
      if (!cur) return prev
      return new Map(prev).set(id, { ...cur, ...patch })
    })
  }, [])

  // Reassign every hex currently in `from` to `to` (null = unassign).
  const reassignHexes = useCallback(
    (from: number, to: number | null) => {
      if (!world) return
      setEdits((prev) => {
        const next = new Map(prev)
        for (const h of world.hexes) {
          const pid = next.get(h.hexId)?.provinceId ?? h.provinceId
          if (pid === from) next.set(h.hexId, { ...next.get(h.hexId), provinceId: to })
        }
        return next
      })
    },
    [world],
  )

  const deleteProvince = useCallback(
    (id: number) => {
      reassignHexes(id, null)
      setProvinces((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
      setSelectedProvinceId((s) => (s === id ? null : s))
      setActiveProvinceId((a) => (a === id ? null : a))
    },
    [reassignHexes],
  )

  const mergeProvince = useCallback(
    (src: number, dst: number) => {
      if (src === dst) return
      reassignHexes(src, dst)
      setProvinces((prev) => {
        const next = new Map(prev)
        next.delete(src)
        return next
      })
      setSelectedProvinceId(dst)
    },
    [reassignHexes],
  )

  // Assign a province (and all its hexes) to a country — the ownership chain.
  const setProvinceCountry = useCallback(
    (id: number, countryId: CountryId | null) => {
      updateProvince(id, { countryId })
      if (!world) return
      setEdits((prev) => {
        const next = new Map(prev)
        for (const h of world.hexes) {
          const pid = next.get(h.hexId)?.provinceId ?? h.provinceId
          if (pid === id) next.set(h.hexId, { ...next.get(h.hexId), countryId })
        }
        return next
      })
    },
    [world, updateProvince],
  )

  const selectedProvince = selectedProvinceId != null ? provinces.get(selectedProvinceId) ?? null : null

  const onExport = () => {
    if (world) download(`${REGION_ID}.json`, exportSnapshot(world, edits))
  }
  const onImport = (file: File) => {
    file.text().then((t) => {
      if (!world) return
      try {
        setEdits(overlayFromSnapshot(JSON.parse(t), world))
      } catch {
        /* ignore */
      }
    })
  }

  const painting = tool === 'paint'

  if (error)
    return (
      <div className="app">
        <div className="boot-msg error">
          <h2>Backend offline</h2>
          <p>{error}</p>
          <p className="hint">Then reload. The world is generated &amp; stored on the server (first run ~4s).</p>
        </div>
      </div>
    )

  if (!world)
    return (
      <div className="app">
        <div className="boot-msg">Loading world…</div>
      </div>
    )

  return (
    <div className="app">
      <aside className="sidebar">
        <h1 className="logo">World Map · South Asia</h1>

        <section className="panel">
          <h3>World</h3>
          <p className="hint">
            Backend stores the whole planet:{' '}
            <b>{meta ? meta.counts.total.toLocaleString() : '—'}</b> hexes (
            {meta ? meta.counts.land.toLocaleString() : '—'} land, {meta ? meta.countries.length : '—'} countries).
          </p>
          <p className="hint">
            Showing the <b>South Asia</b> slice: {stats!.total.toLocaleString()} hexes · {stats!.land.toLocaleString()}{' '}
            land.
          </p>
        </section>

        <section className="panel">
          <h3>Tool</h3>
          <div className="seg">
            <button className={`seg-btn ${tool === 'inspect' ? 'active' : ''}`} onClick={() => setTool('inspect')}>
              Inspect
            </button>
            <button className={`seg-btn ${tool === 'paint' ? 'active' : ''}`} onClick={() => setTool('paint')}>
              ✏ Paint
            </button>
            <button
              className={`seg-btn ${tool === 'transform' ? 'active' : ''}`}
              onClick={() => {
                setTool('transform')
                setMapStyle('political')
                setEditCountries(false)
              }}
            >
              ⤢ Resize
            </button>
          </div>
          {tool === 'transform' && (
            <>
              <p className="hint">
                <b>Click a country</b> to select it, then drag the corner handles to make it <b>bigger or
                smaller</b> — its real smooth shape scales without distortion. Drag inside the box to move it.
                Click another country to switch.
              </p>
              {countryShapes.size > 0 && (
                <button className="btn-outline" onClick={() => setCountryShapes(new Map())}>
                  Reset resized countries ({countryShapes.size})
                </button>
              )}
            </>
          )}
          {painting ? (
            <>
              <div className="seg" style={{ marginTop: 6 }}>
                {(['country', 'province', 'terrain'] as PaintTarget[]).map((t) => (
                  <button
                    key={t}
                    className={`seg-btn ${paintTarget === t ? 'active' : ''}`}
                    onClick={() => setPaintTarget(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <p className="hint">
                Drag to paint{' '}
                <b>
                  {paintTarget === 'country'
                    ? brushCountry
                      ? countryName(region, brushCountry)
                      : 'Unassigned'
                    : paintTarget === 'province'
                    ? activeProvinceId != null
                      ? provinces.get(activeProvinceId)?.name ?? `Province ${activeProvinceId}`
                      : '(create/select a province below)'
                    : TERRAIN[brushTerrain].label}
                </b>
                . Hold <kbd>Space</kbd> to pan. Pick the brush below.
              </p>
              <div className="field">
                <label>Brush size · {brushSize === 1 ? '1 hex' : `${brushSize} hexes wide`}</label>
                <input
                  type="range"
                  min={1}
                  max={8}
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  style={{ width: '100%' }}
                />
              </div>
            </>
          ) : tool === 'inspect' ? (
            <p className="hint">Click a hex to inspect &amp; edit. Switch to Paint to draw borders.</p>
          ) : null}
        </section>

        <section className="panel">
          <h3>Map style</h3>
          <div className="seg">
            <button
              className={`seg-btn ${mapStyle === 'political' ? 'active' : ''}`}
              onClick={() => setMapStyle('political')}
            >
              Political
            </button>
            <button className={`seg-btn ${mapStyle === 'hex' ? 'active' : ''}`} onClick={() => setMapStyle('hex')}>
              Hex (gameplay)
            </button>
          </div>
          <p className="hint">
            {mapStyle === 'political'
              ? 'Smooth, accurate country shapes (vector). Hexes are the gameplay layer underneath.'
              : 'Raw hex grid coloured by the data below — the gameplay view.'}
          </p>
          {mapStyle === 'political' && (
            <>
              <button
                className={editCountries ? 'btn-primary' : 'btn-outline'}
                style={{ marginTop: 6 }}
                onClick={() => {
                  const on = !editCountries
                  setEditCountries(on)
                  if (on) {
                    setTool('paint')
                    setPaintTarget('country')
                  }
                }}
              >
                {editCountries ? '● Editing borders — click to finish' : '✏ Edit borders'}
              </button>
              {editCountries && (
                <p className="hint">
                  Country shapes are now driven by the hexes. Pick a country below, then drag on the map to
                  expand or shrink it — borders reshape live and autosave.
                </p>
              )}
            </>
          )}
        </section>

        {mapStyle === 'hex' && (
          <section className="panel">
            <h3>Colour by</h3>
            <div className="seg">
              {(['country', 'terrain', 'elevation', 'population'] as ViewMode[]).map((m) => (
                <button key={m} className={`seg-btn ${viewMode === m ? 'active' : ''}`} onClick={() => setViewMode(m)}>
                  {m}
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="panel">
          <h3>Layers</h3>
          <label className="check-row">
            <input type="checkbox" checked={showSea} onChange={(e) => setShowSea(e.target.checked)} /> Sea hexes
          </label>
          <label className="check-row">
            <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> Hex grid lines
          </label>
          <label className="check-row">
            <input type="checkbox" checked={showBorders} onChange={(e) => setShowBorders(e.target.checked)} /> Country
            borders
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={showProvinceBorders}
              onChange={(e) => setShowProvinceBorders(e.target.checked)}
            />{' '}
            Province borders
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={showSmoothOwnership}
              onChange={(e) => setShowSmoothOwnership(e.target.checked)}
            />{' '}
            Smooth outlines from hexes
          </label>
        </section>

        {(viewMode === 'country' || (painting && paintTarget === 'country')) && (
          <section className="panel">
            <h3>Countries {painting && paintTarget === 'country' ? '· pick brush' : ''}</h3>
            <div className="terrain-list">
              {painting && paintTarget === 'country' && (
                <button
                  className={`terrain-btn ${brushCountry === null ? 'active' : ''}`}
                  onClick={() => setBrushCountry(null)}
                >
                  <span className="swatch" style={{ background: '#d8d0bd' }} />
                  Unassigned
                </button>
              )}
              {region.countries.map((c) => {
                const pick = painting && paintTarget === 'country'
                return (
                  <button
                    key={c.id}
                    className={`terrain-btn ${pick && brushCountry === c.id ? 'active' : ''}`}
                    style={{ cursor: pick ? 'pointer' : 'default' }}
                    onClick={() => pick && setBrushCountry(c.id)}
                  >
                    <span className="swatch" style={{ background: c.color }} />
                    {c.name}
                    {stats && <span className="count">{(stats.byCountry[c.id] ?? 0).toLocaleString()}</span>}
                  </button>
                )
              })}
            </div>
          </section>
        )}

        {(viewMode === 'terrain' || (painting && paintTarget === 'terrain')) && (
          <section className="panel">
            <h3>Terrain {painting && paintTarget === 'terrain' ? '· pick brush' : ''}</h3>
            <div className="terrain-list">
              {(Object.keys(TERRAIN) as TerrainType[])
                .filter((t) => t !== 'none')
                .map((t) => {
                  const pick = painting && paintTarget === 'terrain'
                  return (
                    <button
                      key={t}
                      className={`terrain-btn ${pick && brushTerrain === t ? 'active' : ''}`}
                      style={{ cursor: pick ? 'pointer' : 'default' }}
                      onClick={() => pick && setBrushTerrain(t)}
                    >
                      <span className="swatch" style={{ background: TERRAIN[t].color }} />
                      {TERRAIN[t].label}
                    </button>
                  )
                })}
            </div>
          </section>
        )}

        <section className="panel">
          <h3>Provinces ({provinces.size})</h3>
          <button className="btn-primary" onClick={createProvince}>
            + New province
          </button>
          {provinces.size > 0 && (
            <div className="terrain-list" style={{ marginTop: 6, maxHeight: 180, overflowY: 'auto' }}>
              {[...provinces.values()].map((p) => (
                <button
                  key={p.id}
                  className={`terrain-btn ${selectedProvinceId === p.id ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedProvinceId(p.id)
                    setActiveProvinceId(p.id)
                  }}
                >
                  <span className="swatch" style={{ background: p.color }} />
                  {p.name}
                  <span className="count">{provinceCounts.get(p.id) ?? 0}</span>
                </button>
              ))}
            </div>
          )}
          {selectedProvince && (
            <div style={{ marginTop: 8 }}>
              <div className="field">
                <label>Name</label>
                <input
                  className="text-in"
                  value={selectedProvince.name}
                  onChange={(e) => updateProvince(selectedProvince.id, { name: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Owning country</label>
                <select
                  className="select"
                  value={selectedProvince.countryId ?? ''}
                  onChange={(e) => setProvinceCountry(selectedProvince.id, e.target.value || null)}
                >
                  <option value="">— none —</option>
                  {region.countries.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Merge into…</label>
                <select
                  className="select"
                  value=""
                  onChange={(e) => e.target.value && mergeProvince(selectedProvince.id, Number(e.target.value))}
                >
                  <option value="">choose province…</option>
                  {[...provinces.values()]
                    .filter((p) => p.id !== selectedProvince.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </div>
              <button className="btn-danger" onClick={() => deleteProvince(selectedProvince.id)}>
                Delete province (unassign hexes)
              </button>
            </div>
          )}
          <p className="hint">Paint hexes with the Province target to fill a province; its border is generated smoothly.</p>
        </section>

        <HexInfoPanel hex={selectedHex} region={region} onPatch={patchSelected} onReset={resetSelected} />

        <section className="panel">
          <h3>Data</h3>
          <button className="btn-primary" onClick={onExport}>
            Export slice JSON
          </button>
          <button className="btn-outline" onClick={() => document.getElementById('imp')?.click()}>
            Import snapshot…
          </button>
          <input
            id="imp"
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onImport(f)
              e.currentTarget.value = ''
            }}
          />
          <button className="btn-danger" onClick={() => setEdits(new Map())}>
            Clear all edits
          </button>
          <p className="hint">Edits autosave to the backend.</p>
        </section>
      </aside>

      <main className="canvas-area">
        <HexCanvas
          world={world}
          region={region}
          edits={edits}
          geojson={geojson}
          mapStyle={mapStyle}
          editCountries={editCountries}
          showSmoothOwnership={showSmoothOwnership}
          showProvinceBorders={showProvinceBorders}
          selectedProvinceId={selectedProvinceId}
          activeProvinceId={activeProvinceId}
          viewMode={viewMode}
          showSea={showSea}
          showGrid={showGrid}
          showBorders={showBorders}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onHover={setHoveredId}
          tool={tool}
          paintTarget={paintTarget}
          brushCountry={brushCountry}
          brushTerrain={brushTerrain}
          brushSize={brushSize}
          onPaintCommit={onPaintCommit}
          countryShapes={countryShapes}
          onCountryShape={onCountryShape}
        />
        <div className="status-bar">
          {hoveredHex ? (
            <>
              <b>#{hoveredHex.hexId}</b> ·{' '}
              {hoveredHex.isLand || hoveredHex.countryId ? countryName(region, hoveredHex.countryId) : 'Sea'} ·{' '}
              {TERRAIN[hoveredHex.terrain].label} · {hoveredHex.lat.toFixed(2)}, {hoveredHex.lon.toFixed(2)}
            </>
          ) : (
            <span className="hint">Scroll to pan · Ctrl/⌘+scroll to zoom · Space+drag to pan · click/paint a hex</span>
          )}
        </div>
      </main>
    </div>
  )
}
