#!/usr/bin/env bash
# The static outline build of docs/map-outlines.md: pre-cut files, one per
# parent, holding its own outline AND its children's from ONE cut, so a
# raised unit's lid edge and the lines lifted onto it are the same segments.
#
# Source: Etalab contours-administratifs at 50 m (Licence Ouverte), the
# régions, départements and communes (with the 45 arrondissements) that
# build-boundaries.sh's etalab step downloads into <raw>.
#
# Steps (each leaves a marker under <out>/.work/<build>; --force redoes them):
#   prep      Etalab → the site's unit ids, 5-decimal coordinates (prep.ts)
#   simplify  mapshaper: k/FR's tier, the régions' dissolves, the families
#             over the self budget (simplify.sh)
#   pack      the files of format v1 into <out>/<build>/ (pack.ts)
#
# Tools: Node (npx tsx), mapshaper-xl (MAPSHAPER=/path/to/mapshaper-xl to
# override).
# Usage:
#   scripts/map-data/outlines/build-outlines.sh [--out DIR] [--build o20261102-1]
#     [--raw DIR] [--fr-tier 1000|300] [--steps prep,simplify,pack] [--force]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HOME/.cache/ac-map-data/outlines"
RAW="$HOME/.cache/ac-map-data/raw"
BUILD="o$(date +%Y%m%d)-1"
FR_TIER=1000
STEPS="prep,simplify,pack"
FORCE=0
export MAPSHAPER="${MAPSHAPER:-$HOME/.cache/ac-map-data/tools/node_modules/.bin/mapshaper-xl}"

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --build) BUILD="$2"; shift 2 ;;
    --raw) RAW="$2"; shift 2 ;;
    --fr-tier) FR_TIER="$2"; shift 2 ;;
    --steps) STEPS="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$FR_TIER" in 1000|300) ;; *) echo "--fr-tier is 1000 or 300" >&2; exit 2 ;; esac
case "$BUILD" in o[0-9]*-[0-9]*) ;; *) echo "--build looks like o20261102-1" >&2; exit 2 ;; esac
if [ ! -x "$MAPSHAPER" ]; then
  echo "mapshaper-xl not found at $MAPSHAPER — npm install mapshaper, then MAPSHAPER=<path>/mapshaper-xl" >&2
  exit 1
fi
for f in regions departements communes; do
  [ -s "$RAW/etalab-$f-50m.geojson" ] || {
    echo "missing $RAW/etalab-$f-50m.geojson — scripts/map-data/build-boundaries.sh --steps etalab" >&2
    exit 1
  }
done

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
RAW="$(cd "$RAW" && pwd)"
WORK="$OUT/.work/$BUILD"
mkdir -p "$WORK"
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
tsx() { (cd "$HERE" && npx tsx "$@"); }
step() { # name command...
  local name="$1"
  shift
  case ",$STEPS," in *",$name,"*) ;; *) return 0 ;; esac
  if [ "$FORCE" = 0 ] && [ -f "$WORK/.done-$name" ]; then
    log "step $name: already done, skipping (--force to redo)"
    return 0
  fi
  log "step $name"
  local t=$SECONDS
  "$@"
  echo "$name $((SECONDS - t)) s" >> "$WORK/times.txt"
  log "step $name: $((SECONDS - t)) s"
  touch "$WORK/.done-$name"
}

step prep tsx prep.ts "$RAW" "$WORK"
step simplify "$HERE/simplify.sh" "$WORK" "$FR_TIER"
step pack tsx pack.ts "$WORK" "$OUT" "$BUILD" "$FR_TIER" "$("$MAPSHAPER" -v)"
log "done: $OUT/$BUILD"
