# DEM parity fixtures

The selections `scripts/parity/demRelief.test.ts` raises with both relief renderers (the API's
`apps/api/src/modules/dem/service.ts` and the web's `apps/web/src/features/map/relief/demRaster.ts`).
Copied here, not read from `apps/api/data/`, so the golden hashes keep their inputs when the API's
copies go. Each file is one line of GeoJSON. Changing any of them changes the golden: regenerate it
(`UPDATE_GOLDEN=1`, see the test's header).

## From france-geojson

- `metropole.geojson`: `metropole-version-simplifiee.geojson`, copied byte for byte.
- `region-84.geojson`: Auvergne-Rhône-Alpes (code 84) out of `regions-version-simplifiee.geojson`.
- `departement-69.geojson` (Rhône, 1 polygon) and `departement-83.geojson` (Var, 4 polygons, the
  most of any département in the file) out of `departements-version-simplifiee.geojson`.

The extracts are the source's Feature (geometry and properties) re-serialised in a one-feature
FeatureCollection. The source files, as vendored in `apps/api/data/france-geojson/` (fetched
2026-10-21 from [gregoiredavid/france-geojson](https://github.com/gregoiredavid/france-geojson),
branch `master`; IGN Admin Express COG 2018 traced, simplified to 25 % by the source):

| File                                      | md5                                |
| ----------------------------------------- | ---------------------------------- |
| `metropole-version-simplifiee.geojson`    | `5b50944d1ca5e003c3275e6e76d5615f` |
| `regions-version-simplifiee.geojson`      | `275e39e649b090b9a8dd957659f8d611` |
| `departements-version-simplifiee.geojson` | `7999bd8fa3567d938032da52f6a9bfdf` |

Licence: [Licence Ouverte / Open Licence (Etalab)](https://www.etalab.gouv.fr/licence-ouverte-open-licence).
Attribution to keep: « Source : IGN — Admin Express COG 2018, via france-geojson (Grégoire David) — Licence Ouverte ».

## Generated

Synthetic, written by a one-off script kept outside the repository: `square.geojson` (a 6 km square, the 37.5 m
floor's size), `hole.geojson` (a 10 km square with a 4 km hole), `seam.geojson` (three polygons
across the z ≥ 6 tile seams through u = 33/64, v = 23/64), `antimeridian.geojson` (a ring at lng
179.9, the last tile column), `cull-edge.geojson` (around the z8 tile corner in its `corner`
property: for z 8 to 12, 3-texel squares whose box sits 0, 0.5, 1 and 1.5 texels inside or outside
the padded edge of each tile meeting there, plus an anchor square) and `empty.geojson` (no feature).
