#!/usr/bin/env bash
# Step `simplify` of build-outlines.sh: the mapshaper runs over <work>/prep.
#   simplify.sh <work-dir> <fr-tier-metres>
# - fr<m>: ONE Douglas-Peucker run (keep-shapes) over the 26 régions, then
#   France's own outline as the dissolve of the 13 mainland ones from that
#   run: k/FR's edge and its régions' lines are the same segments. -clean
#   after the run: at 1000 m keep-shapes left Nouvelle-Calédonie with a hole
#   crossing its island (ST_IsValid false), and slivers between régions.
# - e50: each région's own outline as the dissolve of its départements as
#   delivered (no simplification).
# - fam<m>: a family prep.ts listed (région + départements + communes), one
#   joint run with combine-files (shared arcs across the three levels) at
#   each tolerance of 30, 50, 100, 300 m; pack.ts keeps the smallest that fits.
# - w<m>: the six world runs, one per rung of the country tier ladder (15, 30,
#   100, 300, 1000, 3000 m), each ONE run over every country (shared borders
#   stay shared). -clean allow-overlaps mends most rings keep-shapes leaves
#   crossed and keeps the countries' overlapping claims as delivered; pack.ts
#   repairs what is still invalid once unwrapped.
set -euo pipefail
WORK="$1"
FR_TIER="$2"
MAPSHAPER="${MAPSHAPER:-$HOME/.cache/ac-map-data/tools/node_modules/.bin/mapshaper-xl}"
P="$WORK/prep"
S="$WORK/simp"
mkdir -p "$S"
OUT=(format=geojson ndjson precision=0.00001)

"$MAPSHAPER" -i "$P/regions.ndjson" -simplify dp interval="$FR_TIER" keep-shapes -clean \
  -o "$S/fr$FR_TIER-regions.ndjson" "${OUT[@]}" \
  -filter 'Number(code) >= 10 && Number(code) < 100' -dissolve \
  -o "$S/fr$FR_TIER-self.ndjson" "${OUT[@]}"

"$MAPSHAPER" -i "$P/deps.ndjson" -dissolve parent -o "$S/e50-region-selves.ndjson" "${OUT[@]}"

while IFS= read -r r; do
  [ -n "$r" ] || continue
  for m in 30 50 100 300; do
    d="$S/fam$m-$r"
    mkdir -p "$d"
    "$MAPSHAPER" -i "$WORK/fam/$r/regions.ndjson" "$WORK/fam/$r/deps.ndjson" \
      "$WORK/fam/$r/communes.ndjson" combine-files \
      -simplify dp interval="$m" keep-shapes -o "$d/" "${OUT[@]}"
    for f in regions deps communes; do mv "$d/$f.json" "$d/$f.ndjson"; done
    "$MAPSHAPER" -i "$d/deps.ndjson" -dissolve parent -o "$d/region-selves.ndjson" "${OUT[@]}"
  done
done < "$P/families.txt"

for m in 15 30 100 300 1000 3000; do
  "$MAPSHAPER" -i "$P/world.ndjson" -simplify dp interval="$m" keep-shapes -clean allow-overlaps \
    -o "$S/w$m.ndjson" "${OUT[@]}"
done
