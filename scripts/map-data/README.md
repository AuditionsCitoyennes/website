# scripts/map-data

Builds the worldwide boundary tileset of docs/map-roadmap-2026-10-25.md once, to
measure it (phase 0). Nothing here runs in production or in CI; the outputs (a
few GB) stay outside the repo. The numbers it produced are in
docs/map-perf-baseline-2026-10.md.

- `build-boundaries.sh` — Overture Maps divisions (world) + Etalab
  contours-administratifs (France) → mapshaper per zoom band → tippecanoe →
  `boundaries.pmtiles`, then a report (bytes per zoom, features per level, depth
  per country, largest features). `--help` lists the options.
- `overture.sql` — the DuckDB pass over Overture: one land polygon per division
  for country, dependency, region, county, localadmin, locality; the parent from
  the division table; the count tables.

Tools, on macOS:

```bash
brew install duckdb tippecanoe pmtiles
npm install -g mapshaper
```

Then, for instance:

```bash
scripts/map-data/build-boundaries.sh --out "$TMPDIR/ac-map-data" --release 2026-10-21.0
```

To look at the result in the site: serve the output directory with range
requests and CORS (any static server does; `npx serve --cors <dir>`), run the
dev server and open `/temoignages?pmtiles=http://127.0.0.1:<port>/boundaries.pmtiles`:
GeoDrillMap adds the archive as a vector source and draws its levels as lines
(the builds with the testing tools: the dev server and staging, `__TEST_TOOLS__`).
