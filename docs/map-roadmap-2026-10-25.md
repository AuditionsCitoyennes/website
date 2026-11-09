# The map, next: snappy, worldwide, near-free — discussion notes, 2026-10-25

> **Note (2026-11-08):** `/api/boundaries`, its module and the vendored france-geojson were removed in #176; the web reads the static outline files (docs/map-outlines.md).

**Decisions taken on 2026-10-25 (founder):** keep **Mapbox GL JS** (no MapLibre migration); boundaries from **Overture + Etalab** (ODbL share-alike accepted); disputed territories follow the source with a footer note; the **deepest available level per country** (uneven depth accepted); **Supabase Pro at $25/month only while a load-test campaign runs**; the **hierarchical place picker**; basemap and terrain stay Mapbox's. The sections below keep the alternatives for the record; "Plan as decided" at the end is what we build.

Goals stated by the founder: (1) the map must be snappy: elevation, boundaries and animations never lag; (2) it must work for users from every country; (3) the first load ships too much data; (4) staging must run with a huge fake database; (5) cost as close to zero as possible, with no cliff when usage grows.

Method: the code was inventoried (what the map really depends on), and five researchers checked current facts on the web (licences, prices, limits, library capabilities) with sources. Everything below cites where it comes from; "reported" means the researcher read it on the linked page, not that it was exercised here.

## Where we stand

- `features/map` is ~9,500 lines of TS/Vue after the split: a 531-line `GeoDrillMap.vue` over nine composables, two custom WebGL layers (`PlateauWallLayer.ts` 2,113 lines, `ScopeTintLayer.ts`), pure libs. The Mapbox surface used is small (`Map`, `MercatorCoordinate`, `LngLat`, `Marker`, `CustomLayerInterface`, `GeoJSONSource`, `setTerrain`, `addSource/addLayer`, `jumpTo`) plus two reads of Mapbox-private internals for the globe regime (`painter.depthRangeFor3D`, `transform.mercatorFogMatrix`). The style is a Mapbox Studio style; terrain is our own DEM tiles rendered by the API.
- What the map page downloads: one 550 KB gzip JavaScript chunk (mostly Mapbox GL itself), 7 KB of map groups, ~360 KB of boundary levels (cached a day since this week), and on the Témoignages page the whole corpus, 1.5 MB gzip (304 on revisit). Communes come from geo.api.gouv.fr through the API's cache; a département's raised outline is merged from its communes at runtime.
- Why it lags (2026-10-05 diagnosis, confirmed by reading the split code): earcut triangulation on the main thread (`lib/projection.ts`, `gl/ScopeTintLayer.ts`), the scope mask pushed as a GeoJSON `setData` on every scope change (`useScopeMask.ts`), one HTML `Marker` per lieu (`useMapPins.ts`), no Web Worker, DEM tiles rendered server-side per drill.
- Worldwide today: boundaries from france-geojson (2018 vintage) and geo.api.gouv.fr, geocoding via the French BAN, the online form picks a French commune by INSEE code. None of it exists outside France.

## Target architecture

Static-first: everything heavy is built once, offline, and served as cacheable files; the only dynamic calls are small aggregates.

- **Renderer:** MapLibre GL JS (BSD-3, no per-load billing) as the destination; Mapbox stays while the library-agnostic phases land.
- **Basemap:** OpenFreeMap public tiles (no key, no quota, OpenMapTiles schema), with a Protomaps PMTiles extract on Cloudflare R2 kept as a dormant fallback (URL switch).
- **Terrain:** a `raster-dem` source pointed at Mapterhorn (worldwide 30 m, terrarium-encoded 512 px WebP, Cloudflare-cached); our DEM renderer in the API is deleted. The plateau stays: it is drawn by our custom layer from the unit's outline, not by the DEM.
- **Boundaries:** one `boundaries.pmtiles` built monthly by a GitHub Actions job from Overture Maps divisions (world: country → region → county) and Etalab contours-administratifs 2026 (France: régions, départements, communes with INSEE codes), simplified per zoom, stored on R2 (free egress), served through the Protomaps Cloudflare Worker on a custom domain. The client has one vector source; scope and selection are `setFeatureState` on tiles (one batch per interaction); the unit outline for the plateau comes from the tile or a tiny per-unit static file; triangulation moves to a Web Worker with transferred buffers, cached per unit id. No runtime merging of communes.
- **Pins:** a GeoJSON source + symbol layer with clustering instead of HTML markers; HTML stays only for the open lieu card.
- **Places:** no runtime geocoding. A hierarchical picker (country → region → county → locality) over a static gazetteer the site hosts as per-country JSON chunks (Overture divisions + GeoNames cities500 + Etalab communes), with client-side fuzzy search; the picked unit ids (`country_code`, `adm1_id`, `adm2_id`, `locality_id`, lat/lon) are stored on the testimony at write time. France keeps the INSEE picker and BAN (now at data.geopf.fr/geocodage, 50 req/s) as a convenience.
- **Data at scale:** the map never downloads the corpus. The API answers counts per unit for (level, parent, filter hash) from a Postgres RPC (`GROUP BY` on indexed columns), TTL-cached by the API and the edge, a few KB per response; lists are keyset-paginated; text search is a stored `tsvector` (unaccent + french) plus `pg_trgm`.
- **Hosting:** site + `/api` proxy on Cloudflare Workers (free: static assets unlimited, 100k requests/day), tiles and gazetteer on R2 / Workers static assets, API on Scaleway Serverless Containers at min-scale 0 (free inside 200k vCPU-s + 400k GB-s/month), prod DB on Supabase Free until ~100k testimonies.

