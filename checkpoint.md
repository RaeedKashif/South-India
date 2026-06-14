# World Game — Map Foundation Checkpoint

> Grand-strategy hex map (EU4 / Victoria 3 / HOI4 inspired).
> **Goal of this phase:** build the *map foundation* correctly so provinces,
> cities, economy, warfare, AI, etc. can be layered on later **without
> redesigning the map**. Gameplay is intentionally out of scope right now.

Last updated: **2026-06-14**

> **Design references:** [ARCHITECTURE.md](ARCHITECTURE.md) — layered map design
> (visual vs gameplay layer, smooth-borders-from-hexes, scaling). ·
> [EDITOR.md](EDITOR.md) — the province/map editor: tools, layers, strategic
> projection/country-warp, 1750 South Asia province design + counts.

---

## 0. TL;DR — where we are

✅ **Done this checkpoint: a clickable hex world map of South Asia + Afghanistan.**

- A pointy-top hex grid is laid over a real geographic projection of the region.
- Every hex is **individually clickable** (math-based hit test, O(1)).
- Each hex is **auto-classified** as land/sea and **auto-assigned a country**
  by testing its centre against **real Natural Earth country borders**.
- Clicking a hex (Inspect tool) opens an **edit panel** (country, terrain,
  climate, elevation, resource, population, infrastructure).
- **Pencil / Paint tool**: drag to stamp a country or terrain onto hexes — this
  is how you hand-draw / redraw boundaries.
- Colour-by views: **country / terrain / elevation / population**.
- **Smooth at scale**: the static grid is cached to an offscreen bitmap and
  blitted per frame, so pan/zoom/hover stay fast.
- **Whole world lives in the backend.** A Node/Express server generates the
  entire planet's hex grid (**105,820 hexes**, 31,525 land, 241 countries),
  persists it to disk, and serves the **South Asia slice** (~3,016 hexes) to the
  browser. The rest of the world already exists server-side, ready to surface.
- Edits **autosave to the backend** and can be **exported/imported as JSON**.
- **Visual layer ≠ gameplay layer.** A **Political** map style fills the *real*
  country polygons (smooth, accurate shapes) served by `GET /api/borders`, while
  hexes remain the gameplay/click layer underneath. A **Hex** style shows the raw
  gameplay grid. Plus a `contour.ts` that turns owned hexes into smooth polygons
  (the fix for "blocky countries"). See [ARCHITECTURE.md](ARCHITECTURE.md).
- **Provinces from hexes.** Create provinces, **paint** hexes into them, and their
  **smooth border is generated** from the hex set (selection highlighted).
  Rename / delete / merge / assign-to-country; persisted via `GET/PUT
  /api/provinces`. This is the keystone of the editor in [EDITOR.md](EDITOR.md).

Verified: `tsc && vite build` passes (40 modules); dev server serves the app +
borders; classification produces geographically sane counts (see §7).

The 4-level architecture (Hex → Province → City → Country) is fully specced in
types and documented below. Only **Level 1 (Hex)** is *implemented/populated*
today; Levels 2–4 are typed and ready to be authored next.

---

## 1. Tech stack & how to run

| Concern | Choice | Why |
|---|---|---|
| Frontend | **Vite + React 18 + TypeScript** | already in repo; fast HMR |
| Rendering | **HTML5 Canvas 2D** + offscreen cache | draws only visible hexes → scales to 200k |
| Hex math | hand-rolled **axial/cube** (Red Blob Games) | transparent, dependency-light, the industry-standard model |
| Geography | **equirectangular projection** + **GeoJSON** borders | invertible, trivial, swappable later |
| **Backend** | **Node + Express** (`server/`) | owns the authoritative world; generates + persists + serves slices |
| Persistence | JSON files on the server (`server/data/`) | base grid is derived; edits stored as an overlay. (SQLite is the production path — see §4) |

**Run both processes:**
```bash
# 1) Backend — generates the world on first run (~5s), then caches it
cd server
npm install
npm start            # http://localhost:5179  (API)

# 2) Frontend (separate terminal)
cd map-editor
npm install
npm run dev          # http://localhost:5173  (/api is proxied to :5179)
```
If the frontend shows "Backend offline", start the server first and reload.

