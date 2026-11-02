#!/usr/bin/env bash
# The static outline build (docs/map-outlines.md) on the staging site, for
# .github/workflows/deploy-staging-web.yml: the build apps/web/outlines.lock.json
# names, from its GitHub release, served by the site itself under
# /map-data/outlines/<build>/ (the web's default base: VITE_MAP_DATA_BASE unset).
#
#   outlines.sh fetch     before the web build: checks the lock, downloads the
#                         release's tarball into $WORK, checks its sha256 and
#                         its layout (one <build>/ directory, nothing else)
#   outlines.sh install   after it: unpacks the tarball into $DIST, checks the
#                         files against the build's manifest, marks /map-data/*
#                         immutable in $DIST/_headers
#
# Every miss fails the deploy with an ::error:: line: no skip, no fallback. A
# build not released yet, a release GitHub cannot be reached for and an API
# error all fail the same way (docs/map-outlines.md "Hosting": release first,
# lock bump second).
#
# Environment: LOCK (default apps/web/outlines.lock.json), DIST (default
# apps/web/dist), WORK (where the tarball waits between the two calls, the same
# for both: default $RUNNER_TEMP, else a new temporary directory),
# GITHUB_REPOSITORY (gh's --repo, when set). OUTLINES_TARBALL takes the tarball
# from that local file instead of the release (a dry run, the test; never in
# the workflow).
set -euo pipefail

LOCK=${LOCK:-apps/web/outlines.lock.json}
DIST=${DIST:-apps/web/dist}
WORK=${WORK:-${RUNNER_TEMP:-$(mktemp -d)}}

fail() {
  echo "::error::$*" >&2
  exit 1
}

# The lock's three fields, each checked: build, asset, sha256.
read_lock() {
  [ -f "$LOCK" ] || fail "$LOCK missing"
  build=$(jq -er '.build | select(type == "string" and test("^o[0-9]{8}-[0-9]+$"))' "$LOCK") ||
    fail "$LOCK: \"build\" is not o<YYYYMMDD>-<n>"
  asset=$(jq -er --arg a "outlines-$build.tar.gz" '.asset | select(. == $a)' "$LOCK") ||
    fail "$LOCK: \"asset\" is not outlines-$build.tar.gz"
  sha256=$(jq -er '.sha256 | select(type == "string" and test("^[0-9a-f]{64}$"))' "$LOCK") ||
    fail "$LOCK: \"sha256\" is not 64 lowercase hex digits"
  tarball="$WORK/$asset"
}

fetch() {
  local listing tops odd
  read_lock
  mkdir -p "$WORK"
  if [ -n "${OUTLINES_TARBALL:-}" ]; then
    cp "$OUTLINES_TARBALL" "$tarball" || fail "outline build $build: no file $OUTLINES_TARBALL"
  else
    gh release download "outlines-$build" -p "$asset" -D "$WORK" --clobber \
      ${GITHUB_REPOSITORY:+--repo "$GITHUB_REPOSITORY"} ||
      fail "outline build $build not released (release outlines-$build, asset $asset): see docs/map-outlines.md \"Hosting\""
  fi
  [ -f "$tarball" ] ||
    fail "outline build $build not released (release outlines-$build, asset $asset): see docs/map-outlines.md \"Hosting\""

  if command -v sha256sum > /dev/null; then
    echo "$sha256  $tarball" | sha256sum -c - || fail "$asset: sha256 is not the lock's $sha256"
  else
    echo "$sha256  $tarball" | shasum -a 256 -c - || fail "$asset: sha256 is not the lock's $sha256"
  fi

  # The layout build-outlines.sh release cuts: `tar -czf … -C <out> <build>`.
  listing=$(tar -tzf "$tarball") || fail "$asset: not a readable .tar.gz"
  tops=$(cut -d/ -f1 <<< "$listing" | sort -u)
  [ "$tops" = "$build" ] || fail "$asset: an entry outside $build/: $(grep -Ev "^$build(/|\$)" <<< "$listing" | head -3 | tr '\n' ' ')"
  odd=$(grep -E '(^|/)\.\.(/|$)|(^|/)\._' <<< "$listing" | head -3 | tr '\n' ' ' || true)
  [ -z "$odd" ] || fail "$asset: a .. or ._* entry: $odd"
  # Plain files and directories only: a link would be uploaded as what it points to.
  odd=$(tar -tvzf "$tarball" | grep -Ev '^[-d]' | head -3 | tr '\n' ' ' || true)
  [ -z "$odd" ] || fail "$asset: an entry that is not a file or a directory: $odd"
  echo "outline build $build: $asset checked, $(grep -cv '/$' <<< "$listing") files"
}

install() {
  local dir files all largest bytes path
  read_lock
  [ -f "$DIST/_headers" ] || fail "$DIST/_headers missing: run after Build"
  [ -f "$tarball" ] || fail "$tarball missing: run fetch first, with the same WORK"
  mkdir -p "$DIST/map-data/outlines"
  # The tarball's top directory is already <build>/.
  tar -xzf "$tarball" -C "$DIST/map-data/outlines"
  dir="$DIST/map-data/outlines/$build"
  [ -f "$dir/root.json" ] || fail "outline build $build: no $dir/root.json"
  jq -e --arg b "$build" '.v == 1 and .build == $b' "$dir/manifest.json" > /dev/null ||
    fail "outline build $build: manifest.json is not v1 of build $build"
  jq -e --arg b "$build" '.v == 1 and .build == $b' "$dir/root.json" > /dev/null ||
    fail "outline build $build: root.json is not v1 of build $build"
  files=$(find "$dir" -type f | wc -l | tr -d ' ')
  [ "$files" = "$(jq -r .files "$dir/manifest.json")" ] ||
    fail "outline build $build: $files files, the manifest says $(jq -r .files "$dir/manifest.json")"

  # Build-versioned URLs: a file never changes under its name.
  printf '\n/map-data/*\n  Cache-Control: public, max-age=31536000, immutable\n' >> "$DIST/_headers"

  all=$(find "$DIST" -type f | wc -l | tr -d ' ')
  read -r bytes path < <(find "$dir" -type f -exec wc -c {} + | awk '$2 != "total"' | sort -n | tail -1)
  largest=${path#"$dir/"}
  echo "outline build $build: $files files in $dir, $all files in $DIST, largest $largest ($bytes B)"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'build=%s\nlargest=%s\n' "$build" "$largest" >> "$GITHUB_OUTPUT"
  fi
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### Outline build"
      echo ""
      echo "| | |"
      echo "|---|---|"
      echo "| Build | \`$build\` |"
      echo "| Outline files | $files |"
      echo "| Files in dist | $all |"
      echo "| Largest outline file | \`$largest\`, $bytes B |"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

case "${1:-}" in
  fetch) fetch ;;
  install) install ;;
  *)
    echo "usage: outlines.sh fetch|install" >&2
    exit 2
    ;;
esac
