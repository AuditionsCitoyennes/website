# Map performance baseline and tileset sizing — October 2026 (phase 0)

Phase 0 of docs/map-roadmap-2026-10-25.md ("Plan as decided"): measure the map as it is, and size the boundary tileset phase 2 will serve. Nothing visitors see changed. Two tools came out of it, both in PR AuditionsCitoyennes/website#110:

- **The perf probes** (`apps/web/src/shared/perf/perf.ts`), built only with the testing tools (`__TEST_TOOLS__`: the dev server and staging; production carries none of it). Four interactions are measured from the user's act to the frame that shows the result, as `performance.mark`/`performance.measure` pairs (`ac:select-plateau`, `ac:scope-mask`, `ac:drill-boundaries`, `ac:lieu-pins`, visible in DevTools' and Safari's timelines), with the steps between them as spans, a long-frames observer, and `window.__acPerf` to read everything. One console line per interaction.
- **The tileset build** (`scripts/map-data/build-boundaries.sh`): Overture Maps divisions (the world) + Etalab contours-administratifs 2026 (France) → mapshaper per zoom band → tippecanoe → one `boundaries.pmtiles`, and a report. Run once here; the numbers are below.

## 1. The four measures

| measure | starts | ends |
|---|---|---|
| `select-plateau` | a unit is selected: a panel row, a pin, a click inside its territory, a breadcrumb (`geo-nav/model/useNavActions`) | the first frame `PlateauWallLayer` draws with the rise at 1 for that unit (read from the frame bus, `map/composables/usePlateauFrames`); for Monde, the moment the plateau is cleared |
| `scope-mask` | `currentScope` is written (sync watcher in `GeoNav.vue`) | the grey is re-cut around the new selection: `ScopeTintLayer.setSelection` rebuilt its sheet (`useScopeMask.applyMask`); the draped sheet's worker indexing is noted apart (`mask.drapedIndexed`) |
| `drill-boundaries` | same act as `select-plateau` | the outline has every geometry it will get: the scope's own (a département's merged outline), its children's and its neighbours' communes (`useMapFeed.outlineReady`) |
| `lieu-pins` | a lieu is opened (`openPlace`) | `buildMarkers` placed a set of pins that are all dots (the micro zone's lieux) |

Spans (attributed to every interaction they fall inside): `dem.post` (the DEM POST), `plateau.rise` (the 300 ms exaggeration animation), `plateau.setGeometry` (walls, lid, lines, halo meshes), `projection.ringBases` / `projection.lidBases` (per-geometry projection and earcut + subdivision, cache misses only), `tint.setSelection` (earcut of the flat grey sheet), `mask.setData` and `mask.drapedIndexed` (the draped sheet handed to and indexed by mapbox's worker), `lid.capture` (the hidden-map snapshot that textures the plateau top), `slabs.sync` (the analyses' slabs), `pins.buildMarkers`, and the Vue derivations `vue.hierarchy`, `vue.outline`, `vue.mapUnits`, `vue.deriveScope`. Main-thread requests inside the window are classed from Resource Timing (`dem.tiles`, `boundaries.departement`, `boundaries.communes`, `mapbox`…); mapbox's own worker fetches (basemap tiles, PMTiles) are not visible to it.

Long frames: `long-animation-frame` entries over 50 ms where Chrome provides them (with the scripts they blame, by file), `longtask` otherwise, and on Safari a `requestAnimationFrame` delta loop that only runs while an interaction is open. `__acPerf.frameSource` says which one a device used.

## 2. Baseline in the Browser pane (laptop, 2026-10-25)

Machine and conditions: Apple Silicon Mac (10 cores, 17 GB), Chrome 152 in the Claude desktop Browser pane, 1280 × 800 at DPR 2, dev server on the worktree of PR #110, API from the same worktree with its boundary cache seeded by the main checkout's (801 entries), production Supabase data (one région with testimonies: Auvergne-Rhône-Alpes). The pane throttles `requestAnimationFrame` to ~1 Hz, so the page ran under the virtual-clock pump described in §5: frames are flushed every 16 ms of wall clock from a MessageChannel loop, with a 1 × 1 `readPixels` after each flush so GPU time counts. Because the frames are not the browser's, `long-animation-frame` sees none of them: the "long frames" below are the pump's flushes over 50 ms, and `longtask` entries (which the Long Tasks API still reports) are given beside them.

Scenario: `/temoignages`, Monde → France → Auvergne-Rhône-Alpes → Rhône → Lyon → Lyon 7e, with a 220 px drag and three wheel notches at each level, a lieu opened (Place Carnot), `?analyses=1`, then Rhône and Auvergne-Rhône-Alpes again with the analyses on, and Isère. Every selection came from the panel's rows or crumbs; the pan at Lyon 7e moved the scope to Lyon 2e (the containment read off the view), which is the behaviour.

| step | zoom after | select → plateau (ms) | scope → mask (ms) | drill → boundaries (ms) | pump flushes > 50 ms | longest task (ms) | dem.post | dem.tiles (n× Σms) | setGeometry | lidBases (earcut) | tint.setSelection | mask.drapedIndexed | lid.capture | slabs.sync | pins.buildMarkers | deriveScope |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| crumb Monde | 3.63 | 187 (cleared) | 3 | 0 | 0 | 0 | — | — | 10 | — | 0 | 19 | — | — | 2 | 0 |
| gesture @world: drag 220 px + 3 wheel notches | 4.08 | — | — | — | 0 | 0 | — | — | — | — | — | — | — | — | — | 0×6 |
| row France | 4.8 | 362 | 56 | 0 | 0 | 0 | 38 | 6× 8 | 11 | — | 2 | 24 | 94 | — | 1 | 0 |
| gesture @France | 5.26 | — | — | — | 0 | 0 | — | — | — | — | — | — | — | — | — | 0×6 |
| row Auvergne-Rhône-Alpes | 6.25 | 477 | 3 | 0 | 0 | 0 | 64 | 12× 216 | 5 | 1 | 0 | 25 | 1080 | — | 1 | 0 |
| gesture @ARA | 6.69 | — | — | — | 0 | 0 | — | — | — | — | — | — | — | — | — | 1×6 |
| row Rhône (département: merged outline) | 8.71 | 571 | 33 | 22 | 0 | 83 | 59×2 | 12× 1151 | 70 | 4 | 10 | 19 | 1215×2 | — | 1×4 | 0 |
| gesture @Rhône | 9.16 | — | — | — | 0 | 0 | — | — | — | — | — | — | 106 | — | — | 1×6 |
| row Lyon | 11.63 | 482 | 5 | 72 | 0 | 0 | 76×2 | 12× 357 | 6 | 0 | 0 | 27 | 1276×2 | — | 1×2 | 0 |
| gesture @Lyon | 12.07 | — | — | — | 0 | 0 | — | — | — | — | — | — | 715 | — | — | 1×6 |
| row Lyon 7e | 12.82 | 489 | 2 | 0 | 0 | 0 | 38 | 14× 224 | 4 | 0 | 0 | 25 | 305 | — | 1 | 0 |
| gesture @Lyon 7e (scope → Lyon 2e) | 13.27 | — | 1 | — | 0 | 0 | 17 | — | 4 | 0 | 0 | 2 | 95 | — | 1 | 1×6 |
| open lieu Place Carnot | 15.3 | lieu → pins 1 | — | — | 1 (max 117) | 0 | — | — | 0 | — | 0 | 3 | — | — | 0×2 | — |
| analyses on (`?analyses=1`), lieu open | 12.87 | — | — | — | 1 (max 62) | 0 | 82 | — | 4 | 0×3 | 0 | 43 | 402 | 2 | 1 | 0 |
| crumb Rhône, analyses on | 8.45 | 536 | 9 | 0 | 0 | 74 | 59 | 12× 58 | 59 | 0×3 | 4 | 25 | 947 | 2 | 1 | 0 |
| crumb Auvergne-Rhône-Alpes, analyses on | 6.23 | 489 | 3 | 0 | 0 | 0 | 50 | 12× 48 | 4 | 0×3 | 0 | 35 | 902 | 2 | 1 | 0 |
| row Isère (outline already fetched as Rhône's neighbour) | 7.89 | 546 | 8 | 54 | 0 | 72 | 66×2 | 14× 675 | 62 | 4×4 | 4 | 30 | 105 | 1 | 1×2 | 0 |

Columns: ms of main-thread time for the spans (a `×n` is the number of calls summed); `dem.tiles` is the number of DEM tile fetches that ended in the window and their durations summed (they overlap); `lid.capture` is wall time of an async capture. The boot itself (not a step): the first `scope-mask France` took 951 ms, waiting for the métropole contour and the basemap (24 mapbox requests, 972 KB).

The API's département merge, measured apart with curl on the same API (the union of a département's communes fetched from geo.api.gouv.fr, merged and simplified; cold = first request ever for that code):

| département | cold (ms) | warm (ms) | payload (bytes, uncompressed JSON) |
|---|---|---|---|
| 29 Finistère | 996 | 1.5 | 432 272 |
| 59 Nord | 594 | 1.7 | 316 439 |
| 2A Corse-du-Sud | 464 | 1.4 | 408 562 (19 641 vertices) |
| 200 communes of the 29 in one batch (`/api/boundaries/communes`), warm | 31 | | 3 920 297 |

### Where the time goes

- **Select → plateau is 360–570 ms, and most of it is by design.** The rise animation is 300 ms (`RISE_MS`), preceded by a 150 ms sink when another plateau stood (`SINK_MS`); the DEM POST takes 40–80 ms; the geometry 4–11 ms for a région, a ville or an arrondissement and **60–70 ms for a département** (the merged outline: 20 000 vertices, 4 ms of earcut, the rest building wall, lid, line and halo meshes in `PlateauWallLayer.setGeometry`). Those 60–70 ms are the only long tasks a drill produces (72–84 ms, three of them in the run, all départements). Earcut itself is small everywhere (`projection.lidBases` ≤ 4 ms, `tint.setSelection` ≤ 10 ms); the per-geometry caches make a second selection of the same unit free.
- **The DEM tiles are the slow network item.** 12–14 PNG tiles per selection, rendered by the API: 50–350 ms summed when the API has them, 1 151 ms for Rhône (≈ 96 ms per tile when rendering is cold); they do not delay the rise (it starts at once and the tiles were warmed during the sink), they show as a late re-tessellation. Phase 3's question (keep the API's DEM or not) is about this cost and the container it needs.
- **The lid capture is the longest asynchronous item: 0.1–1.3 s per selection**, and 0.1–0.7 s again after a zoom (the texture is re-shot at the new resolution). It lands after the rise, so it is not inside `select-plateau`, but it is what makes the plateau look finished; a slow phone will show the rim gap longer.
- **Scope → mask is 1–56 ms**: the flat GL sheet is cut synchronously (earcut 0–10 ms) and on screen next frame; the draped sheet the globe shows is indexed by the worker 19–43 ms later. The 56 ms of France is the DEM POST sharing the window.
- **Drill → boundaries is 0–72 ms warm**: régions and the country have their outlines at boot; a département's merged outline cost 11 ms (cached) and Lyon's communes 2 ms of network plus ~70 ms of hierarchy rebuilds and outline recomputes. **Cold, the département merge is 0.5–1 s on the API** (the table above) and that wait is what `scopePending` holds the old plateau through (`DEP_WAIT_MS` 1 200 ms). A batch of 200 communes is 3.9 MB of uncompressed JSON: the largest payload the map asks for, and the one the PMTiles replace.
- **Lieu → pins is under 1 ms** when the lieu is opened from zoom ≥ 12: `mapUnits` switches to the lieux in view the moment `inMicroZone` flips (before the dive), and `buildMarkers` diffs the DOM. The dive itself produced the longest frame of the run (117 ms: the plateau's teardown, the spotlight's start and the pins' rebuild in one frame). Opened from afar (a filtered result), the dots wait for the landing instead: not measured here.
- **Vue is not a cost**: `vue.hierarchy`, `vue.outline`, `vue.mapUnits`, `vue.deriveScope` are all < 1 ms per run, including the six `deriveScope` runs of each gesture (the view emits ~4×/s while panning).
- **Gestures: no long frame at any level** with the plateau up, on this machine. The costs of a pan are the lid re-capture after it settles (0.1–0.7 s, asynchronous) and the DOM pins.
- **The analyses' slabs cost 1–2 ms** (`slabs.sync`); turning them on with a lieu open re-raises the arrondissement (82 ms DEM POST, 62 ms frame).

What this says for the plan: on a laptop the map is not CPU-bound; its latency is the animations (450 ms of sink + rise), the server-rendered DEM, the département merge when cold, and the lid snapshot. The one main-thread hot spot phase 2 removes by moving triangulation to a worker is the département mesh (60–70 ms frames). The phones decide the rest: §4.

## 3. The boundary tileset (Overture + Etalab → PMTiles)

Built with `scripts/map-data/build-boundaries.sh` from Overture Maps release 2026-10-21.0 (divisions theme, 4.6 GB of parquet read once with DuckDB over httpfs: 3 min 25 s) and Etalab contours-administratifs 2026 at 50 m (régions, départements, communes: 1 + 2 + 17.6 MB gzipped, from etalab-datasets.geo.data.gouv.fr; adresse.data.gouv.fr answered 503 all afternoon).

Choices made for this build (to revisit for the monthly job):
- Land polygons only, one per division: the land-only variant when Overture has it, else land + territorial waters (most regions and every locality exist in that form only).
- France's region, county, localadmin and locality rows from Overture are replaced by Etalab's régions (26, DROM and COM included), départements (109) and communes (35 014, Paris/Lyon/Marseille arrondissements included), with ids `fr:reg:84`, `fr:dep:69`, `fr:com:69123` (INSEE codes: what the site stores) and the Overture France id as the régions' parent.
- Levels and zoom bands (mapshaper `-clean -simplify interval=<m> keep-shapes` per band, about half a pixel at the band's deepest zoom on 512 px tiles): country 0–3 (3 000 m), 4–7 (300 m), 8–10 (30 m); region 2–5 (1 000 m), 6–9 (100 m), 10–12 (10 m); county 4–7 (300 m), 8–11 (20 m), 12–14 (5 m); localadmin 6–9 (100 m), 10–14 (10 m); locality 8–11 (20 m), 12–14 (5 m). Deeper zooms overzoom.
- mapshaper runs on the whole world for country and region, and per country for county, localadmin and locality (one country at a time fits in memory; shared borders are simplified together inside a chunk, not across two). tippecanoe: one layer per level, attributes id/name/level/parent/country, `--no-simplification-of-shared-nodes --detect-shared-borders`, no feature or tile-size limit (nothing is dropped; the biggest tiles are reported instead).

### Features per level (Overture, world)

| level | features | vertices | vertices / feature | largest (vertices) | WKB |
|---|---|---|---|---|---|
| country | 219 | 6 040 330 | 27 581 | 230 251 (Chile) | 98 MB |
| dependency | 53 | 90 777 | 1 713 | 51 422 (Greenland) | 1.6 MB |
| region | 3 929 | 29 508 797 | 7 511 | 254 948 (Bretagne) | 473 MB |
| county | 38 937 | 82 088 290 | 2 108 | 342 837 (Unorganized Division No. 23, Canada) | 1 315 MB |
| localadmin | 21 502 | 19 868 586 | 924 | 61 049 (Brest) | 318 MB |
| locality | 556 094 | 182 154 812 | 328 | 228 895 (Auckland) | 2 923 MB |

The largest single features by level: Chile, Russia, Argentina (country, 218–230 k vertices each: coastlines); Bretagne, Nunavut, Îles Marquises (region, 203–255 k); three Canadian unorganized divisions (county, 204–343 k); Brest, Vannes, Lorient (localadmin, 43–61 k — Overture's French localadmins are the arrondissements, with their coasts); Auckland, Southwest (Australia), Coari (Brazil) (locality, 102–229 k). France in Etalab 50 m: 26 régions, 109 départements, 35 014 communes.

### Depth per country ("deepest available level per country")

Of the 272 country codes with a polygon (219 countries, 53 dependencies):

| deepest level present | codes |
|---|---|
| locality | 229 |
| county | 8 |
| region | 14 |
| country only | 21 |

So the roadmap's "deepest available level per country" gives a locality level in 229 of 272 codes; the 21 with nothing below the country are small dependencies and islands for the most part. The full table (a row per code with the counts at each level) is `depth-per-country.csv` in the build output and the report. A few, as a feel for the depth and its unevenness:

| code | region | county | localadmin | locality |
|---|---|---|---|---|
| FR (Overture, before Etalab replaces it) | 13 | 97 | 320 | 36 693 |
| DE | 16 | 399 | 0 | 23 237 |
| ES | 20 | 50 | 0 | 8 656 |
| IT | 20 | 109 | 0 | 8 581 |
| GB | 4 | 216 | 0 | 21 924 |
| BE | 3 | 10 | 43 | 2 811 |
| CH | 26 | 169 | 2 119 | 564 |
| US | 51 | 3 134 | 0 | 32 120 |
| CA | 13 | 1 537 | 0 | 5 830 |
| BR | 27 | 0 | 0 | 6 360 |
| MA | 13 | 75 | 427 | 1 627 |
| DZ | 69 | 548 | 0 | 1 674 |
| TN | 24 | 266 | 0 | 2 145 |
| SN | 14 | 46 | 128 | 585 |
| CI | 14 | 31 | 9 | 173 |
| CM | 10 | 58 | 0 | 444 |
| MG | 24 | 119 | 0 | 1 135 |
| HT | 10 | 42 | 143 | 45 |
| LB | 9 | 25 | 0 | 1 098 |
| IN | 37 | 787 | 0 | 5 360 |
| CN | 32 | 336 | 2 853 | 31 733 |
| JP | 47 | 1 742 | 0 | 2 136 |

The levels skip (Brazil has no county, Switzerland's communes are localadmins), which is why the client walks "the next level present under this one" rather than a fixed ladder.

### Tile sizes

_Pending: the build was still tiling when this section was written; the table is filled from `report.md` once `boundaries.pmtiles` exists._

### Mapbox GL JS 3.33 and PMTiles

Mapbox GL JS resolves a tile provider from a source URL's extension (`resolveTileProvider` in the 3.33 bundle: `.pmtiles` → the `pmtiles` provider, whose module `mapbox-gl-pmtiles-provider/v0.0.3` is loaded from api.mapbox.com into the worker on first use); `provider: "pmtiles"` on the source says it explicitly. There is no `pmtiles://` scheme: the source is `{ type: "vector", url: "https://…/boundaries.pmtiles", provider: "pmtiles" }`. The dev flag `?pmtiles=<url>` (`apps/web/src/features/map/dev/pmtiles.ts`, testing tools only) adds the archive to the current map and draws its five levels as lines; `window.__acPmtiles` reports the tiles that arrived and any error.

_Pending: the check against the built archive and its screenshot are added once the build finishes._

## 4. Repeating the baseline on a phone (for the founder)

The probes exist on staging (its build has the testing tools) and on any dev server; production has none. The phone needs a desktop beside it for the console: Chrome's remote debugging for Android, Safari's Web Inspector for the iPhone.

**Mid-range Android (Chrome):**
1. On the phone: Settings → About phone → tap "Build number" seven times (developer options), then Developer options → USB debugging on. Plug it into the laptop with a cable; accept "Allow USB debugging" on the phone.
2. On the phone, in Chrome, open the staging site at `/temoignages` (or the dev server over the LAN: `http://<laptop IP>:5173/temoignages`, the API's CORS allowing localhost only means the dev server must proxy; staging is simpler).
3. On the laptop, in Chrome: `chrome://inspect/#devices`, find the tab, click **inspect**. In the Console tab check `__acPerf.frameSource` prints `long-animation-frame`.
4. On the phone, do the scenario with a finger: Monde (crumb) → France (row) → Auvergne-Rhône-Alpes → Rhône → Lyon → Lyon 7e, a one-finger pan and a pinch at each level, open a lieu (a row in the arrondissement's list), turn the analyses on (the chart button), then the Rhône crumb. One console line appears per step.
5. In the console: `__acPerf.table()` shows the summary; then `copy(JSON.stringify(__acPerf.dump()))` puts the full JSON in the laptop's clipboard. Paste it in the PR (or a gist), with the phone model, Android and Chrome versions.

**iPhone (Safari):**
1. On the iPhone: Settings → Apps → Safari → Advanced → Web Inspector on. On the Mac: Safari → Settings → Advanced → "Show features for web developers". Plug the iPhone in (or same Wi‑Fi once paired; trust the computer when asked).
2. On the iPhone, in Safari, open the staging site at `/temoignages`.
3. On the Mac: Safari → Develop → *your iPhone* → the page. In the Console check `__acPerf.frameSource` — it will print `raf-delta` (Safari has neither long-animation-frame nor longtask: frames over 50 ms are counted from the gaps between animation frames while an interaction runs).
4. Same scenario as above, with the finger.
5. `__acPerf.table()`, then `copy(JSON.stringify(__acPerf.dump()))` and paste the JSON in the PR, with the iPhone model and iOS version. Safari's Timelines tab also shows the `ac:*` measures if a recording is running.

What to look at in the result: `ms` of each `select-plateau` (the laptop's 360–570 ms is 450 ms of animation plus the rest), `frames.count` and `frames.longest` (the laptop had one 72–84 ms task per département and none elsewhere), `spans["plateau.setGeometry"]` and `spans["lid.capture"]`, and `net["dem.tiles"]`.

## 5. Method: the pane and the pump

The Claude desktop Browser pane runs the page with `requestAnimationFrame` throttled to about 1 Hz, so the run above used a virtual-clock pump installed on a map-less route (`/auth`) before navigating to `/temoignages`: `requestAnimationFrame`, `setTimeout` and `clearTimeout` are replaced by queues, flushed by a `MessageChannel` loop every 16 ms of wall clock (timers fire when due on the real clock), with `__acMap.triggerRepaint()` every tenth flush and a 1 × 1 `gl.readPixels` after each flush so the GPU's work is paid inside the flush. Flushes over 50 ms are the pane's "long frames". The scenario was driven by clicking `.unit-row` and `.crumb` elements and by synthetic `mousedown`/`mousemove`/`mouseup` and `wheel` events on the canvas, each step waiting for `!map.isMoving()`, no open interaction, and a rise at 1, then 1.2–2.5 s for the captures to land. Flights land in ~0.6 s under the pump. Everything read came from `__acPerf`, `__acPlateau()`, `__acFrame()`, `__acAnalysesNav()` and the pump's own counters.

Caveats of this baseline: a desktop-class CPU and GPU; caches warm (the API's boundary cache had Rhône, Lyon and their neighbours; the browser had the basemap); pumped frames are not vsync-paced frames (a frame that takes 30 ms shows nothing here and would drop one on a 60 Hz display); `long-animation-frame` could not attribute scripts under the pump. The phones (§4) replace all of that.
