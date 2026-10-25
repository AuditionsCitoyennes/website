// A PMTiles archive laid over the map, to check that Mapbox GL JS loads one
// (docs/map-roadmap-2026-10-25.md, phase 0: the tileset scripts/map-data
// builds). Testing tools only (__TEST_TOOLS__): `?pmtiles=<url of a .pmtiles>`
// in the address adds it as a vector source — mapbox-gl resolves the tile
// provider from the file's extension and loads its PMTiles plugin in the
// worker (config.TILE_PROVIDER_URLS) — and draws every level as lines. The
// time to the first tiles is a perf span (`pmtiles.firstTiles`), and
// `window.__acPmtiles` tells what was asked and what arrived.

import type mapboxgl from "mapbox-gl";
import { perfSpan } from "@/shared/perf/perf";

const SOURCE = "dev-pmtiles";
/** The levels the build writes, each a source layer, and a colour each. */
const LEVELS: { layer: string; color: string; width: number }[] = [
  { layer: "country", color: "#ffffff", width: 1.6 },
  { layer: "region", color: "#ffd166", width: 1.1 },
  { layer: "county", color: "#ef8354", width: 0.9 },
  { layer: "localadmin", color: "#4cc9f0", width: 0.7 },
  { layer: "locality", color: "#f72585", width: 0.6 },
];

/** Add the archive named in the address, if any. Called once the style has loaded. */
export function installPmtilesProbe(map: mapboxgl.Map) {
  if (!__TEST_TOOLS__) return;
  const url = new URLSearchParams(location.search).get("pmtiles");
  if (!url || map.getSource(SOURCE)) return;
  const state = {
    url,
    loaded: false,
    firstTilesMs: null as number | null,
    tiles: 0,
    errors: [] as string[],
    layers: [] as string[],
  };
  (window as unknown as { __acPmtiles?: unknown }).__acPmtiles = state;
  const end = perfSpan("pmtiles.firstTiles", { url });
  map.on("error", (e) => {
    const msg = e.error?.message ?? String(e.error);
    if (/pmtiles|TileProvider|dev-pmtiles/i.test(msg)) state.errors.push(msg);
  });
  map.on("sourcedata", (e) => {
    if (e.sourceId !== SOURCE) return;
    if (e.tile) state.tiles++;
    if (!state.loaded && e.isSourceLoaded && state.tiles > 0) {
      state.loaded = true;
      end({ tiles: state.tiles });
      state.firstTilesMs = Math.round(performance.now());
      console.info(`[pmtiles] ${url}: first tiles in, ${state.tiles} so far`);
    }
  });
  // The extension (.pmtiles) picks the provider; `provider` says so explicitly
  // for a URL that hides it (a query string, a redirect).
  map.addSource(SOURCE, {
    type: "vector",
    url,
    provider: "pmtiles",
  } as unknown as mapboxgl.SourceSpecification);
  for (const l of LEVELS) {
    const id = `${SOURCE}-${l.layer}`;
    map.addLayer({
      id,
      type: "line",
      source: SOURCE,
      "source-layer": l.layer,
      paint: { "line-color": l.color, "line-width": l.width, "line-opacity": 0.9 },
    });
    state.layers.push(id);
  }
  console.info(`[pmtiles] source added: ${url}`);
}