The province/SVG editor that previously lived here is preserved unused at
`map-editor/src/ProvinceEditor.tsx` (it was a different, polygon-based paradigm;
the hex grid replaces it as the foundation).

---

## 2. File map

```
World_Game/
├─ checkpoint.md                     ← this file
├─ server/                           BACKEND (authoritative world)
│  ├─ index.mjs                      Express API: /api/meta, /api/hexes, /api/edits
│  ├─ worldgen.mjs                   whole-world grid generation + classification
│  ├─ regions.mjs                    WORLD bbox/resolution + region slices + palette
│  └─ data/                          (gitignored) ne_50m_countries.json, world.json, edits.json
└─ map-editor/                       FRONTEND
   ├─ public/
   │  └─ south-asia.geojson          borders for the SA view (≈52 KB)
   ├─ vite.config.ts                 dev proxy /api → :5179
   └─ src/
      ├─ hex/coords.ts               axial↔pixel, cube rounding, neighbours, distance
      ├─ geo/projection.ts           lon/lat↔pixel + point-in-polygon classify
      ├─ world/
      │  ├─ types.ts                 Hex / Province / City / Country / World models
      │  ├─ region.ts                SA config (bbox, focus countries, palette)
      │  ├─ api.ts                    backend client (meta / hexes / edits)
      │  ├─ fromApi.ts               assemble a renderable World from a region slice
      │  ├─ buildWorld.ts            (local generator + hit-test helpers)
      │  └─ store.ts                 edit overlay, export/import snapshot
      ├─ components/
      │  ├─ HexCanvas.tsx            canvas renderer + pan/zoom + click/hover + paint
      │  └─ HexInfoPanel.tsx         per-hex edit panel
      ├─ App.tsx                     composition (loads SA slice, sidebar + canvas)
      ├─ types.ts                    terrain palette
      └─ ProvinceEditor.tsx          archived legacy SVG editor (unused)
```

### Data flow

```
ne_50m_countries.json ─generate→ server/data/world.json (105,820 hexes, whole planet)
                                         │  GET /api/hexes?region=south_asia
                                         ▼
                        browser: South Asia slice (~3,016 hexes, global coords)
                                         │  edits ──PUT /api/edits──▶ server/data/edits.json
```
Hexes keep **global** axial coords/ids; the frontend looks them up by id and
subtracts a render origin to place the slice at the canvas corner. Loading a
different region later = change one query param; no client changes.

---

## 3. Data structures (Deliverable 1)

The ownership chain is strict: **hex → province → country**.
Countries **never** own hexes directly. `hex.countryId` exists only as a
denormalised cache for fast rendering; the authoritative owner is
`province.countryId`.

### Hex (Level 1) — implemented
```jsonc
{
  "hexId": 1032,
  "q": 14, "r": -3,            // axial coords = the real spatial identity
  "lon": 74.35, "lat": 31.52,  // geographic centre
  "terrain": "plain",
  "elevation": 217,
  "climate": "temperate",
  "isLand": true,
  "isCoastal": false,
  "provinceId": null,          // set once provinces are authored
  "countryId": "PAK",          // cache of province→country
  "resourceId": "wheat",
  "population": 0,
  "infrastructure": 0,
  // declared for future systems, unpopulated today:
  "rivers": [], "occupiedBy": null, "ownershipHistory": [], "moveCost": 1
}
```

### Province (Level 2) — typed, not yet authored
```jsonc
{
  "id": 55, "name": "Punjab", "countryId": "PAK",
  "capitalCityId": 9, "hexIds": [1032, 1033, 1090],
  "population": 110000000, "gdp": 0, "resources": ["wheat", "cotton"],
  "development": 8, "infrastructure": 6,
  "culture": "punjabi", "religion": "islam",
  "stability": 50, "modifiers": {}
}
```

### City (Level 3) — typed
```jsonc
{
  "id": 9, "name": "Lahore", "provinceId": 55, "hexId": 1032,
  "population": 13000000, "economicOutput": 0, "infrastructure": 7,
  "buildings": [], "tradeValue": 0, "militaryFacilities": [], "growthRate": 1.8
}
```

