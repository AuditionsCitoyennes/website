#!/usr/bin/env bash
# Phase 0 of docs/map-roadmap-2026-10-25.md: build boundaries.pmtiles ONCE to
# measure what phase 2 will serve — bytes per zoom, features per level, the
# deepest level each country has, the largest polygons — and to check that
# Mapbox GL JS loads it (GeoDrillMap's ?pmtiles= dev flag).
#
# Sources
#   - Overture Maps divisions (ODbL), the world: country, dependency, region,
#     county, localadmin, locality — land polygons, one per division, parent
#     from the division table (see overture.sql).
#   - Etalab contours-administratifs (Licence Ouverte), France at 50 m:
#     régions, départements, communes, which REPLACE Overture's French rows at
#     the region, county, localadmin and locality levels (INSEE codes: the ids
#     the site stores). Their ids: fr:reg:84, fr:dep:69, fr:com:69123.
#
# Pipeline, per level: GeoJSON chunks (the world in one file for country and
# region; one file per country for county, localadmin and locality, so that
# mapshaper holds one country at a time — shared borders are simplified
# together inside a chunk, not across two) → mapshaper -clean -simplify per
# zoom band → tippecanoe per (level, band), one layer per level, attributes
# id/name/level/parent/country, --no-simplification-of-shared-nodes →
# tile-join into one boundaries.mbtiles → pmtiles convert → the report.
#
# Outputs go under --out (default $TMPDIR/ac-map-data), never into the repo:
# the raw parquet alone is a few GB. Resumable: every step leaves a marker,
# --force redoes the steps asked for.
#
# Tools (macOS):  brew install duckdb tippecanoe pmtiles
#                 npm install -g mapshaper      (mapshaper-xl: an 8 GB heap)
# Usage:
#   scripts/map-data/build-boundaries.sh [--out DIR] [--release 2026-10-21.0]
#     [--etalab-year 2026] [--steps extract,etalab,simplify,tile,report] [--force]
#     [--jobs 3]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${TMPDIR:-/tmp}/ac-map-data"
RELEASE="2026-10-21.0"
ETALAB_YEAR="2026"
STEPS="extract,etalab,simplify,tile,report"
FORCE=0
JOBS=3
MAPSHAPER="${MAPSHAPER:-mapshaper-xl}"

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --release) RELEASE="$2"; shift 2 ;;
    --etalab-year) ETALAB_YEAR="$2"; shift 2 ;;
    --steps) STEPS="$2"; shift 2 ;;
    --jobs) JOBS="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# ---- Levels and zoom bands ---------------------------------------------------
# Each band "zmin-zmax:metres": the zoom range one simplification serves, and
# the mapshaper interval for it (a 512 px tile: 78 271 m/px at z0, halved per
# zoom). Polygon layers stop EARLY: a polygon layer emits a tile for every
# tile its polygons cover, and the world's land is ~6 million tiles at z12 and
# ~100 million at z14 — a first run with levels to z12–14 crawled for that
# reason. So every level stops between z8 and z10 and the client overzooms;
# tippecanoe keeps full detail at the last zoom (-d 14: 16 384 units per tile,
# ~1.7 m per unit at z10 in France), so a commune outline drawn at z15 from
# its z10 tile is still sub-pixel. The mapshaper interval of the last band is
# therefore the real resolution of a level (5 m for communes, 20 m for
# départements, 100 m for régions).
LEVELS=(country region county localadmin locality)
bands_of() {
  case "$1" in
    country)    echo "0-3:3000 4-6:300 7-8:30" ;;
    region)     echo "2-5:1000 6-9:100" ;;
    county)     echo "4-7:300 8-10:20" ;;
    localadmin) echo "6-9:100 10-10:10" ;;
    locality)   echo "8-9:20 10-10:5" ;;
  esac
}
# Levels exported in one chunk per country (the others: the world in one file).
chunked() { case "$1" in county|localadmin|locality) return 0 ;; *) return 1 ;; esac; }

# ---- Tools -------------------------------------------------------------------
need() {
  command -v "$1" > /dev/null 2>&1 && return 0
  echo "missing tool: $1 — install: $2" >&2
  exit 1
}
need duckdb "brew install duckdb"
need tippecanoe "brew install tippecanoe"
need tile-join "brew install tippecanoe"
need pmtiles "brew install pmtiles"
need "$MAPSHAPER" "npm install -g mapshaper (or MAPSHAPER=/path/to/mapshaper-xl)"
need curl "part of macOS"

