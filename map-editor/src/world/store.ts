/**
 * Persistence. The base hex grid is *derived* (regenerated deterministically
 * from GeoJSON + resolution), so we never persist it. We persist only the
 * authored overlay — the fields a designer changed per hex — keyed by hexId.
 * This keeps saves tiny and lets the underlying terrain data improve later
 * without throwing away hand edits.
 *
 * Three surfaces:
 *   - localStorage autosave (fast, per region+resolution)
 *   - export: a full merged snapshot as JSON (portable; maps 1:1 to a DB)
 *   - import: load such a snapshot back
 */

import { Hex, World } from './types'

export type HexPatch = Partial<
  Pick<
    Hex,
    | 'terrain'
    | 'elevation'
    | 'climate'
    | 'provinceId'
    | 'countryId'
    | 'resourceId'
    | 'population'
    | 'infrastructure'
  >
>

export type EditOverlay = Map<number, HexPatch>

const keyFor = (regionId: string, hexSize: number) => `worldgame:${regionId}:${hexSize}`

export function saveEdits(world: World, edits: EditOverlay): void {
  try {
    const payload = {
      regionId: world.regionId,
      hexSize: world.hexSize,
      savedAt: Date.now(),
      edits: Array.from(edits.entries()),
    }
    localStorage.setItem(keyFor(world.regionId, world.hexSize), JSON.stringify(payload))
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}

export function loadEdits(regionId: string, hexSize: number): EditOverlay {
  try {
    const raw = localStorage.getItem(keyFor(regionId, hexSize))
    if (!raw) return new Map()
    const data = JSON.parse(raw)
    return new Map(data.edits as [number, HexPatch][])
  } catch {
    return new Map()
  }
}

/** Merge a patch onto a hex (used by both renderer and exporter). */
export function applyPatch(hex: Hex, patch: HexPatch | undefined): Hex {
  return patch ? { ...hex, ...patch } : hex
}

/** Full snapshot — every hex with edits merged in. This is the DB-shaped form. */
export function exportSnapshot(world: World, edits: EditOverlay) {
  return {
    version: 1,
    regionId: world.regionId,
    hexSize: world.hexSize,
    bounds: { width: world.width, height: world.height },
    hexes: world.hexes.map((h) => applyPatch(h, edits.get(h.hexId))),
    provinces: Array.from(world.provinces.values()),
    cities: Array.from(world.cities.values()),
    countries: Array.from(world.countries.values()),
  }
}

export function download(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Rebuild an edit overlay from a previously exported snapshot. */
export function overlayFromSnapshot(snapshot: any, base: World): EditOverlay {
  const edits: EditOverlay = new Map()
  const baseById = new Map(base.hexes.map((h) => [h.hexId, h]))
  for (const h of snapshot.hexes ?? []) {
    const b = baseById.get(h.hexId)
    if (!b) continue
    const patch: HexPatch = {}
    if (h.terrain !== b.terrain) patch.terrain = h.terrain
    if (h.elevation !== b.elevation) patch.elevation = h.elevation
    if (h.climate !== b.climate) patch.climate = h.climate
    if (h.provinceId !== b.provinceId) patch.provinceId = h.provinceId
    if (h.countryId !== b.countryId) patch.countryId = h.countryId
    if (h.resourceId !== b.resourceId) patch.resourceId = h.resourceId
    if (h.population !== b.population) patch.population = h.population
    if (h.infrastructure !== b.infrastructure) patch.infrastructure = h.infrastructure
    if (Object.keys(patch).length) edits.set(h.hexId, patch)
  }
  return edits
}
