# Static outlines (map item 3, France)

`scripts/map-data/outlines/` cuts France's administrative outlines into static
files that replace `/api/boundaries` (a runtime merge of commune contours, France
only). Each file belongs to one parent and holds the parent's own outline
**and** its children's, from one cut: a raised unit's lid edge and the lines
lifted onto it are the same segments. Tiles cannot do that (they clip, and they
simplify per zoom and per level). Nothing here runs in CI or in production; the
web reads a released build.

Why Etalab 50 m as delivered works: every département's segment set equals the
union of its communes (109 of 109, no segment on either side only) and every
région's equals the union of its départements (26 of 26), per the S3 spike's
`raw-union-all.json`. Paris, Lyon and Marseille equal the union of their
arrondissements (142, 159 and 726 outer segments, none on one side only): a
separate check of the Etalab data made while the plan was reviewed, as that
file holds no city. Gate 1 re-checks all of it on every build.

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

Once a year, when Etalab publishes a vintage. `build-boundaries.sh`'s etalab
step downloads only the files missing from `raw/` and skips itself once done,
so remove the old files and force it:

```bash
rm ~/.cache/ac-map-data/raw/etalab-{regions,departements,communes}-50m.geojson
scripts/map-data/build-boundaries.sh --out ~/.cache/ac-map-data --steps etalab --etalab-year <year> --force
scripts/map-data/outlines/build-outlines.sh --build o<YYYYMMDD>-1 --etalab-year <year>
#   [--out DIR] [--raw DIR] [--fr-tier 1000|300] [--steps prep,simplify,pack,check,release] [--force]
```

`--etalab-year` (default 2026) is the vintage the manifest's `sources` and
`NOTICE.txt` name; the manifest also holds the sha256 of each input.

It needs Node (`npx tsx`), `duckdb` with the spatial extension and
`mapshaper-xl` (`MAPSHAPER=` to point at it). Steps run in order and leave
markers under `<out>/.work/<build>/`: a step needs the one before it done,
`--force` redoes the steps asked for, and a step that runs again makes the
later ones run again, so `release` never packs a build `check` has not seen. A
build id keeps the `--fr-tier`, `--etalab-year` and `--raw` it was cut with:
another value needs a new `--build` (or `--force`, then with every step from
prep). On this Mac (10 cores, 2026-11-01): prep 2 s, simplify 2 s, pack 8 s,
check 9 s, release 3 s. Two builds from the same inputs are byte-identical but
for the manifest's `created`.

## Gates (`check.ts`: a failed gate fails the build and lists its offenders)

1. **Coincidence**, 139 parents. Every `k/fr_dep_*` and `k/fr_com_*`: the self's
   segment set equals the union boundary of its children (the segments drawn
   once among them); children's outer vertices → self 0 m, self vertices →
   children's lines 0 m, shared edge length 100 % (a vertex lies on the lines
   when it is one of their vertices; a stray is measured in local metres).
   Every `k/fr_reg_*`: also equal to the région's own segment set, with the same
   ring and hole counts. `k/FR`: the self's segments are among the régions',
   each of its holes a hole of their union.
