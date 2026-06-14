# Grand-Strategy Map Architecture

*A first-principles design for a hex-based grand-strategy game (EU4 / Vic3 / HOI4 /
CK3 lineage). Written as the system architect's reference. Companion to
[checkpoint.md](checkpoint.md), which tracks what is actually built.*

---

## 0. The core question: is "colour ownership onto hexes" flawed?

**Yes — but only as a *rendering* strategy. As a *data* strategy it is correct.**

The mistake is letting **one layer do two jobs**. A hex is a great *gameplay cell*
(discrete, addressable, cheap to simulate). It is a terrible *visual primitive*
for a country, because a country rendered as "all my hexes, filled" can only ever
be as smooth as the hex is small — and small hexes explode your simulation cost.
You are trying to buy visual fidelity with gameplay resolution. Those must be
**decoupled**.

The fix every shipping Paradox-style game uses:

> **Gameplay is discrete. Rendering is continuous. They are different layers that
> reference each other by ID — they are never the same buffer.**

So: keep hexes as the gameplay substrate. Do **not** derive the *look* of a
country by tinting hexes. Derive it from a smooth vector/raster layer that is
*driven by* hex ownership but *rendered* independently.

This repo now implements exactly that split (see §6/§7): a **Political (vector)**
style that fills real country polygons, sitting over a **Hex (gameplay)** layer
that owns the data and the clicks.

---

## 1. How professional strategy games separate visuals from gameplay

Two industry patterns; we use a hybrid.

### Pattern A — Province bitmap + shader borders (Clausewitz / Paradox)
- The map is a **provinces.bmp**: every pixel is coloured by a unique province
  ID. This raster is the *source of truth for shape*, hand-authored at high res.
- Gameplay data lives in tables keyed by province ID (`provinces.csv`, history
  files). The bitmap is *not* the gameplay grid; it is a **pixel→province lookup**.
- Borders are drawn by a **shader**: it samples neighbouring pixels, and where the
  province ID changes it draws a line. **Signed-distance-field (SDF)** / texture
  smoothing makes that line anti-aliased and soft even though the underlying data
  is per-pixel discrete. Coastlines come from a separate land/sea mask + normal
  maps for the water shader.
- **Takeaway:** the border you *see* is a post-process over a discrete ID field.
  The discreteness never reaches the player's eye.

### Pattern B — Vector polygons tinted by owner (Civ-style political view, web maps)
- Keep the real geographic polygons (coastlines, admin boundaries) as vectors.
- Fill each polygon by *who owns it*. Borders are the polygon edges — already
  smooth because the source data is smooth.
- **Takeaway:** if your regions are the real shapes, you get realism for free;
  the gameplay grid is an *overlay*, invisible unless toggled.

### Our hybrid (recommended for a hex game)
- **Static/owned-by-default territory** → render with **Pattern B**: fill the real
  GeoJSON country/province polygons. Perfect shapes, zero per-frame cost (cached).
- **Dynamic ownership changes** (conquest in-game, hand edits) → the changed area
  no longer matches a real polygon, so render **that delta** with **Pattern A's
  idea** applied to hexes: take the owned-hex set, extract its boundary, and
  **smooth it** (§6) before drawing/clipping. Internal political borders between
  provinces are likewise generated from the hex partition and smoothed.

The player always sees smooth fills + smooth borders; the hexes are a debug/edit
overlay.

---

## 2. The five layers

```
┌─────────────────────────────────────────────────────────────┐
│ 5. COUNTRY   owns provinces · diplomacy/economy/tech/military │  aggregate
│ 4. CITY      sits on 1 hex · belongs to a province           │  point
│ 3. PROVINCE  set of hexes · dev/GDP/pop/culture/modifiers    │  region
│ 2. HEX       gameplay cell · terrain/elev/pop/owner/resource  │  grid   ← data truth
│ 1. GEOGRAPHIC  coastlines · real borders · projection         │  vector ← visual truth
└─────────────────────────────────────────────────────────────┘
        rendering reads 1 (+derived from 2/3) ; simulation reads 2/3/4/5
```

### Layer 1 — Geographic (visual truth)
- Real coastlines + country outlines (Natural Earth here), in lon/lat, drawn via a
  map projection (equirectangular now; swappable). **Never** simulated; it only
  defines how the world *looks* and seeds default ownership/land-sea.
- *In repo:* `server/data/ne_50m_countries.json` → served per region by
  `GET /api/borders`; rendered as the **Political** style.

### Layer 2 — Hex (data truth)
- The smallest unit. **Immutable position** once generated: a hex's `q,r`/`hexId`
  never change. Everything mutable (owner, terrain, pop…) is a field or an overlay
  patch. Stable IDs are what let warfare/economy/AI reference cells forever.
- *In repo:* generated for the **whole planet** server-side (105,820 hexes),
  sliced per region to the client. `server/worldgen.mjs`, `world/types.ts`.

