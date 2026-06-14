/**
 * World data model — the four-level hierarchy that every future system builds on.
 *
 *   Level 1  Hex      smallest unit; the only thing that holds geography
 *   Level 2  Province collection of hexes; the unit of administration/economy
 *   Level 3  City     point feature that belongs to a province
 *   Level 4  Country  collection of provinces (NEVER owns hexes directly)
 *
 * Ownership chain is strictly:  hex -> province -> country.
 * A hex stores `countryId` only as a denormalised cache for fast rendering;
 * the authoritative owner is province.countryId. Keep them in sync on edit.
 *
 * Most numeric/array fields are optional or default to 0/empty for now. They
 * exist so later systems (economy, warfare, migration…) have a home without a
 * schema migration. Today the builder only fills the geographic basics.
 */

import { TerrainType } from '../types'

export type { TerrainType }

export type ClimateType =
  | 'tropical'
  | 'arid'
  | 'temperate'
  | 'continental'
  | 'highland'
  | 'oceanic'

export type CountryId = string // ISO-3166 alpha-3, e.g. "PAK"
export type ProvinceId = number
export type CityId = number
export type HexId = number

// ── Level 1: Hex ────────────────────────────────────────────────────────────
export interface Hex {
  hexId: HexId
  /** Axial coordinates — the real spatial identity (id is just a handle). */
  q: number
  r: number
  /** Geographic centre of the hex. */
  lon: number
  lat: number

  terrain: TerrainType
  elevation: number // metres above sea level
  climate: ClimateType

  isLand: boolean
  isCoastal: boolean // land hex touching at least one sea hex

  // assignment / ownership (province is authoritative; country is a cache)
  provinceId: ProvinceId | null
  countryId: CountryId | null

  // economy / demography placeholders for later systems
  resourceId: string | null
  population: number
  infrastructure: number // 0..n development level

  // future systems (declared now, populated later — no migration needed)
  rivers?: number[] // edge indices (0..5) that carry a river
  occupiedBy?: CountryId | null // military occupation distinct from ownership
  ownershipHistory?: { countryId: CountryId; from: number }[]
  moveCost?: number // pathfinding weight derived from terrain
}

// ── Level 2: Province ───────────────────────────────────────────────────────
export interface Province {
  id: ProvinceId
  name: string
  countryId: CountryId | null
  capitalCityId: CityId | null
  hexIds: HexId[]

  population: number
  gdp: number
  resources: string[]
  development: number
  infrastructure: number
  culture: string
  religion: string
  stability: number
  modifiers: Record<string, number>
}

// ── Level 3: City ───────────────────────────────────────────────────────────
export interface City {
  id: CityId
  name: string
  provinceId: ProvinceId
  hexId: HexId // the hex it sits on (gives it lon/lat for free)
  population: number
  economicOutput: number
  infrastructure: number
  buildings: string[]
  tradeValue: number
  militaryFacilities: string[]
  growthRate: number
}

// ── Level 4: Country ────────────────────────────────────────────────────────
export interface Country {
  id: CountryId
  name: string
  color: string
  government: string
  capitalCityId: CityId | null
  provinceIds: ProvinceId[]

  population: number
  economy: { gdp: number; treasury: number }
  military: { manpower: number; units: number }
  diplomacy: Record<CountryId, number> // relation scores
  technology: Record<string, number>
  cultureGroups: string[]
}

// ── World container ─────────────────────────────────────────────────────────
// A World may hold the whole planet or just a region slice. Hexes keep their
// GLOBAL axial coords/ids, so lookups go through `byId`/`index` (never array
// position) and rendering subtracts `originX/originY` to place the slice at the
// canvas origin.
export interface World {
  regionId: string
  hexSize: number // circumradius in world pixels (encodes resolution)
  width: number // render extents (the visible region's size in world px)
  height: number
  originX: number // world-pixel offset of the slice's top-left (for rendering)
  originY: number
  hexes: Hex[]
  byId: Map<HexId, Hex> // hexId -> hex (authoritative lookup)
  index: Map<string, HexId> // axialKey -> hexId, for neighbour lookups + hit-test
  provinces: Map<ProvinceId, Province>
  cities: Map<CityId, City>
  countries: Map<CountryId, Country>
}
