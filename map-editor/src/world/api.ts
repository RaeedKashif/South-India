/**
 * Backend client. The authoritative world lives on the server; the browser
 * fetches a region slice + the edit overlay and writes edits back. All requests
 * go through the Vite dev proxy at /api (see vite.config.ts).
 */

import { Hex } from './types'
import { HexPatch, EditOverlay } from './store'

export interface BBox {
  lonMin: number
  latMin: number
  lonMax: number
  latMax: number
}

export interface WorldMeta {
  world: { bbox: BBox; pxPerDeg: number; hexSize: number; width: number; height: number; count: number }
  regions: Record<string, { id: string; name: string; bbox: BBox }>
  countries: { id: string; name: string; color: string }[]
  counts: { total: number; land: number }
}

const API = '/api'

export async function fetchMeta(): Promise<WorldMeta> {
  const r = await fetch(`${API}/meta`)
  if (!r.ok) throw new Error('meta fetch failed')
  return r.json()
}

export async function fetchRegionHexes(region: string): Promise<{ bbox: BBox; hexes: Hex[] }> {
  const r = await fetch(`${API}/hexes?region=${encodeURIComponent(region)}`)
  if (!r.ok) throw new Error('hexes fetch failed')
  return r.json()
}

/** Geographic vector layer (country polygons + colours) for a region. */
export async function fetchBorders(region: string): Promise<any> {
  const r = await fetch(`${API}/borders?region=${encodeURIComponent(region)}`)
  if (!r.ok) throw new Error('borders fetch failed')
  return r.json()
}

export async function fetchEdits(): Promise<EditOverlay> {
  const r = await fetch(`${API}/edits`)
  if (!r.ok) return new Map()
  const obj = (await r.json()) as Record<string, HexPatch>
  return new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]))
}

export async function saveEditsApi(edits: EditOverlay): Promise<void> {
  const obj: Record<string, HexPatch> = {}
  for (const [id, patch] of edits) obj[id] = patch
  await fetch(`${API}/edits`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  })
}

// ── Provinces ───────────────────────────────────────────────────────────────
// Light metadata; hex→province membership lives in the edit overlay.
export interface ProvinceMeta {
  id: number
  name: string
  countryId: string | null
  color: string
}

export async function fetchProvinces(): Promise<Map<number, ProvinceMeta>> {
  const r = await fetch(`${API}/provinces`)
  if (!r.ok) return new Map()
  const obj = (await r.json()) as Record<string, ProvinceMeta>
  return new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]))
}

export async function saveProvincesApi(provinces: Map<number, ProvinceMeta>): Promise<void> {
  const obj: Record<string, ProvinceMeta> = {}
  for (const [id, p] of provinces) obj[id] = p
  await fetch(`${API}/provinces`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  })
}
