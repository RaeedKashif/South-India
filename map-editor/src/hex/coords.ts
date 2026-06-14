/**
 * Hex grid math — pointy-top, axial (q, r) coordinates with cube rounding.
 *
 * This module is the single source of truth for how hexes relate to pixels and
 * to each other. It is intentionally pure (no rendering, no game data) so it can
 * be unit-tested and reused by the renderer, pathfinder, and world generator.
 *
 * Reference: https://www.redblobgames.com/grids/hexagons/
 *
 *   axial:  q (column-ish), r (row).  cube: x=q, z=r, y=-x-z   (x+y+z === 0)
 *   pointy-top layout:
 *     width  (flat-to-flat) = sqrt(3) * size
 *     height (point-to-point) = 2 * size
 *     column spacing = sqrt(3) * size
 *     row spacing    = 1.5 * size
 */

export const SQRT3 = Math.sqrt(3)

export interface Axial {
  q: number
  r: number
}

export interface Point {
  x: number
  y: number
}

/** Stable string key for a hex, used for neighbour lookups and indexing. */
export const axialKey = (q: number, r: number): string => `${q},${r}`

/** Centre pixel of hex (q, r) for a given circumradius `size`, origin at (0,0). */
export function axialToPixel(q: number, r: number, size: number): Point {
  return {
    x: size * SQRT3 * (q + r / 2),
    y: size * 1.5 * r,
  }
}

/** Round fractional cube coords to the nearest integer hex (keeps x+y+z===0). */
function cubeRound(xf: number, yf: number, zf: number): Axial {
  let rx = Math.round(xf)
  let ry = Math.round(yf)
  let rz = Math.round(zf)
  const dx = Math.abs(rx - xf)
  const dy = Math.abs(ry - yf)
  const dz = Math.abs(rz - zf)
  if (dx > dy && dx > dz) rx = -ry - rz
  else if (dy > dz) ry = -rx - rz
  else rz = -rx - ry
  return { q: rx, r: rz }
}

/** Pixel -> nearest hex (inverse of axialToPixel + rounding). */
export function pixelToAxial(x: number, y: number, size: number): Axial {
  const qf = ((SQRT3 / 3) * x - (1 / 3) * y) / size
  const rf = ((2 / 3) * y) / size
  return cubeRound(qf, -qf - rf, rf)
}

/** The six corner points of a pointy-top hex centred at (cx, cy). */
export function hexCorners(cx: number, cy: number, size: number): Point[] {
  const pts: Point[] = []
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30) // -30° => pointy top
    pts.push({ x: cx + size * Math.cos(angle), y: cy + size * Math.sin(angle) })
  }
  return pts
}

/** Axial offsets to the six neighbours of a pointy-top hex (E order). */
export const NEIGHBOR_DIRS: ReadonlyArray<Axial> = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
]

export function neighbors(q: number, r: number): Axial[] {
  return NEIGHBOR_DIRS.map((d) => ({ q: q + d.q, r: r + d.r }))
}

/** Cube/axial distance in hex steps — basis for movement cost & pathfinding. */
export function hexDistance(a: Axial, b: Axial): number {
  const ax = a.q
  const az = a.r
  const ay = -ax - az
  const bx = b.q
  const bz = b.r
  const by = -bx - bz
  return (Math.abs(ax - bx) + Math.abs(ay - by) + Math.abs(az - bz)) / 2
}