2. **Identity**: the same `id@tier` is the same bytes in every file.
3. **Budgets**: a self ≤ 20,000 vertices (also the `ac:relief=serveur` POST body);
   a family over it is cut again by ONE joint mapshaper run (région +
   départements + communes, `combine-files`) at the smallest of 30, 50, 100,
   300 m that fits, tier `fam<m>`. A bundle ≤ 120,000 vertices and ≤ 1.5 MB, a
   file ≤ 5 MB, ≤ 1,000 files: over a cap fails the build (no coarser bundle:
   it would break the one-cut rule of its parent's lid edge).
4. **Ids**: every région and département of `apps/api/src/modules/geo/frDepartments.ts`
   has a row; Etalab units it lacks are warnings; no id twice; every parent
   exists; every commune and arrondissement of `scripts/seed/fixtures/fr-units.json`
   is an entry of a `k/fr_dep_*` or `k/fr_com_*`.
5. **Closure**: every `k`/`u`/`g` flag of a row or entry has its file and every
   file a flag; a row's `st` and `bbox` are its self file's; every `n` is its
   geometry's vertex count; every file passes `validateFileV1`.
6. **Validity**: finite coordinates, latitudes within ±85.0511, longitudes
   within ±180, closed rings of ≥ 4 positions without repeated points, one
   winding per file, DuckDB `ST_IsValid` on every distinct geometry. This
   DuckDB spatial has no `ST_IsValidReason`, so an offender's reason is coarse:
   "a ring intersects itself" or "rings touch, cross or nest wrongly", told
   apart by whether its boundary is simple.

Results of `o20261101-1`: all six pass. 139 of 139 parents at 0 m / 0 m / 100 %
with equal segment sets; 35,176 distinct geometries valid. One escalation:
**987 Polynésie française** (30,499 vertices delivered, 48 communes) → `fam100`,
13,839 vertices (30 m gives 25,904, 50 m 20,780). Closest to the budget at
`e50`: 988 Nouvelle-Calédonie 18,859 (margin 1,141), 984 TAAF 17,522 (margin
2,478). The heaviest bundle is 52,092 vertices (Côte-d'Or), the largest file
1,158,428 B (Pas-de-Calais).

Absent ids: none of the 38 commune and arrondissement ids of the seed fixture.
Warnings: régions and départements 984, 986, 987, 988, 989 (TAAF, Wallis et
Futuna, Polynésie française, Nouvelle-Calédonie, Clipperton) are not in
`frDepartments.ts`. Oddities: Etalab already cuts TAAF (984, Adélie Land) at
85.05° S; that région overlaps Overture's Antarctica over about 337,000 km²,
which matters to the country build, not here.

`-clean` on the `fr1000` run: keep-shapes alone left Nouvelle-Calédonie with a
hole crossing its island at 1000 m (`ST_IsValid` false) and seven slivers
between régions; `-clean` removes five of them and keeps the 26 régions.

## Sizes of `o20261101-1`

277 files, 84.1 MB raw, 25.6 MB gzip (level 9, per file).

| kind | files | raw min / median / p95 / max | gzip min / median / p95 / max |
|---|---|---|---|
| `root.json` | 1 | 26,735 | 6,486 |
| `k/FR` | 1 | 185,560 | 62,930 |
| `k/fr_reg_*` | 26 | 2,029 / 350,641 / 775,934 / 824,766 | 491 / 108,312 / 234,882 / 247,814 |
| `k/fr_dep_*` | 109 | 2,032 / 652,810 / 1,053,342 / 1,158,428 | 495 / 197,470 / 313,228 / 356,136 |
| `k/fr_com_*` | 3 | 11,171 / 16,182 / 47,245 | 2,246 / 3,306 / 9,594 |
| `u/fr_reg_*` | 26 | 1,026 / 115,823 / 366,978 / 412,394 | 418 / 37,143 / 104,371 / 114,088 |
| `u/fr_dep_*` | 109 | 1,026 / 43,393 / 103,054 / 412,394 | 418 / 13,820 / 31,172 / 114,088 |

The city bundles: Lyon 11,171 / 2,246 B, Paris 16,182 / 3,306 B, Marseille
47,245 / 9,594 B gzip. Marseille is above the ≤ 8 KB gzip the plan expected
(16 arrondissements and a long coast); no cap is involved.

`k/FR`: self 1,645 vertices, 31,764 B / 12,009 B gzip; its 26 régions 7,338
vertices, 49,089 B gzip.

Against the S3 spike's children-only bundles (`{"<id>": geometry}`, Etalab as
delivered): the children's vertex counts equal Etalab's in every `e50` file
(108 départements, the 3 cities), every self's `n` equals Etalab's (or the
dissolve's), and the children-only bytes are the spike's within 0.03 % raw and
0.9 % gzip (Auvergne-Rhône-Alpes 158,277 against 159,681 B gzip, −0.88 %). The
plan's own bar, the children's geometry bytes without keys (the sum of
`JSON.stringify(unit.g)`) within 2 % of S3's, holds for five of the six and
misses for Lyon at −2.29 %: S3's figure counts each child's id, which weighs
most beside Lyon's nine short geometries; the like-for-like construct matches.

| bundle | children | S3 children-only raw / gz | this build, same construct | whole file raw / gz |
|---|---|---|---|---|
| Rhône `k/fr_dep_69` | 266 | 328,814 / 95,152 | 328,815 / 95,149 | 402,292 / 118,968 |
| Finistère `k/fr_dep_29` | 277 | 685,449 / 203,393 | 685,449 / 203,393 | 855,800 / 256,944 |
| Pas-de-Calais `k/fr_dep_62` | 887 | 969,003 / 293,237 | 969,003 / 293,237 | 1,158,428 / 356,136 |
| Côte-d'Or `k/fr_dep_21` | 698 | 963,834 / 295,795 | 963,834 / 295,795 | 1,124,403 / 350,307 |
| Auvergne-Rhône-Alpes `k/fr_reg_84` | 12 | 497,051 / 159,681 | 497,054 / 158,277 | 687,699 / 215,331 |
| Lyon `k/fr_com_69123` | 9 | 6,428 / 1,631 | 6,426 / 1,633 | 11,171 / 2,246 |

Bundles over 300 KB gzip (all under the 400 KB flip gate): `k/fr_dep_62`
356,136 · `k/fr_dep_21` 350,307 · `k/fr_dep_71` 335,816 · `k/fr_dep_57` 326,406 ·
`k/fr_dep_02` 325,541 · `k/fr_dep_24` 313,228 · `k/fr_dep_80` 305,682 ·
`k/fr_dep_988` 302,653.

## Cutting a release

The build step `release` does the first three:

1. `COPYFILE_DISABLE=1 tar --no-xattrs -czf outlines-<build>.tar.gz -C <out> <build>`
   (macOS bsdtar adds `._*` entries otherwise);
2. assert the tarball's file entries = the manifest's `files`;
3. `shasum -a 256` and the lock JSON `{build, asset, sha256}` (printed and
   written to `<out>/outlines-<build>.lock.json`);
4. the owner publishes it: `gh release create outlines-<build> <out>/outlines-<build>.tar.gz`
   (never from a build script or an agent without his yes);
5. bump `apps/web/outlines.lock.json` (created by the outline-store PR) to the
   lock JSON, in a PR of its own.

`o20261101-1`: `{"build":"o20261101-1","asset":"outlines-o20261101-1.tar.gz","sha256":"812c041b46075c52a7571c9fdb43d50e43c0d886790fdab5d3f939ad1c79760b"}`.

## Not here

Country outlines (the next PR: Overture, the tier ladder, `g/`), world
subdivisions, communes at Etalab's 5 m (a later `--communes 5m` flag would cut
bundles from the finer vintage), tiles, CI.
