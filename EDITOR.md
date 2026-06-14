# Map & Province Editor — Architecture

*The in-house map editor design for a hex-based grand-strategy game with a
**strategic (non-geographic) projection** of South Asia. Companion to
[ARCHITECTURE.md](ARCHITECTURE.md) (the map/render layering) and
[checkpoint.md](checkpoint.md) (build status).*

---

## 0. The one decision everything hangs on: authority per concern

You asked for two things that, taken naively, contradict each other:

- **A free vector editor** — drag border vertices, free-draw boundaries, warp
  whole countries.
- **Hex-generated provinces** — provinces are groups of hexes, ownership lives on
  hexes, borders are generated from hex membership.

If hexes generate the border, you can't also hand-drag that border — the next
regeneration throws your edit away. A studio resolves this by giving **each
concern exactly one source of truth**, and layering the rest as derived or
cosmetic:

| Concern | Single authority | Everything else is… |
|---|---|---|
| Where a hex sits on screen | **Projection / warp field** (§1) | rendering follows it |
| What a hex *is* (gameplay) | **the hex record** (terrain, owner, pop) | cached/derived |
| Which province a hex is in | **`hex.provinceId`** | province shape is *generated* |
| A province's smooth border | **generated** from its hexes (§7) | vector tools = cosmetic refine |
| A country's territory | **its provinces' hexes** | country shape = union, smoothed |
| A country's *placement/size* | **the warp field** (§1), not its polygons | provinces/hexes follow |

So there are **two editors in one app**:

1. **Macro — Strategic Projection editor.** Move/scale/rotate/warp whole
   countries by editing a *warp field* that maps real lon/lat → game-world
   position. "Expand Pakistan 200%, compress China 50%, shift Iran west" are
   edits to this field. Provinces and hexes ride along automatically. **No
   polygon is touched.**
2. **Micro — Province editor.** Paint hexes into provinces; the smooth border is
   generated and cached. Split/merge/delete/rename operate on hex membership.
   "Vector" tools (smooth, simplify, vertex nudge) refine the *generated*
   presentation polygon and are stored as a per-province cosmetic override —
   never as gameplay truth.

This keeps the map editable like a vector tool **and** simulable like a hex grid,
forever, without the two fighting.

---

## 1. Strategic Projection & Country-Warp system (the headline feature)

Your map is deliberately *not* geographic. Treat that as a first-class subsystem:
a **warp field** `W : (lon,lat) → (x,y)` composed of named, ordered transforms.

```ts
type WarpOp =
  | { kind: 'scale';     target: RegionRef; sx: number; sy: number; pivot: LonLat }
  | { kind: 'translate'; target: RegionRef; dx: number; dy: number }   // in game-units
  | { kind: 'rotate';    target: RegionRef; deg: number; pivot: LonLat }
  | { kind: 'hide';      target: RegionRef }                            // drop from world
  | { kind: 'bend';      target: RegionRef; falloff: number; vector: XY } // soft push

type RegionRef =
  | { country: CountryId }                 // "PAK"
  | { bbox: BBox }                         // a rectangle
  | { mask: 'lasso'; polygon: LonLat[] }   // arbitrary area

interface WarpField { ops: WarpOp[]; blend: 'sequential' }  // applied in order
```

**Falloff is the trick that keeps it from looking torn.** A naive per-country
scale leaves seams where Pakistan (200%) meets India (100%). So each op is a
**smooth deformation with a falloff radius**: full strength inside the target,
decaying to zero outside, so neighbours are *nudged* rather than overlapped. This
is the same idea as a 2D **lattice/MLS warp** (Moving Least Squares) used in
image-warping tools — control points = country centroids, weights = falloff.

**Where the warp is applied — pick by need:**

- **Bake-time (recommended for a fixed strategic map):** run `W` once during
  world generation so hexes are *generated in warped space*. Hexes stay perfectly
  regular (you generate the lattice after warping the coastline), borders are
  clean, zero runtime cost. Re-baking is a tool action, not a per-frame cost.
- **Render-time (for live editing/preview):** apply `W` in the vertex/transform
  step only. Instant feedback while dragging a country; gameplay coords stay
  real until you "Bake".

