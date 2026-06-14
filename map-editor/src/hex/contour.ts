/**
 * Smooth polygon outlines from a set of hexes.
 *
 * This is the bridge from the discrete gameplay layer (which hexes a country /
 * province owns) to a smooth visual border. It does NOT touch gameplay data —
 * it only produces render geometry.
 *
 * Algorithm:
 *   1. Each hex contributes its 6 edges. An edge shared by two hexes IN the set
 *      appears twice and is interior; an edge appearing once is on the boundary.
 *   2. Stitch the boundary edges end-to-end into closed loops (a country can
 *      have several — mainland + islands + holes).
 *   3. Smooth each loop with Chaikin corner-cutting so the hard 120° hex
 *      zig-zag becomes a soft curve.
 *
 * Result loops are in the same render space as the canvas (origin already
 * subtracted), ready to stroke/fill. Recompute only when ownership changes.
 */

import { hexCorners, Point } from './coords'

export interface Cell {
  q: number
  r: number
}

const keyPt = (p: Point) => `${Math.round(p.x * 2)}|${Math.round(p.y * 2)}` // 0.5px snap
const edgeId = (a: string, b: string) => (a < b ? `${a}>${b}` : `${b}>${a}`)

export function hexUnionOutline(
  cells: Cell[],
  hexSize: number,
  originX: number,
  originY: number,
  smoothing = 2,
): Point[][] {
  const SQRT3 = Math.sqrt(3)
  const edges = new Map<string, { a: Point; b: Point; count: number }>()

  for (const c of cells) {
    const cx = hexSize * SQRT3 * (c.q + c.r / 2) - originX
    const cy = hexSize * 1.5 * c.r - originY
    const corners = hexCorners(cx, cy, hexSize)
    for (let i = 0; i < 6; i++) {
      const a = corners[i]
      const b = corners[(i + 1) % 6]
      const id = edgeId(keyPt(a), keyPt(b))
      const e = edges.get(id)
      if (e) e.count++
      else edges.set(id, { a, b, count: 1 })
    }
  }

  // Boundary = edges used by exactly one hex.
  const adj = new Map<string, Point[]>()
  const addAdj = (p: Point, q: Point) => {
    const k = keyPt(p)
    const arr = adj.get(k)
    if (arr) arr.push(q)
    else adj.set(k, [q])
  }
  for (const e of edges.values()) {
    if (e.count !== 1) continue
    addAdj(e.a, e.b)
    addAdj(e.b, e.a)
  }

  // Walk loops, consuming each boundary edge once.
  const used = new Set<string>()
  const loops: Point[][] = []
  for (const e of edges.values()) {
    if (e.count !== 1) continue
    const startId = edgeId(keyPt(e.a), keyPt(e.b))
    if (used.has(startId)) continue

    const loop: Point[] = [e.a]
    let from = e.a
    let cur = e.b
    used.add(startId)
    let guard = 0
    while (guard++ < 1_000_000) {
      loop.push(cur)
      const neighbours = adj.get(keyPt(cur)) ?? []
      let next: Point | undefined
      for (const n of neighbours) {
        if (keyPt(n) === keyPt(from)) continue
        if (used.has(edgeId(keyPt(cur), keyPt(n)))) continue
        next = n
        break
      }
      if (!next) break
      used.add(edgeId(keyPt(cur), keyPt(next)))
      from = cur
      cur = next
      if (keyPt(cur) === keyPt(e.a)) break // closed
    }
    if (loop.length >= 3) loops.push(loop)
  }

  return loops.map((l) => chaikin(l, smoothing))
}

/** Chaikin corner-cutting on a closed loop. Each pass quadruples vertices and
 *  rounds corners; 2 passes is a good balance of smoothness vs cost. */
function chaikin(pts: Point[], iterations: number): Point[] {
  let out = pts
  for (let it = 0; it < iterations; it++) {
    const n = out.length
    const next: Point[] = []
    for (let i = 0; i < n; i++) {
      const p = out[i]
      const q = out[(i + 1) % n]
      next.push({ x: p.x * 0.75 + q.x * 0.25, y: p.y * 0.75 + q.y * 0.25 })
      next.push({ x: p.x * 0.25 + q.x * 0.75, y: p.y * 0.25 + q.y * 0.75 })
    }
    out = next
  }
  return out
}