### Layer 3 — Province (administration)
- A province = a set of neighbouring hex IDs + admin/economy data. **Provinces are
  the unit most systems actually operate on** (dev, buildings, supply, autonomy).
  Province borders are *generated from* the hex membership (§6) and are editable by
  re-assigning hexes.

### Layer 4 — City (point feature)
- A city references exactly one `hexId` (so it inherits lon/lat) and one
  `provinceId`. Rendered as a sprite/icon *above* the map, never as a fill.

### Layer 5 — Country (aggregate)
- A country owns **provinces, not hexes**. Its national stats are roll-ups of its
  provinces. Its visual shape is the union of its provinces' shapes — smoothed,
  not hex-blocky.

**Ownership chain (strict):** `hex.provinceId → province.countryId`.
`hex.countryId` is a *denormalised cache* for fast rendering/queries; the
authoritative owner is the province. Recompute the cache whenever a hex changes
province or a province changes country.

---

## 3. Smooth borders from discrete cells — the method

Goal: given the hexes a country/province owns, produce a **smooth closed polygon**
that reads as a real border, not a hex blob.

**Algorithm (implemented in `map-editor/src/hex/contour.ts`):**

1. **Boundary extraction by edge parity.** Each hex has 6 edges. Collect every
   edge of every owned hex, keyed by its (rounded) endpoint pair. An edge shared
   by two owned hexes appears **twice → interior → discard**. An edge appearing
   **once → on the boundary**. (No neighbour bookkeeping needed; parity does it.)
2. **Stitch** the boundary edges end-to-end into **closed loops**. A territory can
   yield several: mainland + islands (separate loops) and lakes/enclaves (hole
   loops).
3. **Smooth** each loop with **Chaikin corner-cutting** (2 passes): each pass
   replaces every vertex with two points at ¼ and ¾ along its edges, rounding the
   hard 120° hex corners into a soft curve. (Catmull-Rom/B-spline are alternatives
   if you want interpolating curves.)
4. **(Production) Clip to the coastline.** Intersect the smoothed land border with
   the real Layer-1 coastline polygon so coasts stay geographically exact while
   *internal* borders follow ownership. Use a polygon-clipping lib (martinez /
   `polygon-clipping`) — do this only for changed regions, then cache.

*Verified:* single hex → one 6-edge loop; 7-hex flower → interior edges removed,
one 18-edge outer loop; two disjoint hexes → two loops.

**Why this is enough:** smoothing hides the grid at normal zoom; clipping to the
real coast restores geographic accuracy where it matters most (the silhouette).
Internal borders are allowed to be "game borders," which players accept.

**Three fidelity tiers** (pick per project budget):
| Tier | Border source | Look | Cost |
|---|---|---|---|
| Bronze | hex fills | blocky | trivial |
| **Silver (here)** | real polygons for default + smoothed hex contours for edits | realistic | low, cached |
| Gold | per-pixel province raster + SDF border shader (true Paradox) | AAA | shader work + tooling |

---

## 4. Recommended production data structures

TypeScript shapes (authoritative versions live in `map-editor/src/world/types.ts`).

```ts
// Stable handles
type HexId = number          // stable per world resolution
type ProvinceId = number
type CityId = number
type CountryId = string      // ISO-3, e.g. "PAK"

interface Hex {
  hexId: HexId
  q: number; r: number               // axial coords — the immutable identity
  lon: number; lat: number           // geographic centre
  terrain: TerrainType; elevation: number; climate: ClimateType
  isLand: boolean; isCoastal: boolean
  provinceId: ProvinceId | null      // ← authoritative membership
  countryId: CountryId | null        // ← denormalised cache of province→country
  resourceId: string | null; population: number; infrastructure: number
  // future, no migration needed:
  rivers?: number[]; occupiedBy?: CountryId | null
  ownershipHistory?: { countryId: CountryId; from: number }[]; moveCost?: number
}

interface Province {
  id: ProvinceId; name: string; countryId: CountryId | null
  capitalCityId: CityId | null; hexIds: HexId[]
  population: number; gdp: number; resources: string[]
  development: number; infrastructure: number
  culture: string; religion: string; stability: number
  modifiers: Record<string, number>
  // cached render geometry, recomputed on membership change:
  outline?: number[][][]             // smoothed loops (Layer-3 borders)
}

interface City {
  id: CityId; name: string; provinceId: ProvinceId; hexId: HexId
  population: number; economicOutput: number; infrastructure: number
  buildings: string[]; tradeValue: number; militaryFacilities: string[]; growthRate: number
}

interface Country {
  id: CountryId; name: string; color: string; government: string
  capitalCityId: CityId | null; provinceIds: ProvinceId[]
  population: number
  economy: { gdp: number; treasury: number }
  military: { manpower: number; units: number }
  diplomacy: Record<CountryId, number>; technology: Record<string, number>
  cultureGroups: string[]
}

interface World {
  regionId: string; hexSize: number; width: number; height: number
  originX: number; originY: number              // render offset for a region slice
  hexes: Hex[]; byId: Map<HexId, Hex>; index: Map<string, HexId> // "q,r" → id
  provinces: Map<ProvinceId, Province>
  cities: Map<CityId, City>
  countries: Map<CountryId, Country>
}
```