mkdir -p "$OUT/raw" "$OUT/simplified" "$OUT/tiles" "$OUT/tmp"
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
has_step() { case ",$STEPS," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
done_marker() { echo "$OUT/.done-$1"; }
skip_done() {
  if [ "$FORCE" = 0 ] && [ -f "$(done_marker "$1")" ]; then
    log "step $1: already done ($(done_marker "$1")), skipping (--force to redo)"
    return 0
  fi
  return 1
}
duck() { duckdb -no-agent "$@"; }

# ---- 1. extract: Overture → local parquet + counts + GeoJSON chunks -----------
if has_step extract && ! skip_done extract; then
  log "extract: Overture $RELEASE divisions → $OUT/raw (one pass over S3)"
  {
    echo "SET VARIABLE release = '$RELEASE';"
    echo "SET VARIABLE out = '$OUT';"
    echo "SET memory_limit = '12GB';"
    echo "SET temp_directory = '$OUT/tmp';"
    cat "$HERE/overture.sql"
  } | duck
  log "extract: GeoJSON chunks per level"
  PARQUET="$OUT/raw/overture-areas.parquet"
  # France's rows below the country come from Etalab (step etalab).
  NOT_FR="NOT (country = 'FR' AND level IN ('region','county','localadmin','locality'))"
  {
    echo "INSTALL spatial; LOAD spatial; SET geometry_always_xy = true;"
    for level in "${LEVELS[@]}"; do
      mkdir -p "$OUT/raw/$level"
      cols="id, name, level, parent, country, geometry"
      if [ "$level" = country ]; then
        # Dependencies ride in the country layer (their level attribute says so).
        echo "COPY (SELECT $cols FROM read_parquet('$PARQUET') WHERE level IN ('country','dependency')) TO '$OUT/raw/country/world.geojson' WITH (FORMAT GDAL, DRIVER 'GeoJSON');"
      elif chunked "$level"; then
        while IFS= read -r cc; do
          [ -n "$cc" ] || continue
          [ "$cc" = FR ] && continue
          echo "COPY (SELECT $cols FROM read_parquet('$PARQUET') WHERE level = '$level' AND country = '$cc') TO '$OUT/raw/$level/$cc.geojson' WITH (FORMAT GDAL, DRIVER 'GeoJSON');"
        done < "$OUT/raw/countries.csv"
      else
        echo "COPY (SELECT $cols FROM read_parquet('$PARQUET') WHERE level = '$level' AND $NOT_FR) TO '$OUT/raw/$level/world.geojson' WITH (FORMAT GDAL, DRIVER 'GeoJSON');"
      fi
    done
  } | duck
  # GDAL writes an empty FeatureCollection for a country without that level:
  # drop those so mapshaper and tippecanoe never see them.
  find "$OUT/raw" -name '*.geojson' -size -200c -delete
  touch "$(done_marker extract)"
fi

# ---- 2. etalab: France at 50 m → chunks of the region/county/locality levels --
if has_step etalab && ! skip_done etalab; then
  BASE="https://etalab-datasets.geo.data.gouv.fr/contours-administratifs/$ETALAB_YEAR/geojson"
  for f in regions-50m departements-50m communes-50m; do
    if [ ! -s "$OUT/raw/etalab-$f.geojson" ]; then
      log "etalab: downloading $f ($ETALAB_YEAR)"
      curl -fsSL --retry 3 -o "$OUT/raw/etalab-$f.geojson.gz" "$BASE/$f.geojson.gz"
      gunzip -f "$OUT/raw/etalab-$f.geojson.gz"
    fi
  done
  FR_COUNTRY_ID="$(duck -csv -noheader -c "SELECT id FROM read_parquet('$OUT/raw/overture-areas.parquet') WHERE level = 'country' AND country = 'FR' LIMIT 1" | tr -d '\r')"
  log "etalab: converting (France's country id in Overture: $FR_COUNTRY_ID)"
  mkdir -p "$OUT/raw/region" "$OUT/raw/county" "$OUT/raw/locality"
  duck <<SQL
INSTALL spatial; LOAD spatial; SET geometry_always_xy = true;
COPY (
  SELECT 'fr:reg:' || code AS id, nom AS name, 'region' AS level, '$FR_COUNTRY_ID' AS parent, 'FR' AS country, geom AS geometry
  FROM ST_Read('$OUT/raw/etalab-regions-50m.geojson')
) TO '$OUT/raw/region/FR.geojson' WITH (FORMAT GDAL, DRIVER 'GeoJSON');
COPY (
  SELECT 'fr:dep:' || code AS id, nom AS name, 'county' AS level, 'fr:reg:' || region AS parent, 'FR' AS country, geom AS geometry
  FROM ST_Read('$OUT/raw/etalab-departements-50m.geojson')
) TO '$OUT/raw/county/FR.geojson' WITH (FORMAT GDAL, DRIVER 'GeoJSON');
COPY (
  SELECT 'fr:com:' || code AS id, nom AS name, 'locality' AS level, 'fr:dep:' || departement AS parent, 'FR' AS country, geom AS geometry
  FROM ST_Read('$OUT/raw/etalab-communes-50m.geojson')
) TO '$OUT/raw/locality/FR.geojson' WITH (FORMAT GDAL, DRIVER 'GeoJSON');
SQL
  touch "$(done_marker etalab)"
fi

# ---- 3. simplify: mapshaper per level, chunk and band --------------------------
simplify_one() { # level band chunkfile
  local level="$1" band="$2" src="$3"
  local zr="${band%%:*}" metres="${band##*:}"
  local name; name="$(basename "$src" .geojson)"
  local dst="$OUT/simplified/$level/z$zr/$name.geojsonl"
  mkdir -p "$(dirname "$dst")"
  [ -s "$dst" ] && [ "$FORCE" = 0 ] && return 0
  "$MAPSHAPER" "$src" -clean -simplify "interval=$metres" keep-shapes \
    -o format=geojson ndjson "$dst" > /dev/null 2> "$dst.log" || {
    echo "mapshaper failed on $src (band $band): $(tail -1 "$dst.log")" >&2
    return 1
  }
  rm -f "$dst.log"
}
export -f simplify_one
export OUT FORCE MAPSHAPER
if has_step simplify && ! skip_done simplify; then
  for level in "${LEVELS[@]}"; do
    for band in $(bands_of "$level"); do
      n="$(find "$OUT/raw/$level" -name '*.geojson' | wc -l | tr -d ' ')"
      log "simplify: $level band $band — $n chunk(s), $JOBS at a time"
      find "$OUT/raw/$level" -name '*.geojson' -print0 \
        | xargs -0 -n 1 -P "$JOBS" -I{} bash -c 'simplify_one "$@"' _ "$level" "$band" {}
    done
  done
  touch "$(done_marker simplify)"
fi

# ---- 4. tile: tippecanoe per (level, band), then one archive ------------------
if has_step tile && ! skip_done tile; then
  for level in "${LEVELS[@]}"; do
    for band in $(bands_of "$level"); do
      zr="${band%%:*}"; zmin="${zr%-*}"; zmax="${zr#*-}"
      out="$OUT/tiles/$level-z$zr.mbtiles"
      log "tile: $level z$zmin-$zmax → $(basename "$out")"
      find "$OUT/simplified/$level/z$zr" -name '*.geojsonl' -print0 \
        | xargs -0 tippecanoe --force -o "$out" -Z "$zmin" -z "$zmax" -l "$level" -n boundaries \
            --no-simplification-of-shared-nodes --detect-shared-borders -d 14 \
            --no-feature-limit --no-tile-size-limit -P --hilbert \
            -y id -y name -y level -y parent -y country \
            --attribution '© Overture Maps Foundation (ODbL), © Etalab / IGN contours-administratifs (Licence Ouverte)' \
            --quiet
    done
  done
  log "tile: tile-join → boundaries.mbtiles → boundaries.pmtiles"
  find "$OUT/tiles" -name '*.mbtiles' -print0 \
    | xargs -0 tile-join --force -o "$OUT/boundaries.mbtiles" -n boundaries --no-tile-size-limit --no-feature-limit
  pmtiles convert "$OUT/boundaries.mbtiles" "$OUT/boundaries.pmtiles"
  touch "$(done_marker tile)"
fi

# ---- 5. report ------------------------------------------------------------------
if has_step report; then
  R="$OUT/report.md"
  {
    echo "# boundaries.pmtiles — build report"
    echo
    echo "Overture release $RELEASE, Etalab contours-administratifs $ETALAB_YEAR (50 m). Built $(date -u +%Y-%m-%dT%H:%MZ)."
    echo
    echo "## Archive"
    echo
    echo '```'
    ls -l "$OUT/boundaries.pmtiles" "$OUT/boundaries.mbtiles" | awk '{print $5, $9}'
    pmtiles show "$OUT/boundaries.pmtiles" | sed -n '1,14p'
    echo '```'
    echo
    echo "## Bytes per zoom (all layers; tiles are gzip-compressed MVT)"
    echo
    duck -markdown -c "INSTALL sqlite; LOAD sqlite;
      SELECT zoom_level AS z, count(*) AS tiles,
             round(sum(octet_length(tile_data)) / 1048576.0, 2) AS mib,
             round(avg(octet_length(tile_data)) / 1024.0, 1) AS avg_kib,
             round(max(octet_length(tile_data)) / 1024.0, 1) AS max_kib
      FROM sqlite_scan('$OUT/boundaries.mbtiles', 'tiles') GROUP BY 1 ORDER BY 1;"
    echo
    echo "## Bytes per level and zoom band"
    echo
    {
      echo "INSTALL sqlite; LOAD sqlite;"
      first=1
      for f in "$OUT"/tiles/*.mbtiles; do
        b="$(basename "$f" .mbtiles)"
        [ $first = 1 ] || echo "UNION ALL"
        first=0
        echo "SELECT '${b%%-z*}' AS level, '${b##*-z}' AS band, zoom_level AS z, count(*) AS tiles, round(sum(octet_length(tile_data)) / 1048576.0, 2) AS mib, round(max(octet_length(tile_data)) / 1024.0, 1) AS max_kib FROM sqlite_scan('$f', 'tiles') GROUP BY 1, 2, 3"
      done
      echo "ORDER BY CASE level WHEN 'country' THEN 0 WHEN 'region' THEN 1 WHEN 'county' THEN 2 WHEN 'localadmin' THEN 3 ELSE 4 END, z;"
    } | duck -markdown
    echo
    echo "## Features per level (Overture, before the French rows are replaced)"
    echo
    duck -markdown -c "SELECT * FROM read_csv('$OUT/raw/features-per-level.csv');"
    echo
    echo "## France (Etalab): features per level"
    echo
    duck -markdown -c "INSTALL spatial; LOAD spatial;
      SELECT 'region' AS level, count(*) AS features, sum(ST_NPoints(geom)) AS vertices FROM ST_Read('$OUT/raw/etalab-regions-50m.geojson')
      UNION ALL SELECT 'county', count(*), sum(ST_NPoints(geom)) FROM ST_Read('$OUT/raw/etalab-departements-50m.geojson')
      UNION ALL SELECT 'locality', count(*), sum(ST_NPoints(geom)) FROM ST_Read('$OUT/raw/etalab-communes-50m.geojson');"
    echo
    echo "## Depth per country: how many countries have each level as their deepest"
    echo
    duck -markdown -c "SELECT deepest, count(*) AS countries FROM read_csv('$OUT/raw/depth-per-country.csv') GROUP BY 1 ORDER BY CASE deepest WHEN 'country' THEN 0 WHEN 'region' THEN 1 WHEN 'county' THEN 2 WHEN 'localadmin' THEN 3 ELSE 4 END;"
    echo
    echo "## Depth per country (full table)"
    echo
    duck -markdown -c "SELECT country, name, top_level, n_region, n_county, n_localadmin, n_locality, deepest FROM read_csv('$OUT/raw/depth-per-country.csv') ORDER BY country;"
    echo
    echo "## Largest features per level (vertices, WKB bytes)"
    echo
    duck -markdown -c "SELECT * FROM read_csv('$OUT/raw/largest-features.csv');"
  } > "$R"
  log "report: $R"
fi
log "done: $OUT"