What stays dynamic: counts, lists, search, form writes, auth. What becomes static: site, basemap, terrain, boundaries, gazetteer.

## Decisions for the founder

1. **Renderer.** Stay on Mapbox (50,000 free loads/month, then $5 per 1,000: 100k loads ≈ $250/month; proprietary licence; Terrain-DEM and the Studio style usable only inside Mapbox SDKs) or move to MapLibre (free at any traffic; the Studio style must be re-authored in Maputnik; the two custom layers must be ported to MapLibre's `render(gl, options)` with shader injection for globe and the experimental `renderToTerrainTile` for draping). Recommendation: MapLibre as the destination, as the last phase, after a 2–3 day spike in phase 0 sizes the port. Until then, keep the Mapbox account without a card: the free cap is the safety net against a scraped token.
2. **Boundary source and licence.** Overture Maps divisions (monthly, one hierarchy with ISO codes, ODbL share-alike on the derived tileset and gazetteer) + Etalab for France (Licence Ouverte), versus geoBoundaries/fieldmaps (CC BY mostly, but 2017–2021 vintages, last release Sept 2023, ADM3 in 81 countries, France without DROM, mixed licences inside). GADM forbids redistribution. Recommendation: Overture + Etalab; accept share-alike by publishing the build scripts and the tiles, which an AGPL project would publish anyway.
3. **Disputed territories.** Overture/OSM's "on the ground" view, the US State Department view (geoBoundaries CGAZ), or both claims with a neutral label. Recommendation: the source's default plus a footer note that boundaries imply no endorsement; revisit when users from those regions appear. A political choice visible to visitors: yours.
4. **Drill depth outside France.** No open, harmonised dataset exists below county level worldwide. Recommendation: country → region → county everywhere, locality points as the leaf, with France's four levels as the one configured exception; add deeper levels country by country when testimonies arrive there. Say so in the UI rather than promising commune level everywhere.
5. **The huge staging database.** 300,000 testimonies ≈ 0.7 GB of payload, 1–2 GB with indexes: it does not fit Supabase Free (500 MB). Options: Supabase Pro $25/month during load-test campaigns (same PostgREST/Auth/RLS as prod, no pausing, downgrade afterwards), a VM running the Supabase docker stack (Hetzner CX33 ≈ €8.99/month, Scaleway DEV1-S ≈ €6.55 + storage, self-managed), or plain Postgres in Docker on the cheapest VM (loses Auth/PostgREST parity, fine for pure load tests of the aggregate and search RPCs). Recommendation: Pro for one or two months when the campaign runs; plain Postgres if even that is too much. This is the one unavoidable cost on the list.
6. **The testimony form.** The picker (zero runtime cost, stable ids, works offline, no licence clause about storing results) changes the form's UX from "type your town" to "pick your town". Free-text alternatives: Nominatim public (1 req/s, autocomplete forbidden), Photon public (throttled, no guarantee), self-hosting (64 GB RAM for Photon), Mapbox temporary geocoding (results may not be stored; permanent has no free tier). Recommendation: the picker; Photon as an optional helper later.
7. **Basemap operator risk.** OpenFreeMap is one donation-funded operator with no SLA (it did survive 100k requests/s in Aug 2025). Recommendation: use it first, and build the Protomaps extract on R2 (France z≤15 + world z≤8, to be measured ≤10 GB) before the new map goes public, so a switch is a URL change.

Not needing a decision: Mapterhorn for terrain (email the maintainers about production use; a z0–12 extract on R2 is the fallback); keep the globe at world level but measure it on a mid-range phone in phase 0.

## Phases

| # | Goal | Work | Effort |
|---|---|---|---|
| 0 | Measure and spike | `performance.measure` around "select unit → plateau visible" and a long-frames observer in the dev probes; baseline on a mid-range Android and an iPhone. Build the PMTiles once with tippecanoe to measure real sizes. Ten-minute test of Mapterhorn terrain in the current map. A 2–3 day MapLibre spike: OpenFreeMap style, Mapterhorn terrain, the two custom layers on globe + terrain. | 1 week |
| 1 | Server-side data (library-agnostic) | Migration: unit id columns on testimonies, indexed, backfilled for the French rows from INSEE codes after verifying the crosswalk. Gazetteer build → per-country JSON. Picker component. Counts-per-unit RPC + TTL cache, keyset pagination, tsvector + pg_trgm search. The corpus endpoint leaves the map page. Seed 300k rows on staging and load-test. | 2–3 weeks |
| 2 | Worldwide boundaries as PMTiles | The monthly build job → R2 → Protomaps Worker. One vector source, feature-state for scope/selection, outline per unit, triangulation in a Worker. Attribution footer. Id-remap script between releases. Mapbox GL JS 3.33 reads PMTiles natively, so this lands before the switch. | 2 weeks |
| 3 | Pins and terrain | Symbol layer with clustering; Mapterhorn raster-dem; delete `modules/dem`; Scaleway container to min-scale 0 (or the 70 mvCPU/128 MB tier if the auth hook needs min-scale 1). | 1 week |
| 4 | MapLibre migration | Style re-authored in Maputnik; fog → sky; `mapbox://` URLs gone; the two custom layers ported per the spike; `freezeElevation` on eases over terrain; reduced-motion respected; the phase-0 measurements re-run. A Mapbox build stays behind a flag until parity is shown. | 3–6 weeks |
| 5 | Hardening | Protomaps and Mapterhorn extracts on R2 as fallbacks; monthly re-tile with size checks; cache-header audit; licences and attribution documented; prod DB upgrade trigger decided. | 1 week |

Snappiness comes from phases 1–3 (no corpus download, no runtime merging, no main-thread triangulation, no DOM pins, no server-rendered DEM); phase 4 removes the cost cliff and the licence dependency.

## Costs

| Component | Free baseline | Where money starts |
|---|---|---|
| Site + `/api` proxy, Cloudflare Workers | static assets unlimited; 100k Worker requests/day | $5/month past 100k/day |
| Tiles and gazetteer, Cloudflare R2 | 10 GB, 10 M reads/month, egress free; custom domain required (r2.dev is rate-limited) | $0.015/GB-month, $0.36/M reads |
| Basemap, OpenFreeMap | no key, no stated limit, no SLA | self-hosted planet extract ≈ $1.65/month if ever needed |
| Terrain, Mapterhorn | no key; no published policy | z0–12 extract on R2 free; planet ≈ $5/month |
| Boundaries, Overture + Etalab | free data; GitHub Actions minutes | none; ODbL attribution + share-alike |
| Prod DB, Supabase Free | 500 MB, 5 GB egress, pauses after a week idle, 3 s / 8 s statement timeouts; from 30 Oct 2026 new tables are not auto-exposed to the Data API | Pro $25/month around ~100k testimonies |
| Staging huge DB | none fits Free | Pro $25/month during campaigns, or a €6.5–9 VM |
| API, Scaleway Serverless Containers | 200k vCPU-s + 400k GB-s/month at min-scale 0 | min-scale 1 at the default 1 vCPU/2 GB tier ≈ €34/month (prices rose June 2026); free only at 70 mvCPU/128 MB |
| Mapbox GL JS (interim) | 50,000 loads/month | $5/1,000 beyond |
| MapLibre GL JS (target) | free, BSD-3 | none |

Immediate check: the staging container was set to min-scale 1 for the auth hook's 5 s budget. At the default tier that is a real monthly cost; either the smallest tier or moving the hook off the container keeps it free.

## Risks

- The MapLibre port is the uncertain item: `renderToTerrainTile` is experimental (6.13.0) and globe needs shader projection injection; only the phase-0 spike sizes it.
- Single-operator services (OpenFreeMap, Mapterhorn): the R2 extracts in phase 5 must exist before public launch.
- Licences: ODbL share-alike on Overture-derived data; attribution lines for OSM/Overture/OpenFreeMap (ODbL), IGN/Etalab (Licence Ouverte), Mapterhorn sources. The likeliest compliance failure is a missing attribution.
- Id drift: Overture releases monthly; the testimony → unit mapping is remapped by script, never re-geocoded. The INSEE crosswalk must be verified before migrating the French rows; Etalab is the safe source for France.
- Supabase Free: size, pausing, statement timeouts for aggregate RPCs, and the 30 Oct 2026 Data API change.
- Terrain re-drape: with terrain on, every feature-state change re-renders terrain tiles; per-frame churn would bring the lag back. One batch per interaction.
- Performance parity between the two libraries on custom layers + terrain is unproven either way; the measurements, not the library, decide.

## Sources (as read by the researchers on 2026-10-25)

Mapbox pricing and map loads: https://www.mapbox.com/pricing, https://docs.mapbox.com/help/glossary/map-loads/ · Mapbox Terrain-DEM SDK-only: https://docs.mapbox.com/data/tilesets/reference/mapbox-terrain-dem-v1/ · Mapbox PMTiles support: https://docs.mapbox.com/mapbox-gl-js/example/pmtiles-vector-source/ · MapLibre changelog and custom layers: https://github.com/maplibre/maplibre-gl-js/blob/main/CHANGELOG.md, https://maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/ · Cloudflare Workers and R2: https://developers.cloudflare.com/workers/platform/pricing/, https://developers.cloudflare.com/r2/pricing/, https://developers.cloudflare.com/r2/buckets/public-buckets/ · Supabase: https://supabase.com/pricing, https://supabase.com/docs/guides/database/postgres/timeouts, https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically · Scaleway: https://www.scaleway.com/en/pricing/serverless/, https://www.scaleway.com/en/blog/a-transparent-update-on-scaleway-pricing/ · Overture divisions: https://docs.overturemaps.org/guides/divisions/, https://docs.overturemaps.org/attribution/ · geoBoundaries and GADM: https://www.geoboundaries.org/api/current/gbOpen/ALL/ALL/, https://gadm.org/license.html · Etalab contours: https://github.com/etalab/contours-administratifs · BAN at IGN: https://cartes.gouv.fr/aide/fr/guides-utilisateur/utiliser-les-services-de-la-geoplateforme/geocodage/ · Mapterhorn and AWS terrain: https://mapterhorn.com/data-access, https://registry.opendata.aws/terrain-tiles/ · OpenFreeMap: https://openfreemap.org/ · Protomaps basemaps: https://docs.protomaps.com/basemaps/downloads · Geocoder policies: https://operations.osmfoundation.org/policies/nominatim/, https://github.com/komoot/photon, https://download.geonames.org/export/dump/readme.txt

## Plan as decided (2026-10-25)

Mapbox GL JS stays. That removes phase 4 (the port), the phase-0 spike, the OpenFreeMap/Mapterhorn pieces and their fallbacks. What remains is library-agnostic and is where the snappiness and the scale come from.

| # | Goal | Work | Effort |
|---|---|---|---|
| 0 | Measure, and size the tiles | `performance.measure` + long-frames observer in the dev probes; baselines in the pane and on two real phones; a first tippecanoe build of Overture + Etalab to measure PMTiles sizes and depth per country. | 3–4 days |
| 1 | Server-side data | Unit id columns on testimonies (country, adm1, adm2, locality…, uneven depth allowed), indexed and backfilled for France; the gazetteer build → per-country JSON chunks; the picker; counts-per-unit RPC + cache; keyset pagination; tsvector + pg_trgm search; the corpus endpoint leaves the map page; 300k rows on staging (Supabase Pro during the campaign) and load-test. | 2–3 weeks |
| 2 | Worldwide boundaries as PMTiles | Monthly GitHub Actions build (Overture divisions, every level present, + Etalab 2026 for France) → R2 → Protomaps Worker on a custom domain; Mapbox GL JS 3.33 reads PMTiles natively; one vector source, feature-state for scope/selection, per-unit outline for the plateau, triangulation in a Web Worker; attribution footer; id-remap script between releases. | 2 weeks |
| 3 | Pins and terrain | Only if phase 0 measures a cost: pins as a symbol layer. Decide the plateau's DEM: keep our API-rendered tiles (cheap since PR 1, but a container must answer) or generate them client-side; Mapbox Terrain-DEM may add real relief under the plateau if wanted. | 1 week |
| 4 | Hardening | Monthly re-tile with size checks; cache-header audit; licences and attribution; the prod DB upgrade trigger (~100k testimonies); Mapbox: keep the account card-less, URL-restrict the token, watch the monthly load count, decide what happens past 50,000 loads before it happens. | 1 week |

Cost with Mapbox kept: the cost table minus the OpenFreeMap/Mapterhorn rows; Mapbox free up to 50,000 map loads a month, $5 per 1,000 beyond. Without a card on the account the maps stop past the cap rather than billing: that is the safety net until the project can pay or revisits the engine.
