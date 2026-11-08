# Static outlines (map item 3)

`scripts/map-data/outlines/` cuts France's administrative outlines and the
world's countries into static files that replace `/api/boundaries` (a runtime
merge of commune contours, France only). Each French file belongs to one parent
and holds the parent's own outline **and** its children's, from one cut: a
raised unit's lid edge and the lines lifted onto it are the same segments.
Every country (Overture's 272 countries and dependencies) gets its outline at a
tier fitted to its size, for its plateau, and a coarse one for the globe. Tiles cannot do that (they clip, and they
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
| `root.json` | `{v, build, tiers, units: [row…]}`: France, 26 régions, 109 départements, 271 other countries and dependencies (407 rows) | — |
| `k/FR.json` | self = the 13 mainland régions dissolved after ONE Douglas-Peucker run (1000 m, keep-shapes, then `-clean`) over the 26 régions; units = those 26 régions | `fr1000` (`--fr-tier 300`: `fr300`) |
| `k/fr_reg_<r>.json` (26) | self = the région's départements dissolved; units = the départements | `e50` |
| `k/fr_dep_<d>.json` (109) | self = the Etalab département; units = its communes (not the arrondissements) | `e50` |
| `k/fr_com_<c>.json` (3) | Paris, Lyon, Marseille: self = the commune (its entry in `k/fr_dep_*`); units = its arrondissements | `e50` |
| `u/fr_reg_*`, `u/fr_dep_*` (135) | the unit's self alone, byte-identical to the self of its `k/` file | as `k/` |
| `g/<ISO>.json` (272) | the country from the 3000 m world run, France's too (Overture's France: the métropole and Corsica) | `w3000` |
| `u/<ISO>.json` (271, not FR) | the country at its own tier (the ladder below) | `c15` … `c3000` |
| `manifest.json` | build, date, sources, sha256 of each input, the mapshaper, DuckDB and spatial versions, counts, bytes, file count | |
| `NOTICE.txt` | Etalab Licence Ouverte credit (with © OpenStreetMap contributors, ODbL 1.0, for the collectivités d'outre-mer 975, 977, 978, 986); Overture Maps Foundation and © OpenStreetMap contributors, ODbL 1.0, for the country files and the country rows of `root.json` | |

`e50` is Etalab's own 50 m generalisation, rounded to 5 decimals (`tolM: 0`).
A family whose self exceeds 20,000 vertices is cut again as `fam<m>`. Shapes:

```
k: {"v":1,"build":"o20261101-1","kind":"k","id":"fr:dep:69","tier":"e50","tolM":0,
    "self":{"id":"fr:dep:69","bbox":[w,s,e,n],"center":[lat,lng],"n":1669,"g":{"type":"Polygon",…}},
    "units":[{"id":"fr:com:69123","name":"Lyon","level":"city","k":1,"u":0,"bbox":[…],"center":[…],"n":160,"g":{…}}, …]}
u: {"v":1,"build","kind":"u","id","tier","tolM","self":{…},"wrap"?:1}
g: {"v":1,"build","kind":"g","id":"ES","tier":"w3000","tolM":3000,"self":{…},"wrap"?:1}
root: {"v":1,"build","tiers":{"<tag>":{"tolM":<m>,"source":"etalab-50m"|"overture"}},"units":[row…]}
row: {"id","parent","level","name","bbox","center","st":"<self tier>","k":0|1,"u":0|1,"g":0|1,"wrap"?:1}
```

A country's row: `id` is its ISO code, `parent` null (dependencies too: the
site's dependencies are roots), `level` `country`, `name` Overture's primary name
(local language, «Россия»; the site shows its own French label), `k:0, u:1,
g:1`, `st` its `u/` tier. France stays one row, `k/FR`'s, with `g:1`.

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

Once a year, when Etalab publishes a vintage (or for a new Overture release:
`build-boundaries.sh --steps extract,chunks` writes `raw/country/world.geojson`,
then `--overture-release <release>` here). `build-boundaries.sh`'s etalab
step downloads only the files missing from `raw/` and skips itself once done,
so remove the old files and force it:

```bash
rm ~/.cache/ac-map-data/raw/etalab-{regions,departements,communes}-50m.geojson
scripts/map-data/build-boundaries.sh --out ~/.cache/ac-map-data --steps etalab --etalab-year <year> --force
scripts/map-data/outlines/build-outlines.sh --build o<YYYYMMDD>-1 --etalab-year <year>
#   [--out DIR] [--raw DIR] [--fr-tier 1000|300] [--steps prep,simplify,pack,check,release] [--force]
```

`--etalab-year` (default 2026) and `--overture-release` (default 2026-10-21.0)
are what the manifest's `sources` and `NOTICE.txt` name; the manifest also holds
the sha256 of each input and the versions of the tools that shape the geometry:
`mapshaper`, `duckdb` (`duckdb --version`) and `spatial` (the extension's
`extension_version`), since pack's DuckDB repair reshapes a few countries.

It needs Node (`npx tsx`), `duckdb` with the spatial extension and
`mapshaper-xl` (`MAPSHAPER=` to point at it). Steps run in order and leave
markers under `<out>/.work/<build>/`: a step needs the one before it done,
`--force` redoes the steps asked for, and a step that runs again makes the
later ones run again, so `release` never packs a build `check` has not seen. A
build id keeps the `--fr-tier`, `--etalab-year`, `--overture-release` and
`--raw` it was cut with: another value needs a new `--build` (or `--force`, then
with every step from prep). On this Mac (10 cores, 2026-11-02, `nice -n 10`
while other jobs held the load average at 10-17): prep 14 s, simplify 36 s (the
six world runs about 5 s each), pack 49 s (the DuckDB repair included), check
18 s, release 5 s. France alone took 2 / 2 / 8 / 9 / 3 s. Two builds from the
same inputs are byte-identical but for the manifest's `created` (checked again
for `o20261101-2`).

## Gates (`check.ts`: a failed gate fails the build and lists its offenders)

1. **Coincidence**, 139 parents. Every `k/fr_dep_*` and `k/fr_com_*`: the self's
   segment set equals the union boundary of its children (the segments drawn
   once among them); children's outer vertices → self 0 m, self vertices →
   children's lines 0 m, shared edge length 100 % (a vertex lies on the lines
   when it is one of their vertices; a stray is measured in local metres).
   Every `k/fr_reg_*`: also equal to the région's own segment set, with the same
   ring and hole counts. `k/FR`: the self's segments are among the régions',
   each of its holes a hole of their union.
