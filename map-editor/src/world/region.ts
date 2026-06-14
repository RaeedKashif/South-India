/**
 * Region definitions. Only South Asia is "active" today, but the structure is a
 * list so the rest of the world can be added as further regions later without
 * touching the engine. A region is just a bbox + the countries we expect inside
 * it + render tuning. The actual land shapes come from the bundled GeoJSON.
 */

import { BBox } from '../geo/projection'
import { CountryId } from './types'

export interface CountryDef {
  id: CountryId
  name: string
  color: string
}

export interface RegionDef {
  id: string
  name: string
  active: boolean
  /** Padded a little beyond the true land bbox so coastlines aren't clipped. */
  bbox: BBox
  pxPerDeg: number
  geojsonUrl: string
  countries: CountryDef[]
  /** Hex circumradius (world px) per named resolution. Smaller = more hexes. */
  resolutions: Record<'coarse' | 'medium' | 'fine', number>
  defaultResolution: 'coarse' | 'medium' | 'fine'
}

// Categorical palette — chosen to be easy to tell apart, not flag-accurate.
export const SOUTH_ASIA: RegionDef = {
  id: 'south_asia',
  name: 'South Asia',
  active: true,
  bbox: { lonMin: 59.5, latMin: 2.0, lonMax: 98.5, latMax: 39.5 },
  pxPerDeg: 60,
  geojsonUrl: '/south-asia.geojson',
  countries: [
    { id: 'PAK', name: 'Pakistan', color: '#7ba05b' },
    { id: 'IND', name: 'India', color: '#d9924a' },
    { id: 'BGD', name: 'Bangladesh', color: '#5fa08e' },
    { id: 'NPL', name: 'Nepal', color: '#c2685f' },
    { id: 'BTN', name: 'Bhutan', color: '#d4b35e' },
    { id: 'LKA', name: 'Sri Lanka', color: '#9a6fa0' },
    { id: 'AFG', name: 'Afghanistan', color: '#b39b78' },
    { id: 'MDV', name: 'Maldives', color: '#5b9bd5' },
  ],
  resolutions: { coarse: 40, medium: 26, fine: 18 },
  defaultResolution: 'medium',
}

export const REGIONS: RegionDef[] = [SOUTH_ASIA]

export const countryColor = (region: RegionDef, id: CountryId | null): string | null =>
  id ? region.countries.find((c) => c.id === id)?.color ?? null : null

export const countryName = (region: RegionDef, id: CountryId | null): string =>
  id ? region.countries.find((c) => c.id === id)?.name ?? id : '—'