> Editor flow: warp live at render-time for instant feedback → hit **Bake
> Projection** → regenerate the hex world in warped space → from then on it's a
> normal (if oddly-shaped) world. **Examples** ("expand Pakistan 200%", "hide
> Russia", "shift Iran west") are literally rows in `WarpField.ops`, saved with
> the project and replayable/tweakable.

This is why country transforms don't require editing thousands of polygons: you
edit ~dozens of warp ops; the pipeline does the rest.

---

## 2. Layer system

Eight independently visible/editable layers, drawn bottom→top. Each is a render
pass + an edit mode; toggles live in a **Layers panel**.

| # | Layer | Source of truth | Edited via |
|---|---|---|---|
| 1 | World coastline | geographic vector (Natural Earth) + warp field | Projection editor |
| 2 | Country outlines | union of country's provinces (smoothed) | derived; recolor/relabel |
| 3 | Province boundaries | **generated from `hex.provinceId`** | Province editor (hex paint) |
| 4 | Terrain | `hex.terrain/elevation/climate` | Terrain brush |
| 5 | Cities | `City` records (1 hex each) | City placement tool |
| 6 | Resources | `hex.resourceId` | Resource brush |
| 7 | Roads / infrastructure | edges between adjacent hexes | Edge/route tool |
| 8 | Military / gameplay overlays | runtime state (fronts, supply, zones) | read-mostly overlays |

Each layer: `{ visible, locked, opacity, editable }`. Only one layer is the
**active edit layer** at a time (prevents cross-layer mis-clicks). Hit-testing is
always against hexes (§5) regardless of which visual layer is on top.

---

## 3. Editor architecture

```
                       ┌───────────────────────────────┐
   project file  ◄────►│  EditorStore (undoable state)  │
   (server API)        │  warpField · hexes · provinces │
                       │  · cities · countries · layers │
                       └───────────────┬───────────────┘
                          selection / tool dispatch
        ┌───────────────────────┼───────────────────────────┐
   ToolController            LayerManager                 Renderer
   (active tool + brush)     (visibility/lock/active)     (offscreen-cached
   click→action                                            canvas; §6 ARCH.md)
```

- **Command pattern + undo stack.** Every edit (paint stroke, create/merge/split
  province, warp op, vertex nudge) is a reversible `Command` pushed to an undo
  ring. Strokes coalesce (one drag = one command). This is non-negotiable for an
  editor and cheap to add now because edits are already overlay patches.
- **Selection model.** Selection is *typed*: a hex, a province, a country, a
  city, or a multi-selection. The Properties panel and the available transform
  handles switch on selection type.
- **Validation pass** (Province Validation Tool) runs on demand / pre-save:
  flags orphan hexes (land hex with no province), non-contiguous provinces,
  provinces with no country, tiny (<N hex) or huge (>M hex) provinces, sea hexes
  assigned to land provinces, enclaves. Reports clickable warnings.
- **Persistence.** Authoritative base world generated + stored server-side; edits
  (`hex` overlay), `provinces`, `cities`, `countries`, and `warpField` saved as
  separate documents (already: `GET/PUT /api/edits`, `/api/provinces`).

---

## 4. UI layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Menu  | Mode: [Projection] [Province] [Terrain] [Cities] …  | Undo Redo Save │  top bar
├──────────┬───────────────────────────────────────────────────┬───────────┤
│ TOOLBOX  │                                                     │ PROPERTIES│
│ (active  │                                                     │ (selection│
│  tool's  │                  MAP CANVAS                         │  details +│
│  icons)  │   (offscreen-cached hex/political render,           │  transform│
│          │    pan/zoom, smooth borders, selection handles)     │  handles) │
│ Brush ▢  │                                                     │           │
│ Paint ▱  │                                                     │ Province: │
│ Split ✂  │                                                     │  name,    │
│ Merge ⤵  │                                                     │  country, │
│ Warp ⌗   │                                                     │  dev/pop… │
│ …        │                                                     │           │
├──────────┴───────────────────────────────────────────────────┴───────────┤
│ LAYERS:  ☑1 Coast ☑2 Country ☑3 Province ☐4 Terrain ☐5 Cities …  | Zoom 71%│  bottom bar
└──────────────────────────────────────────────────────────────────────────┘
```

- **Left toolbox** = tools for the active mode. **Right properties** = selection
  inspector + transform handles. **Bottom** = layers + zoom + hover readout.
- Selection draws on-canvas **handles**: a bounding box with scale corners,
  rotate grip, and (in vertex mode) draggable border points.

*Implemented today:* a single sidebar with Tool (Inspect/Paint), paint targets
(Country/Province/Terrain), Map style, Layers, Countries, Provinces registry, and
a per-hex inspector. It's the seed of the panel layout above.

---

## 5. Hex integration — how pros separate visual borders from gameplay cells

**Rule:** *Gameplay is discrete; rendering is continuous; they reference each
other by ID and are never the same buffer.* (Full treatment in
[ARCHITECTURE.md](ARCHITECTURE.md) §1.)

- **Ownership & simulation** read **hexes** (and province/country aggregates).
- **What the player sees** is a **generated, smoothed polygon** — never "hexes,
  tinted." Paradox does this with a province-ID raster + a border **shader**
  (SDF) that draws a smooth line wherever the ID changes; we do it with vector
  fills for default territory + **contour-from-hexes smoothing** (§7) for
  authored/dynamic territory.
- A province = a *set of hex IDs*. Its border = the **outline of that set**,
  smoothed. Move/zoom never reveals the grid unless you toggle the gameplay
  overlay on.

So: **provinces are visual polygons, hexes are gameplay cells, provinces contain
hexes, ownership is on hexes, borders stay smooth.** Exactly your requirement —
and it's what's running now (paint hexes → province border generated).

---

## 6. Editor tools (what each one actually edits)

Because authority is per-concern (§0), every tool is "edit data X → regenerate
visual Y":

| Tool | Edits | Result |
|---|---|---|
| **Province Brush** | `hex.provinceId = active` for hexes under brush | province grows; border regenerated |
| **Border Paint** | same, with a 1-hex feathered edge brush | fine boundary control along a seam |
| **Border Smooth** | province's cosmetic `smoothing` level (Chaikin passes) | softer rendered border, gameplay unchanged |
| **Border Simplify** | cosmetic `simplify` tolerance (Douglas–Peucker on the loop) | fewer vertices, cleaner at low zoom |
| **Province Split** | lasso/line partitions a province's hexes into two sets → new province id for one set | two provinces from one |
| **Province Merge** | reassign hexes of B → A, delete B | one province |
| **Country Resize** | a `scale` **warp op** on the country | whole country grows/shrinks; hexes follow on bake |
| **Country Warp** | a `bend`/MLS **warp op** with falloff | reshape/push/pull without seams |
| **Strategic Projection** | edits the ordered `WarpField` (move/rotate/hide/scale) | the non-geographic map itself |
| **Hex Assignment** | direct `hex.provinceId` / `hex.countryId` poke (single hex) | precise fixes |
| **Province Validation** | nothing — read-only analysis | list of issues to fix |
| **City tool** | `City{hexId, provinceId,…}` | city sprite on a hex |
| **Vertex edit** | per-province cosmetic vertex overrides on the *generated* loop | hand-tuned coastline look |

**Province transformation handles** (move/rotate/scale/stretch/expand/shrink)
in a hex world resolve to *membership operations*: the handle transforms the
province's polygon as a preview, then **re-snaps membership to the hexes under the
transformed shape** on commit (expand = add the ring of neighbour hexes; shrink =
drop the boundary ring; move = reassign to the hex set under the moved polygon).
Free-floating "move a province 50px" only exists in the **render/warp** layer, not
in gameplay.

---

## 7. Border generation algorithms

1. **Outline from hexes** (gameplay → vector): collect each owned hex's 6 edges;
   an edge used by two owned hexes is interior (drop), used once is boundary.
   Stitch boundary edges into closed loops (mainland + islands + holes).
   *Implemented:* `map-editor/src/hex/contour.ts`; verified (single hex → 6-edge
   loop, 7-hex flower → one 18-edge loop, disjoint → 2 loops).
2. **Smooth** each loop — **Chaikin** corner-cutting (2 passes default), or
   Catmull-Rom for interpolating curves. *Implemented.*
3. **Simplify** (optional) — **Douglas–Peucker** to cap vertex count for far
   zoom / export.
4. **Clip to coastline** (production) — intersect the smoothed land border with
   the real Layer-1 coast polygon (martinez / `polygon-clipping`) so the
   *silhouette* stays geographically believable while *internal* borders follow
   ownership. Run only on changed territory; cache on the province.
5. **Shared-edge dedup between provinces** — when drawing all provinces, draw each
   internal border once (it's shared) to avoid double-thick lines; or render via a
   province-ID buffer + SDF border pass at the high-fidelity tier.

Caching: store `province.outline` (smoothed loops); invalidate only when the
province's hex set changes. Borders are never recomputed per frame.

---

## 8. Data structures & storage formats

(Authoritative TS in `map-editor/src/world/types.ts`; province slice uses the
light `ProvinceMeta` below + `hex.provinceId` for membership.)

**Hex** — see [ARCHITECTURE.md](ARCHITECTURE.md) §4 (immutable `q,r`/id; mutable
owner/terrain/pop; `provinceId` is the authority for membership, `countryId` a
cache).

**Province storage** (`provinces.json` on the server today; one row per province):
```jsonc
{
  "55": {
    "id": 55,
    "name": "Punjab",
    "countryId": "PAK",          // owning country (authority for hex country cache)
    "color": "hsl(47,55%,62%)",
    // membership is NOT stored here — it's the set of hexes with provinceId==55
    // (kept in the hex overlay), so a province is reconstructed by intersection.
    // gameplay (added incrementally, no migration):
    "capitalCityId": 9, "population": 0, "gdp": 0, "development": 0,
    "infrastructure": 0, "resources": [], "culture": "punjabi",
    "religion": "islam", "stability": 0, "modifiers": {},
    // presentation overrides (cosmetic only):
    "smoothing": 2, "simplify": 0, "outline": null /* cached generated loops */
  }
}
```

**Country storage**:
```jsonc
{
  "PAK": {
    "id": "PAK", "name": "Pakistan", "color": "#7ba05b", "government": "monarchy",
    "capitalCityId": 12, "provinceIds": [55, 56],     // owns PROVINCES, not hexes
    "population": 0, "economy": { "gdp": 0, "treasury": 0 },
    "military": { "manpower": 0, "units": 0 },
    "diplomacy": { "IND": -40 }, "technology": {}, "cultureGroups": ["indo_aryan"]
  }
}
```

**Project file** = `{ warpField, regions, layers, version }` + the four data
documents (hexes-overlay, provinces, cities, countries). The base hex grid is
derived from GeoJSON + warp + resolution, so it's never stored in the project —
only regenerated.

---

## 9. Province editing workflow

```
1. (once) Projection mode: warp countries for gameplay space → Bake → hex world
2. Province mode → "+ New province"  (auto id, colour, name)
3. Province Brush: drag over hexes → they join the active province
   → its smooth border regenerates live (cached bitmap blit)
4. Refine: Split / Merge / Border Smooth / Simplify / single-hex Assignment
5. Assign province → country (sets province.countryId; syncs hex country cache)
6. Place cities, paint terrain/resources on their layers
7. Run Province Validation → fix orphans / non-contiguous / unowned
8. Autosave to backend (provinces + hex overlay)
```

*Implemented now:* steps 2–5 (create, brush-paint hexes, generated smooth
borders, select-highlight, rename, merge, delete, assign country) + autosave.

---

## 10. Province design principles — South Asia, c. 1750

**Do not copy modern states/districts.** 1750 is Mughal twilight: Durrani empire
rising in the northwest, Marathas dominant in the centre, Bengal/Awadh/Hyderabad
as autonomous nawabies, Sikh misls forming in Punjab, regional sultanates and the
EIC just gaining footholds. Design provinces around **durable geography +
historical regions + chokepoints**, not 21st-century lines.

**Universal principles**
- **Rivers are spines, not always borders** — a province often straddles a river
  valley (the valley is the economy); ridgelines/watersheds make better borders.
- **Mountains/deserts = natural frontiers & few, large, low-value provinces**
  (Balochistan, Thar, Himalaya) — good for defensive depth and bottlenecks.
- **Chokepoints get their own provinces** (Khyber, Bolan, Khaibar, Palghat Gap,
  Siliguri corridor) — they're the gameplay levers for warfare/trade.
- **Cores around historical capitals** (Delhi, Lahore, Pune, Murshidabad,
  Hyderabad, Kandy, Kandahar) so diplomacy/rebellions have anchors.
- **Balance hex counts** — keep provinces within a band (e.g. ~6–25 hexes) so no
  single province dominates supply/recruitment.

**Per region**
- **Pakistan region:** split Indus into **Upper (Punjab: Lahore/Multan)**,
  **Lower (Sindh: Thatta/Hyderabad)**; **Balochistan** as large arid frontier
  provinces; **Khyber/Bolan** as distinct mountain pass provinces. Punjab dense
  (rich doabs), Balochistan sparse.
- **Afghanistan region:** centre on **Kabul, Kandahar, Herat, Balkh**; mountains
  (Hindu Kush) as big low-pop provinces; passes explicit. Emphasise it as the
  pivot between Persia/India/Central Asia (trade + invasion routes).
- **India region (the bulk):** subdivide by historical **subahs/regions** —
  Gangetic plain (Delhi, Agra, Awadh, Bihar) dense and high-value; **Deccan**
  plateau (Maratha heartland, Hyderabad) medium; **Rajputana/Thar** arid sparse;
  coastal strips (Gujarat, Konkan, Coromandel, Malabar) as trade provinces;
  **Bengal** very rich. This region carries the most provinces.
- **Bangladesh region:** **Bengal delta** — rich, dense, many small provinces;
  rivers as the economy; Dhaka/Chittagong (port) as cores; account for shifting
  distributaries.
- **Nepal region:** band by elevation — **Terai** (lowland, farmable),
  **Hills/Kathmandu valley** (core), **High Himalaya** (huge, sparse). 1750 =
  pre-unification many small hill principalities → several provinces, not one.
- **Bhutan region:** small; 1–3 provinces (valleys + high frontier); a single
  buffer state.
- **Sri Lanka region:** **Kandyan highlands** (independent kingdom, interior
  core) vs **coastal provinces** (Dutch/colonial trade) — interior vs littoral is
  the key axis; spice/cinnamon resources.
- **Iran border regions:** Khorasan/Sistan/Makran frontier provinces facing
  Afghanistan; large, arid, low-density, contested — model as a soft warpable
  frontier (Iran can be shifted/compressed per gameplay).

**Recommended province counts (1750 South Asia focus)**

| Region | Provinces |
|---|---|
| India (incl. Deccan, Bengal-adjacent) | ~150–220 |
| Pakistan (Indus + Balochistan) | ~25–40 |
| Afghanistan | ~15–25 |
| Bangladesh (Bengal delta) | ~15–25 |
| Nepal | ~8–15 |
| Bhutan | ~1–3 |
| Sri Lanka | ~6–12 |
| Iran frontier (in-frame) | ~8–15 |
| **South Asia total** | **~230–350** |

Rationale: enough granularity for meaningful warfare/economy without
micromanagement hell. EU4-class density for the subcontinent. Start at the **low
end (~230)** and subdivide hotspots as systems demand.

---

## 11. Scalability to the whole world

- **Generation** already runs world-wide (105,820 hexes, 241 countries) and is
  stored server-side; the client streams **region slices** (~3k hexes for SA).
- **Province scale:** at EU4-ish density the whole Earth is ~3–6k provinces —
  trivial as rows; the only heavy table is hexes, and that's paged by region.
- **Render/perf:** offscreen-cached base + viewport culling now; add **tiling/LOD**
  (coarser hexes & merged province fills when zoomed out) and a **WebGL
  province-ID + SDF border** pass for the AAA tier.
- **Editing at scale:** all ops are local (a stroke touches a handful of hexes; a
  warp touches one region), so cost is independent of world size. Validation and
  outline regeneration run per-province, not globally.
- **No redesign needed:** warfare/diplomacy/trade/migration/infra/pop all attach
  by ID to the hex→province→country spine (see [ARCHITECTURE.md](ARCHITECTURE.md)
  §8). Position is immutable, ownership is data, visuals are generated.

---

## 12. Status — built vs designed

**Built now:** hex world (whole planet, backend) · region slice rendering ·
Political (vector) + Hex map styles · paint tool · **province registry**
(create/select/rename/delete/merge, assign-to-country) · **province painting**
(assign hexes) · **generated smooth province borders + selection highlight** ·
persistence (`/api/provinces`, `/api/edits`).

**Designed here, next to build (priority order):**
1. Undo/redo command stack (wrap existing edits).
2. Province Split (lasso) + expand/shrink (boundary-ring membership ops).
3. Province Validation tool (orphans / contiguity / ownership).
4. Strategic Projection editor + **Bake** (warp field → regenerate hex world).
5. Cities layer (placement) + Terrain/Resource brushes on their layers.
6. WebGL/SDF border tier + tiling/LOD for world scale.
```
