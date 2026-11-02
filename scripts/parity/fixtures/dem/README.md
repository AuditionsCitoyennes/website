# DEM test fixtures

The selections the relief renderer's tests raise (`apps/web/src/features/map/relief/demRaster.test.ts`).
Each file is one line of GeoJSON.

## Generated

Synthetic, written by a one-off script kept outside the repository: `cull-edge.geojson` (around the z8 tile corner in
its `corner` property: for z 8 to 12, 3-texel squares whose box sits 0, 0.5, 1 and 1.5 texels inside
or outside the padded edge of each tile meeting there, plus an anchor square).
