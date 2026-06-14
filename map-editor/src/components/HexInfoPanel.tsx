/**
 * HexInfoPanel — appears when a hex is clicked. This is the authoring surface
 * for the per-hex data the spec calls for (country, terrain, elevation,
 * resource, population, infrastructure …). Edits flow up as a HexPatch and are
 * stored in the edit overlay; the panel itself is stateless.
 */

import { TERRAIN, TerrainType } from '../types'
import { ClimateType, Hex } from '../world/types'
import { HexPatch } from '../world/store'
import { RegionDef } from '../world/region'

const CLIMATES: ClimateType[] = ['tropical', 'arid', 'temperate', 'continental', 'highland', 'oceanic']

interface Props {
  hex: Hex | null
  region: RegionDef
  onPatch: (patch: HexPatch) => void
  onReset: () => void
}

export default function HexInfoPanel({ hex, region, onPatch, onReset }: Props) {
  if (!hex) {
    return (
      <section className="panel">
        <h3>Hex</h3>
        <p className="hint">Click any hex on the map to inspect and edit it.</p>
      </section>
    )
  }

  return (
    <section className="panel">
      <h3>
        Hex #{hex.hexId} {hex.isLand ? (hex.isCoastal ? '· coast' : '· land') : '· sea'}
      </h3>
      <div className="meta-grid">
        <span>axial</span>
        <b>
          {hex.q}, {hex.r}
        </b>
        <span>lat / lon</span>
        <b>
          {hex.lat.toFixed(2)}, {hex.lon.toFixed(2)}
        </b>
      </div>

      <div className="field">
        <label>Country</label>
        <select
          className="select"
          value={hex.countryId ?? ''}
          onChange={(e) => onPatch({ countryId: e.target.value || null })}
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
        <label>Terrain</label>
        <select
          className="select"
          value={hex.terrain}
          onChange={(e) => onPatch({ terrain: e.target.value as TerrainType })}
        >
          {(Object.keys(TERRAIN) as TerrainType[]).map((t) => (
            <option key={t} value={t}>
              {TERRAIN[t].label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Climate</label>
        <select
          className="select"
          value={hex.climate}
          onChange={(e) => onPatch({ climate: e.target.value as ClimateType })}
        >
          {CLIMATES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Elevation (m)</label>
        <input
          className="text-in"
          type="number"
          value={hex.elevation}
          onChange={(e) => onPatch({ elevation: Number(e.target.value) || 0 })}
        />
      </div>

      <div className="field">
        <label>Resource</label>
        <input
          className="text-in"
          placeholder="e.g. wheat, iron, oil"
          value={hex.resourceId ?? ''}
          onChange={(e) => onPatch({ resourceId: e.target.value || null })}
        />
      </div>

      <div className="field">
        <label>Population</label>
        <input
          className="text-in"
          type="number"
          value={hex.population}
          onChange={(e) => onPatch({ population: Number(e.target.value) || 0 })}
        />
      </div>

      <div className="field">
        <label>Infrastructure (level)</label>
        <input
          className="text-in"
          type="number"
          min={0}
          max={10}
          value={hex.infrastructure}
          onChange={(e) => onPatch({ infrastructure: Number(e.target.value) || 0 })}
        />
      </div>

      <div className="field">
        <label>Province (id — relational layer coming next)</label>
        <input
          className="text-in"
          type="number"
          value={hex.provinceId ?? ''}
          onChange={(e) =>
            onPatch({ provinceId: e.target.value === '' ? null : Number(e.target.value) })
          }
        />
      </div>

      <button className="btn-danger" onClick={onReset}>
        Reset hex to defaults
      </button>
    </section>
  )
}