**Persistence (server):** the derived base grid is stored once
(`server/data/world.json`); edits are an overlay `{hexId: patch}`
(`server/data/edits.json`). Production: move to **Postgres** — `hex` table with a
`UNIQUE(q,r)` and indexes on `province_id`/`country_id`; `province`/`city`/
`country` tables; hot per-tick simulation state in memory (struct-of-arrays), not
the DB. (Full DDL in [checkpoint.md](checkpoint.md) §4.)

---

## 5. Editor workflow (data edits → smooth visuals, automatically)

The editor never asks you to draw smooth borders. You edit **data**; the renderer
regenerates the **look**.

```
click hex ──► select (O(1): pixel → axial → id)
   │
   ├─ assign Country      → patch hex.countryId (or via its province)
   ├─ assign Province     → add hexId to province.hexIds; recompute province.outline
   ├─ place City          → city.hexId = hex; city.provinceId = hex.provinceId
   ├─ set Terrain/Resource→ patch hex fields
   └─ set Ownership       → patch province.countryId; refresh hex.countryId cache
                          │
                          ▼
            invalidate cached outlines for affected province/country
                          │
                          ▼
   Political layer re-fills polygons + redraws smoothed borders (cached bitmap)
```

- **Paint tool** ("pencil") = drag to stamp the brush (country/terrain) across
  hexes; commit on mouse-up; outlines regenerate for touched territories only.
- **Province highlight** = stroke/fill that province's cached smoothed `outline`.
- Borders **stay smooth throughout** because you are editing the hex partition,
  and the visual is a *generated* product of that partition — never the hexes
  themselves.

*In repo today:* click-select + edit panel, drag-paint, Political vs Hex styles,
and an optional "smooth outlines from hexes" overlay that demonstrates §3 live.

---

## 6. Rendering system

- **Canvas 2D, layered, cached.** The static map (Political fills + coast/borders,
  or Hex fills) is rasterised **once** into an offscreen bitmap; every frame blits
  that bitmap with the view transform + draws only the dynamic overlay
  (hover/selection, smoothed outlines). Pan/zoom/hover are O(1).
  → `map-editor/src/components/HexCanvas.tsx`.
- **Hit-testing is math, not geometry:** screen → world → `pixelToAxial` (cube
  rounding) → id. No per-hex hit regions; works at 200k hexes.
- **Layer order:** ocean → land/political fills → province borders → country
  borders (thicker) → hex grid overlay (optional, faint) → rivers → cities/units →
  selection/hover.
- **Upgrade path to AAA:** move fills + SDF borders to **WebGL** (instanced hex
  quads or a province-ID texture + border shader) when Canvas 2D saturates.

---

## 7. Performance & scaling (50k–200k hexes → whole Earth)

| Concern | Strategy |
|---|---|
| Draw cost | Offscreen base bitmap + blit; only redraw on data/style change. Cull to viewport. |
| Click cost | Constant-time pixel→hex math. |
| Border cost | Generate smoothed outlines **once per ownership change**, cache on the province/country; never per frame. |
| Memory at world scale | Don't ship 200k hexes to the client — **serve region slices** (we send ~3k for South Asia). Hexes keep global ids; client subtracts a render origin. |
| Simulation hot loops | Struct-of-arrays / typed arrays per field; iterate provinces, not hexes, where possible. |
| Storage | Base grid derived & cached server-side; persist only the edit overlay + authored provinces/cities/countries. |
| Whole Earth | Already generated (105,820 hexes, 241 countries) and stored; surface any region by changing the `region` query — **no client redesign**. Next: spatial **tiling/chunking** for culling + DB paging; LOD (coarse hexes when zoomed out). |
| GPU headroom | WebGL instancing / ID-texture + SDF borders; web-worker the world-gen and contour passes. |

---

## 8. Why this won't need a redesign later

Every future system attaches to a layer that already exists, by **ID reference**:

| System | Attaches to | Uses |
|---|---|---|
| Warfare / fronts | hex + province | `neighbors()`, `moveCost`, `occupiedBy` |
| Supply lines | hex graph | hex adjacency + pathfinding |
| Roads / rail / trade | hex **edges** | adjacency edge layer |
| Population / migration | hex `population` | flows along neighbours |
| Economy | province → country | roll-ups |
| Diplomacy / AI | country | aggregates + `diplomacy` map |
| Colonisation / conquest | province `countryId`, hex `ownershipHistory` | retint + re-outline |
| Infrastructure | hex/province `infrastructure` | modifiers |

Because **position is immutable**, **ownership is data**, and **visuals are
generated**, adding any of these never forces a map rebuild — it adds fields,
tables, and render layers on top of the same hex/province/country spine.
```
