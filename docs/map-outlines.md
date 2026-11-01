# Static outlines (map item 3, France)

`scripts/map-data/outlines/` cuts France's administrative outlines into static
files that replace `/api/boundaries` (a runtime merge of commune contours, France
only). Each file belongs to one parent and holds the parent's own outline
**and** its children's, from one cut: a raised unit's lid edge and the lines
lifted onto it are the same segments. Tiles cannot do that (they clip, and they
simplify per zoom and per level). Nothing here runs in CI or in production; the
web reads a released build.

Why Etalab 50 m as delivered works: every département's segment set equals the
union of its communes (109 of 109, no segment on either side only), every
région's equals the union of its départements (26 of 26), and Paris, Lyon and
Marseille equal the union of their arrondissements (the S3 spike's
`raw-union-all.json`, re-checked by gate 1 of every build).

## Files (format v1)

A build `o<YYYYMMDD>-<n>` lives in `<out>/<build>/` (default out:
`~/.cache/ac-map-data/outlines`). File names are unit ids with `:` → `_`
(`fr:dep:69` → `fr_dep_69`; no id holds `_`).

| file | content | tier |
|---|---|---|
| `root.json` | `{v, build, tiers, units: [row…]}`: France, 26 régions, 109 départements | — |
| `k/FR.json` | self = the 13 mainland régions dissolved after ONE Douglas-Peucker run (1000 m, keep-shapes, then `-clean`) over the 26 régions; units = those 26 régions | `fr1000` (`--fr-tier 300`: `fr300`) |
| `k/fr_reg_<r>.json` (26) | self = the région's départements dissolved; units = the départements | `e50` |
| `k/fr_dep_<d>.json` (109) | self = the Etalab département; units = its communes (not the arrondissements) | `e50` |
| `k/fr_com_<c>.json` (3) | Paris, Lyon, Marseille: self = the commune (its entry in `k/fr_dep_*`); units = its arrondissements | `e50` |
| `u/fr_reg_*`, `u/fr_dep_*` (135) | the unit's self alone, byte-identical to the self of its `k/` file | as `k/` |
| `manifest.json` | build, date, sources, sha256 of each input, mapshaper version, counts, bytes, file count | |
| `NOTICE.txt` | Etalab Licence Ouverte credit | |

`e50` is Etalab's own 50 m generalisation, rounded to 5 decimals (`tolM: 0`).
A family whose self exceeds 20,000 vertices is cut again as `fam<m>`. Shapes:

```
k: {"v":1,"build":"o20261101-1","kind":"k","id":"fr:dep:69","tier":"e50","tolM":0,
    "self":{"id":"fr:dep:69","bbox":[w,s,e,n],"center":[lat,lng],"n":1669,"g":{"type":"Polygon",…}},
    "units":[{"id":"fr:com:69123","name":"Lyon","level":"city","k":1,"u":0,"bbox":[…],"center":[…],"n":160,"g":{…}}, …]}
u: {"v":1,"build","kind":"u","id","tier","tolM","self":{…}}
root: {"v":1,"build","tiers":{"<tag>":{"tolM":<m>,"source":"etalab-50m"}},"units":[row…]}
row: {"id","parent","level","name","bbox","center","st":"<self tier>","k":0|1,"u":0|1,"g":0|1}
```

`level` is the site's LevelKey (`country|region|dep|city|arr`). `bbox` is
`[minLng, minLat, maxLng, maxLat]` over every ring; `center` (`[lat, lng]`) is the
area-weighted centroid of the largest polygon's exterior, the API's `enrich()`
copied into `lib.ts` (Etalab 50 m instead of Géo API contours, so a centre can
move by tens of metres against today's API). Coordinates are `[lng, lat]` at
5 decimals, latitudes within ±85.0511, rings closed without repeated points,
exteriors counter-clockwise and holes clockwise (RFC 7946). `k`/`u` flags
declare the files that exist: the web never probes for one. `lib.ts` exports
`validateFileV1`, the shape check the web's loader runs.

## Running it

Once a year, when Etalab publishes a vintage (download it with
`scripts/map-data/build-boundaries.sh --steps etalab --etalab-year <year>`):

```bash
scripts/map-data/outlines/build-outlines.sh --build o20261101-1
#   [--out DIR] [--raw DIR] [--fr-tier 1000|300] [--steps prep,simplify,pack] [--force]
```

It needs Node (`npx tsx`) and `mapshaper-xl` (`MAPSHAPER=` to point at it).
Steps leave markers under `<out>/.work/<build>/`; `--force` redoes the steps
asked for. On this Mac (10 cores, 2026-11-01): prep 2 s, simplify 2 s, pack
8 s. Two builds from the same inputs are byte-identical but for the
manifest's `created`.

## Not here

The gates that fail a build (coincidence, identity, budgets, ids, closure,
validity), the sizes of a checked build and the release tarball (the next PR);
country outlines (Overture, the tier ladder, `g/`), world subdivisions, communes
at Etalab's 5 m (a later `--communes 5m` flag would cut bundles from the finer
vintage), tiles, CI.
