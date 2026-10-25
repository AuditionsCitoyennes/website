// A PMTiles archive laid over the map, to check that Mapbox GL JS loads one
// (docs/map-roadmap-2026-10-25.md, phase 0: the tileset scripts/map-data
// builds). Testing tools only (__TEST_TOOLS__): `?pmtiles=<url of a .pmtiles>`
// in the address adds it as a vector source — mapbox-gl resolves the tile
// provider from the file's extension and loads its PMTiles plugin in the
// worker (config.TILE_PROVIDER_URLS) — and draws every level as lines.
// `window.__acPmtiles` says what was asked and what came: the time to the
// first view's tiles (also a perf span, `pmtiles.firstTiles`), the tiles
// requested and the ones that arrived with data, and every error the source
// raised (a CORS refusal, a 404, a server without byte ranges), which are
// also warned in the console — the map has error listeners, so mapbox itself
// would print nothing.

import type mapboxgl from "mapbox-gl";
import { perfOn, perfSpan } from "@/shared/perf/perf";

const SOURCE = "dev-pmtiles";
/** The levels the build writes, each a source layer, and a colour each. */
const LEVELS: { layer: string; color: string; width: number }[] = [
  { layer: "country", color: "#ffffff", width: 1.6 },
  { layer: "region", color: "#ffd166", width: 1.1 },
  { layer: "county", color: "#ef8354", width: 0.9 },
  { layer: "localadmin", color: "#4cc9f0", width: 0.7 },
  { layer: "locality", color: "#f72585", width: 0.6 },
];

/** A source's `data` and `error` events, as mapbox fires them. */
interface SourceEvent {
  sourceId?: string;
  sourceDataType?: string;
  tile?: { tileID?: { key?: string | number } };
  coord?: { key?: string | number };
  error?: { message?: string };
}

/** Add the archive named in the address, if any. Called once the style has loaded. */
export function installPmtilesProbe(map: mapboxgl.Map) {
  if (!__TEST_TOOLS__) return;
  const url = new URLSearchParams(location.search).get("pmtiles");
  if (!url || map.getSource(SOURCE)) return;
  const t0 = performance.now();
  const seen = new Set<string | number>();
  const state = {
    url,
    /** The first view's tiles are in (the source reports itself loaded). */
    loaded: false,
    /** Since the source was added, ms. */
    firstViewMs: null as number | null,
    /** Tile requests the source made (a reload counts again). */
    requests: 0,
    /** Distinct tiles that arrived with data. */
    tiles: 0,
    errors: [] as string[],
    layers: [] as string[],
  };
  (window as unknown as { __acPmtiles?: unknown }).__acPmtiles = state;
  const end = perfOn ? perfSpan("pmtiles.firstTiles", { url }) : null;
  map.on("error", (e: SourceEvent) => {
    if (e.sourceId !== SOURCE) return;
    const msg = e.error?.message ?? "error";
    state.errors.push(msg);
    console.warn(`[pmtiles] ${url}: ${msg}`);
  });
  map.on("sourcedata", (e: SourceEvent) => {
    if (e.sourceId !== SOURCE) return;
    if (e.tile) {
      state.requests++;
      const key = e.tile.tileID?.key ?? e.coord?.key;
      if (e.sourceDataType !== "error" && key !== undefined && !seen.has(key)) {
        seen.add(key);
        state.tiles++;
      }
    }
    const loaded = (e as { isSourceLoaded?: boolean }).isSourceLoaded;
    if (!state.loaded && loaded && state.tiles > 0) {
      state.loaded = true;
      state.firstViewMs = Math.round(performance.now() - t0);
      end?.({ tiles: state.tiles, requests: state.requests });
      console.info(`[pmtiles] ${url}: first view in ${state.firstViewMs} ms, ${state.tiles} tiles`);
    }
  });
  // The extension (.pmtiles) picks the provider; `provider` says so explicitly
  // for a URL that hides it (a query string, a redirect).
  map.addSource(SOURCE, { type: "vector", url, provider: "pmtiles" });
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