### Country (Level 4) — typed
```jsonc
{
  "id": "PAK", "name": "Pakistan", "color": "#43a047",
  "government": "republic", "capitalCityId": 12, "provinceIds": [55, 56],
  "population": 240000000,
  "economy": { "gdp": 0, "treasury": 0 },
  "military": { "manpower": 0, "units": 0 },
  "diplomacy": { "IND": -40 }, "technology": {}, "cultureGroups": ["indo_aryan"]
}
```

---

## 4. Database design (Deliverable 2)

The JSON **export already maps 1:1 to tables/collections** below. Use Postgres
for relational integrity (recommended) or a document DB — both shapes given.

### Relational (Postgres) — recommended
```sql
country(
  id          TEXT PRIMARY KEY,         -- ISO-3 e.g. 'PAK'
  name        TEXT, color TEXT, government TEXT,
  capital_city_id BIGINT,
  data        JSONB                     -- economy/military/diplomacy/tech blobs
);

province(
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT,
  country_id  TEXT REFERENCES country(id),
  capital_city_id BIGINT,
  population  BIGINT, gdp NUMERIC, development INT, infrastructure INT,
  culture     TEXT, religion TEXT, stability INT,
  data        JSONB
);
CREATE INDEX ON province(country_id);

city(
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT,
  province_id BIGINT REFERENCES province(id),
  hex_id      BIGINT REFERENCES hex(hex_id),
  population  BIGINT, data JSONB
);
CREATE INDEX ON city(province_id);

hex(
  hex_id      BIGINT PRIMARY KEY,       -- stable per resolution
  q INT, r INT,                         -- UNIQUE(q, r)
  lon DOUBLE PRECISION, lat DOUBLE PRECISION,
  terrain TEXT, elevation INT, climate TEXT,
  is_land BOOL, is_coastal BOOL,
  province_id BIGINT REFERENCES province(id),  -- nullable
  country_id  TEXT  REFERENCES country(id),     -- denormalised cache
  resource_id TEXT, population BIGINT, infrastructure INT,
  data        JSONB                     -- rivers/occupation/history/etc.
);
CREATE UNIQUE INDEX ON hex(q, r);
CREATE INDEX ON hex(province_id);
CREATE INDEX ON hex(country_id);
```

**Scaling note:** at 200k hexes the `hex` table is the only "big" one and is
trivial for Postgres. Hot simulation data (population, supply, fronts) that
changes every tick should live in **typed arrays / columnar in-memory state**,
not row-by-row DB writes — persist snapshots periodically.

### Document (Mongo/Firestore) alternative
`countries`, `provinces`, `cities` as documents; `hexes` as one doc per hex
**or** chunked (e.g. one doc per 32×32 hex tile) to avoid 200k tiny docs.

---

## 5. Map editor architecture (Deliverable 3)

**How clicking works** — Canvas has no per-hex DOM nodes. On click we convert
screen → world pixels via the inverse view transform, then `pixelToAxial()`
(cube rounding) gives the exact hex `(q,r)`; `index.get("q,r")` returns the
`hexId` in **O(1)**. This is what makes 200k hexes clickable cheaply.
→ `HexCanvas.tsx` `toWorld()` + `hexAt()` in `buildWorld.ts`.

**How assigning a country works** — clicking selects the hex; the panel writes a
`HexPatch` (`{countryId: 'PAK'}`) into the **edit overlay** (a
`Map<hexId, patch>`). Render merges base hex + patch. Today this edits the hex's
country cache directly; once provinces exist, country is assigned via the hex's
province (province → country) and the hex cache is recomputed.

**How assigning provinces/cities will work (next milestone)** — paint/select
hexes → "Create province from selection" builds a `Province` with those
`hexIds`; a city is placed on a single hex (`city.hexId`) and tied to its
province. The relational links already exist in the types.

**How province highlighting works** — provinces are sets of `hexIds`; selecting
a province highlights all member hexes by outlining/tinting them in the canvas
draw loop (same outline routine already used for hover/selection). Borders
between provinces = hex edges where the two hexes' `provinceId` differ.

**How saving/loading works** — the authoritative base grid is generated **once
on the server** and persisted to `server/data/world.json`. The browser fetches a
region slice; edits are an **overlay** (`{hexId: patch}`) autosaved to the
backend via `PUT /api/edits` → `server/data/edits.json`. You can also export the
current slice (base + edits merged) as a DB-shaped JSON snapshot. → `world/api.ts`,
`server/index.mjs`.

