/**
 * Assemble a renderable `World` from a backend region slice. The hexes carry
 * GLOBAL axial coords/ids; we compute the render origin so the slice draws at
 * the canvas origin, and build the id/axial lookup maps the renderer needs.
 */

import { axialKey } from '../hex/coords'
import { Hex, World } from './types'
import { WorldMeta, BBox } from './api'

export function buildWorldFromApi(meta: WorldMeta, regionId: string, hexes: Hex[]): World {
  const { pxPerDeg, hexSize, bbox: worldBox } = meta.world
  const region = meta.regions[regionId]
  const slice: BBox = region ? region.bbox : worldBox

  const width = (slice.lonMax - slice.lonMin) * pxPerDeg
  const height = (slice.latMax - slice.latMin) * pxPerDeg
  // Render origin: where the slice's top-left sits in global hex-pixel space.
  const originX = (slice.lonMin - worldBox.lonMin) * pxPerDeg
  const originY = (worldBox.latMax - slice.latMax) * pxPerDeg

  const byId = new Map<number, Hex>()
  const index = new Map<string, number>()
  for (const h of hexes) {
    byId.set(h.hexId, h)
    index.set(axialKey(h.q, h.r), h.hexId)
  }

  return {
    regionId,
    hexSize,
    width,
    height,
    originX,
    originY,
    hexes,
    byId,
    index,
    provinces: new Map(),
    cities: new Map(),
    countries: new Map(),
  }
}