2. **Identity**: the same `id@tier` is the same bytes in every file; a country's
   `u/` at `c3000` is its `g/` (one run).
3. **Budgets**: a self ≤ 20,000 vertices (also the `ac:relief=serveur` POST body);
   a family over it is cut again by ONE joint mapshaper run (région +
   départements + communes, `combine-files`) at the smallest of 30, 50, 100,
   300 m that fits, tier `fam<m>`. A bundle ≤ 120,000 vertices and ≤ 1.5 MB, a
   file ≤ 5 MB, ≤ 1,000 files: over a cap fails the build (no coarser bundle:
   it would break the one-cut rule of its parent's lid edge).
4. **Ids**: every région and département of `apps/api/src/modules/geo/frDepartments.ts`
   has a row; Etalab units it lacks are warnings; no id twice; every parent
   exists; every commune and arrondissement of `scripts/seed/fixtures/fr-units.json`
   is an entry of a `k/fr_dep_*` or `k/fr_com_*`; every country of the world
   input has a row with `g:1`.
5. **Closure**: every `k`/`u`/`g` flag of a row or entry has its file and every
   file a flag; a row's `st`, `bbox` and `wrap` are its self file's (`u/`, else
   `k/`); a file has `wrap` exactly when its own geometry passes ±180 or its largest
   polygon spans it (a `g/` is another run: it can lack its `u/`'s); every `n` is its
   geometry's vertex count; every file passes `validateFileV1`.
6. **Validity**: finite coordinates, latitudes within ±85.0511, longitudes
   within ±180 unless the file has `wrap`, closed rings of ≥ 4 positions without repeated points, one
   winding per file, DuckDB `ST_IsValid` on every distinct geometry. This
   DuckDB spatial has no `ST_IsValidReason`, so an offender's reason is coarse:
   "a ring intersects itself" or "rings touch, cross or nest wrongly", told
   apart by whether its boundary is simple.
7. **Known oddities**, printed, never failures (see Countries).

Results of `o20261101-2`: all six pass, 35,719 distinct geometries valid; the
French part is `o20261101-1`'s, whose results follow. Results of `o20261101-1`: all six pass. 139 of 139 parents at 0 m / 0 m / 100 %
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

## Countries

**Input**: `raw/country/world.geojson`, 272 features (219 `country`, 53
`dependency`), one per ISO code; `prep.ts` checks that no ring crosses ±180.

**Six world runs** (`simplify.sh`): Douglas-Peucker `keep-shapes` at 15, 30,
100, 300, 1000 and 3000 m, each ONE run over every country (shared borders stay
shared), then `-clean allow-overlaps`. Plain runs at 15 and 3000 m left 15 and 18 countries
invalid (the delivered outlines at 5 decimals already have 28);
`allow-overlaps` keeps overlapping claims as delivered, where a plain `-clean`
would hand each overlap to one country. Holes: the delivered outlines have 231;
DP alone at 3000 m keeps 59 (Baarle's enclaves collapse at that scale), and
`-clean` then removes 44 that DP crossed, in the countries it left invalid: 15
stay (Lesotho in South Africa and San Marino and the Vatican in Italy among
them). At the finer rungs `-clean` also turns a few rings DP crossed into small
holes (213 at 15 m against 196 for plain DP): three `u/` files keep one where
the delivered outline has none, AU (`c1000`), MM (`c300`) and NI (`c100`), each
under 1 km².

**Repair** (`pack.ts`): DuckDB still finds 16 of the 1,632 country geometries
invalid once unwrapped: Russia and Fiji at every rung (their pieces met on ±180
and now share that edge) and the United States from 15 to 300 m (at 15 m: three
polygons with a pinched or crossed ring `-clean` leaves). Those, and only
those, become the polygons of `ST_MakeValid`, snap-rounded to 5 decimals by
`ST_ReducePrecision`: the antimeridian pieces merge, no segment stays shared.

**Tier ladder**: `diag` is the bbox diagonal in metres of the unwrapped
delivered outline; the tier is the largest rung at most `diag / 4000` (about
half a pixel when the country fills a 2000 px screen), 15 m at least, raised
while the self is over 20,000 vertices; still over at 3000 m fails the build.
`w3000` and `c3000` are the same run, so a `c3000` country's `u/` and `g/`
geometries are the same bytes.

| tier | countries |
|---|---|
| `c15` | 64 (Monaco, the Vatican, Malta, Luxembourg…: `diag / 4000` < 15 m for 43 of them; 108 countries are under 100 m) |
| `c30` | 44 |
| `c100` | 76 |
| `c300` | 71 |
| `c1000` | 11: AR AU BR CL CN GL ID IN KI NO TF |
| `c3000` | 5: AQ CA RU UM US |

Raised by the vertex budget: Canada 1000 → 3000 m (47,514 vertices at 1000 m),
Russia 1000 → 3000 (22,282), the United States 1000 → 3000 (26,379), Greenland
300 → 1000 (37,151), Norway 300 → 1000 (26,867). Heaviest country selves:
Indonesia 18,744 (`c1000`), Chile 16,401, Sweden 14,192, Australia 14,090.

**Wrap**: each polygon moves by ±360 toward the longitude of the largest
polygon's centroid, coordinates rounded again, `wrap:1` on each file where a
polygon moved and on the row when its `u/` has it, and `bbox` and the tier pick
read the unwrapped outline (longitudes past
±180). Unwrapped: Russia (19.6 .. 191.0), Fiji (176.9 .. 181.8), Kiribati
(-190.5 .. -150.2), New Zealand (165.9 .. 184.2), the United States (-187.6 ..
-66.9). Antarctica cannot be: its largest polygon spans -180 .. 180; it stays
as delivered with `wrap:1` and a 360° bbox.

`keep-shapes` keeps every country, not every polygon of one: small islands go
at the coarse tiers (164 of 271 countries keep all their polygons at their `u/`
tier; Canada keeps 620 of 18,175). The United States Minor Outlying Islands are
the extreme: unwrapped they span Wake to Navassa (13,178 km), so `c3000`, where
only Wake survives (4 vertices); no polygon is then left to unwrap.

| kind | files | raw min / median / p95 / max | gzip min / median / p95 / max | self vertices min / median / p95 / max |
|---|---|---|---|---|
| `root.json` | 1 | 79,025 | 22,927 | — |
| `g/<ISO>` | 272 | 303 / 2,397 / 29,826 / 285,999 | 209 / 973 / 10,816 / 104,257 | 4 / 104 / 1,440 / 13,445 |
| `u/<ISO>` | 271 | 317 / 34,125 / 187,834 / 389,638 | 213 / 11,730 / 64,505 / 133,156 | 4 / 1,719 / 9,076 / 18,744 |

The 272 `g/` files together: 2,319,979 B raw, 874,836 B gzip (per file; the S3
spike's world at 3000 m as one file: 2,273,862 / 843,159). `root.json` is above
the ~15-20 KB gzip the plan expected.

| country | diag | tier | `u/` vertices · raw / gzip | `g/` vertices · raw / gzip |
|---|---|---|---|---|
| Monaco | 3.8 km | `c15` | 37 · 926 / 400 | 4 · 303 / 209 |
| Luxembourg | 99 km | `c15` | 1,970 · 37,211 / 11,765 | 21 · 630 / 352 |
| Switzerland | 410 km | `c100` | 2,374 · 45,164 / 15,598 | 121 · 2,529 / 1,077 |
| Germany | 1,073 km | `c100` | 6,133 · 118,991 / 41,218 | 443 · 8,849 / 3,409 |
| Spain | 2,706 km | `c300` | 3,885 · 76,726 / 27,460 | 483 · 9,835 / 3,839 |
| Japan | 3,701 km | `c300` | 12,939 · 271,968 / 88,670 | 1,406 · 29,826 / 10,816 |
| Brazil | 6,506 km | `c1000` | 7,246 · 152,593 / 52,745 | 2,071 · 43,897 / 16,359 |
| Indonesia | 5,454 km | `c1000` | 18,744 · 389,638 / 133,156 | 5,733 · 119,547 / 42,903 |
| Russia | 10,147 km | `c3000` | 7,213 · 147,474 / 56,967 | the same |
| Canada | 6,464 km | `c3000` | 13,445 · 285,999 / 104,256 | the same |
| Antarctica | 12,170 km | `c3000` | 2,806 · 60,492 / 22,617 | the same |

**Known oddities** (gate 7): Saint-Martin (MF) is a `country` in Overture, not a
dependency. The 13 French overseas codes (GP MQ GF RE YT PM BL MF WF PF NC TF CP)
are rows of their own; no site unit uses them (the site files overseas France
under FR), and the design's merge of them under `FR` is not done here. Etalab's
région 984 (TAAF) overlaps Antarctica: gate 7 measures 337,387 km² between
`k/fr_reg_984`'s self and `u/AQ` (DuckDB `ST_Area_Spheroid`). Antarctica cannot
be unwrapped. Overture's France (`g/FR`) is the métropole and Corsica only.

## Sizes of `o20261101-1`

The French files of `o20261101-2` are `o20261101-1`'s but for the build id (274
of 274 compared), so these figures hold for both.

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
4. the owner publishes it, with the command under Hosting (never from a build
   script or an agent without his yes);
5. bump `apps/web/outlines.lock.json` (created by the outline-store PR) to the
   lock JSON, in a PR of its own.

`o20261101-1`: `{"build":"o20261101-1","asset":"outlines-o20261101-1.tar.gz","sha256":"812c041b46075c52a7571c9fdb43d50e43c0d886790fdab5d3f939ad1c79760b"}`.

`o20261101-2` (France and countries, 820 files, 100.2 MB raw, 31.1 MB gzip per
file, tarball 31,678,383 B):
`{"build":"o20261101-2","asset":"outlines-o20261101-2.tar.gz","sha256":"4aa259c3801d5966098b1da8938f6e88a5a3df43d1ba9353d7c968eef7b55dbf"}`.
Its NOTICE.txt carries the ODbL notice the country files need: publish it with
the release (`--notes-file`). Released 2026-11-02; the web's lock names it since
pr-outline-world (the countries' outlines under `ac:contours=fichiers`).

## Hosting

Staging and every pull request's preview serve the locked build themselves,
same origin, at `/map-data/outlines/<build>/` (the web's default base:
`VITE_MAP_DATA_BASE` unset). `.github/workflows/deploy-staging-web.yml` runs
`scripts/deploy/outlines.sh`:

- `fetch`, before the web build: reads `apps/web/outlines.lock.json` (`build`
  `o<YYYYMMDD>-<n>`, `asset` `outlines-<build>.tar.gz`, `sha256` 64 hex
  digits), downloads the asset of the release `outlines-<build>` with `gh`,
  checks its sha256 and its layout (one top directory `<build>/`, no `..`, no
  `._*`, files and directories only);
- `install`, after it: unpacks it into `apps/web/dist/map-data/outlines/`,
  checks `root.json` and `manifest.json` (`v` 1, the lock's build) and the file
  count against the manifest's `files`, and adds to `dist/_headers`
  `/map-data/*  Cache-Control: public, max-age=31536000, immutable` (a URL
  names its build: a file never changes under it);
- "Check the site", after the deploy: `root.json` must come back as that
  build's JSON, `application/json`, immutable, or the deploy fails; it then
  records compression and the missing-file answer in the run's summary.

Every miss fails the deploy: a lock missing or malformed, a release or asset
missing (or GitHub unreachable: the same error), a hash or layout mismatch, a
manifest that is not the lock's build, a file count off. There is no skip: a
deploy without the files would draw no outline at all. Nothing builds outlines
in CI.

The web reads the files under the server source, the only outlines it has
(`/api/boundaries` is no longer called; the corpus source and the comparer, the
testing tools' data sources, draw none). A session whose files are not served
(`root.json` missing, HTML or another build, the boot past its 6 s cap, or a
release skew on a later file) falls back for that page load: every unit known
absent — the box fits, the pins, the panel and its lists unchanged, no plateau
and no outline line — with one console warning in every build,
`[outlines] fallback: <reason> <url>`.

**Production has no deploy yet** (`apps/web/wrangler.jsonc` is staging only).
Whoever adds it MUST copy the staging workflow's two steps
(`scripts/deploy/outlines.sh fetch` / `install`) and its fail-closed
`root.json` check (the deploy fails when the lock's release is missing or
`root.json` is served as HTML): without the files every production page pays
two `root.json` requests (the second with `cache: "reload"`, the release-skew
confirm) and falls back for the session: no plateau, no outline anywhere. R2
only when world subdivisions or tiles arrive.

### Local development

The dev server has no outline files of its own: without them every session
falls back (no plateau; the console warning names this section). Either:

- put the locked build under `apps/web/public/map-data/outlines/` (gitignored),
  which Vite serves at `/map-data/` with a JSON content type, so no variable is
  needed (`npm run build` then copies it into `dist`: harmless locally, CI
  starts clean):

  ```bash
  WORK=/tmp/outlines scripts/deploy/outlines.sh fetch   # the lock's release, hash-checked
  mkdir -p apps/web/public/map-data/outlines
  tar -xzf /tmp/outlines/outlines-<build>.tar.gz -C apps/web/public/map-data/outlines
  ```

- or serve the build elsewhere (a static server over a directory holding
  `outlines/<build>/`, CORS on) and set `VITE_MAP_DATA_BASE` in
  `apps/web/.env` to it (e.g. `http://127.0.0.1:5399/`).

### Lock bump: release first, lock bump second

Every lock bump (France now, France and the countries next, the yearly
rebuild) needs `outlines-<build>` released BEFORE the bump merges: a lock on
`dev` pointing at a build not released turns every web deploy red, `dev`'s
pushes and every pull request's preview alike (the lock is under
`apps/web/**`). A lock-bump PR's own preview stays red until the release
exists: that red is the gate. Never delete a release a lock on `dev`, or an
open PR, still points at.

The owner's release, from the build's directory:

```bash
cd ~/.cache/ac-map-data/outlines
shasum -a 256 outlines-<build>.tar.gz      # must equal "sha256" in apps/web/outlines.lock.json
gh release create outlines-<build> outlines-<build>.tar.gz --repo AuditionsCitoyennes/website \
  --title "Outline build <build>" --notes-file <build>/NOTICE.txt --latest=false --target dev
```

The tarball must be the very file the lock was written from: gzip is not
reproducible, so it is never cut again after the lock bump (if it was, run the
build's `release` step again and bump the lock again). It is the only asset
(the lock holds the hash). `--latest=false` keeps the repository's "Latest
release" for real releases. Before the countries are first served publicly
(production, not staging), the owner confirms how the ODbL derived-database
obligation is met (`NOTICE.txt` ships inside the served build; the release's
visibility).

### Previous build: not hosted

One build per deploy. After a lock bump, a tab still open on the previous
deploy asks for `/map-data/outlines/<old>/…`, which the new deploy does not
hold. What it gets is the missing-file answer below: on Cloudflare, the app's
page (200, HTML), for the app's `fetch` as for a navigation (the preview run
of 2026-11-02, all three rows). The outline store takes it as a release skew
and the tab falls back for its session until it reloads: no plateau, every
unit known absent. Not decided yet, and due before the next lock bump: either
the previous build is hosted too (a `previous` key in the lock: +277 files for
`o20261101-1`, about 830 for France and the countries) or the founder accepts
one degraded session per tab left open across a lock bump. A deploy that keeps
the lock's build changes nothing for an open tab.

### Limits and what a deploy uses

Documented (Cloudflare, [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
read 2026-11-02), Workers static assets: 20,000 files per Worker version on
the Free plan, 100,000 on Paid (Wrangler ≥ 4.34.0; the workflow pins
4.152.0); 25 MiB per file on both; 100 `_headers` rules. The account is on the
Free plan (the owner, 2026-11-02): 20,000 files per Worker version.

Accepted, measured on the preview run of 2026-11-02 (`o20261101-1`, run
41465659773): 346 files in `dist` (277 outline files, 69 of the site), the
largest outline file `k/fr_dep_62.json`, 1,158,428 B; `_headers` holds 2
rules. Wrangler: "Found 277 new or modified static assets to upload" (the
site's files were already held), then "Uploaded 277 of 277 assets". The push
path prints the same lines from `wrangler deploy`.

File budget against the Free plan's 20,000: France 277 + the countries 543
(`o20261101-2`, the lock's since pr-outline-world; its install step, run
locally on 2026-11-03, printed "820 files in …/o20261101-2, 879 files in
apps/web/dist, largest k/fr_dep_62.json (1158428 B)") + the planned gazetteer
(2 × at most 9,000) +
the site (59) ≈ 18,900 with one outline build; hosting the previous build too
adds up to 820 more, 19,700. Close to the ceiling: the gazetteer's plan, or
the Paid plan, decides it before both land.

Compression and the missing file, on Cloudflare (the preview run of
2026-11-02, Wrangler 4.152.0; every deploy's summary repeats the measurement
for its own build). Cloudflare answers brotli to `Accept-Encoding: gzip, br`;
`wrangler dev --local` had answered gzip at 2 to 15 % more bytes.

| file | content-encoding | wire bytes br / identity | ratio |
|---|---|---|---|
| `root.json` | br | 6,522 / 26,735 | 4.10x |
| `k/fr_dep_69.json` (Rhône) | br | 103,854 / 402,292 | 3.87x |
| `k/fr_dep_62.json` (the largest) | br | 333,601 / 1,158,428 | 3.47x |

A missing file (`k/fr_dep_zz.json`) on Cloudflare: 200, `text/html`,
`Cache-Control: public, max-age=31536000, immutable`, with no
`Sec-Fetch-Mode`, with `cors` (the app's `fetch`) and with `navigate` alike.
So the Worker (`main` in `wrangler.jsonc`) is not reached for a path under
`/map-data/`: the assets layer answers first and its `not_found_handling`
serves the app's page, under the `/map-data/*` rule. The outline store takes
that HTML as a release skew (`features/geo/outlineLoader.ts`), which ends
the session (the fallback), never as a per-file `missing`.

A browser keeps that HTML for a year under that URL. Harmless for a URL that
names its build (the app and its files ship in one Worker version, so the
app never asks for a file its build lacks), and the loader asks once more
past the HTTP cache (`cache: "reload"`) before it takes an HTML answer as a
release skew, so a cached page never ends a session on its own. No narrower
`_headers` rule helps: every pattern also matches a missing file. A Worker
that answers 404 itself for unknown `/map-data/` paths would need
`run_worker_first` in `wrangler.jsonc`; not done here (web code).

## Previous source: /api/boundaries (removed in #176)

Before the outline files, the API served the outlines itself:
`/api/boundaries/{metropole,regions,departements}` from three files vendored
under `apps/api/data/france-geojson/`, and `/departement/:code`,
`/communes?codes=` and `/commune/:code` from the Géo API (geo.api.gouv.fr),
kept in a disk cache (`apps/api/.boundaries-cache/`) and a 32 MB heap LRU. The
module, the vendored files and the cache went in #176; git history keeps
them. A developer's stale `apps/api/.boundaries-cache*` can be deleted
(`rm -rf apps/api/.boundaries-cache*`; still gitignored).

The vendored levels' origin, from their README:

- Repository: [gregoiredavid/france-geojson](https://github.com/gregoiredavid/france-geojson)
  (Grégoire David), branch `master`, fetched 2026-10-21: the métropole's
  contour (one Feature, no properties; the API named it `FR` / `France`), the
  13 metropolitan régions and the 96 metropolitan départements, the
  `*-version-simplifiee.geojson` files.
- Lines: IGN, [Admin Express COG](https://geoservices.ign.fr/adminexpress), 2018
  edition, converted to GeoJSON with Mapshaper ("visvalingam weighted"
  simplification at 25 %, coordinates at 5 decimals), as that repository
  publishes them. Names and codes: INSEE, Code Officiel Géographique, 2018.
- Licence: [Licence Ouverte / Open Licence (Etalab)](https://www.etalab.gouv.fr/licence-ouverte-open-licence),
  Admin Express's terms. The credit line it asked for, verbatim:
  « Source : IGN — Admin Express COG 2018, via france-geojson (Grégoire David) — Licence Ouverte ».

md5 of the files as fetched:

| File | md5 |
| --- | --- |
| `metropole-version-simplifiee.geojson` | `5b50944d1ca5e003c3275e6e76d5615f` |
| `regions-version-simplifiee.geojson` | `275e39e649b090b9a8dd957659f8d611` |
| `departements-version-simplifiee.geojson` | `7999bd8fa3567d938032da52f6a9bfdf` |

## Not here

The 13 French overseas codes merged under `FR`, world subdivisions (their
place writer comes first), communes at Etalab's 5 m (a later `--communes 5m` flag would cut
bundles from the finer vintage), tiles, CI.