---

## 6. Performance considerations (Deliverable 4)

Target: **50k–200k hexes, thousands of provinces, hundreds of countries.**

- **Offscreen base bitmap (implemented).** The whole grid is rasterised once to
  an offscreen canvas and blitted each frame; pan/zoom/hover only blit + draw
  1–2 outlines. Interaction cost is O(1), not O(hex count). Rendering is driven
  by `requestAnimationFrame`, decoupled from React re-renders.
- **Incremental paint.** Painting stamps single hexes onto the cached bitmap for
  instant feedback; the batch commits to the overlay on pointer-up.
- **No DOM per hex.** Canvas + math hit-testing — the key decision enabling scale
  (200k interactive SVG/DOM nodes would not be viable).
- **Derived base grid.** Geometry is computed, not stored; saves are tiny diffs.
- **Precomputed corner offsets**; **bbox prefilter** before point-in-polygon.
- **Headroom (planned):**
  - spatial **tiling / chunking** of hexes for culling + DB paging at world scale,
  - re-rasterise the base at the current zoom (debounced) for crisp deep zoom-in,
  - typed-array ("struct of arrays") hex storage for simulation hot loops,
  - WebGL/instanced rendering if Canvas 2D becomes the bottleneck at full world.

---

## 7. Verification

- `npm run build` → ✅ 40 modules, no type errors.
- Dev server serves app + `south-asia.geojson` (HTTP 200).
- Classification sanity (medium resolution, ~48 km hexes): **3,156 hexes total,
  939 land, 2,217 sea.** Per country:
  IND 576 · PAK 167 · AFG 131 · NPL 27 · BGD 20 · LKA 11 · BTN 7 · MDV 1*.
  Ordering matches real land areas. (*MDV forced via the representation pass.)
- ⏳ **Not yet visually verified by a human** — recommend opening `npm run dev`
  to confirm look & feel and clicking.

---

## 8. Known limitations / decisions to revisit

- **Micro-states vs resolution.** Tiny territories (Maldives; Bhutan at coarse)
  fall between hex centres. A *representation pass* forces ≥1 hex per country so
  all 8 always appear, but small nations are under-represented at coarse zoom.
- **Elevation is flat (0).** No DEM yet, so the elevation view is uniform and
  terrain defaults to plain/water. Plug in a heightmap later to derive
  elevation, mountains, and movement cost.
- **`hexId` is stable per resolution only.** Changing resolution rebuilds the
  grid and remaps ids; edits are saved per-resolution. Pick one resolution
  before heavy authoring, or migrate edits by lon/lat if resolution changes.
- **Equirectangular distortion** grows toward the poles — negligible for South
  Asia, revisit only for a full globe.
- **Borders are Natural Earth 50m** (simplified) — good for a game, not survey-grade;
  disputed boundaries follow that dataset.

---

## 9. Roadmap — next checkpoints

How each future system slots into this foundation **without a map redesign**
(Deliverable 5):

| System | Slots in via | Map change needed |
|---|---|---|
| **Provinces** | group `hexIds`; `Province` already typed | none — author on top |
| **Cities** | `city.hexId` + `provinceId` already typed | none |
| **Roads / Railways / Trade** | edges between adjacent hexes (`neighbors()`) | none — edge layer |
| **Supply lines / Warfare** | pathfinding on `moveCost` + `hexDistance()` | none — graph exists |
| **Population / Migration** | per-hex `population`, flows along neighbours | none |
| **Economy** | aggregate hex→province→country | none |
| **Diplomacy / AI** | operate on country/province aggregates | none |
| **Colonisation / ownership change** | `ownershipHistory`, `occupiedBy` already on hex | none |
| **Rest of world** | already generated & stored server-side; surface by changing the `region` query (or add a `RegionDef`) | none |

**Immediate next steps (suggested order):**
1. Province authoring tools (select hexes → create/merge/rename provinces; highlight).
2. City placement (drop a city on a hex; show on top of the map).
3. Country aggregates panel (population/area rolled up from provinces).
4. Plug in an elevation heightmap → real terrain + movement cost.
5. Spatial chunking + offscreen base layer before expanding past South Asia.
```
