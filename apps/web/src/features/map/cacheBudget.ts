// How much the map keeps in memory to come back faster to a place already
// seen:
//
// - Mapbox's tiles, per source, once they leave a map's view: the visible
//   map's (`mapTiles`) and the lid's hidden map's (`lidTiles`). Mapbox's own
//   sizing is five times the tiles a view holds (30 a source on a 360 × 740
//   phone, 60 on a 1440 × 900 window); a kept tile holds its parsed data and
//   its graphics buffers.
// - The plateau meshes the mesh worker holds for the page, in vertices
//   (`meshVertices`: gl/meshClientCore.ts, 250-350 bytes of its heap each).
// - The relief of the selections already raised: the versions and the
//   projected vertices the relief worker stores (`reliefVersions`,
//   `reliefVertices`: relief/demWorkerCore.ts), the selections the page keeps
//   to send again (`reliefRecords`: relief/demAnswer.ts, each with its JSON
//   text) and the tile answers it keeps (`reliefTiles`: relief/demTiles.ts).
//
// - LARGE_CACHES on a device whose tier is "full".
// - SMALL_CACHES, a third to a fifth of them, on a device whose tier is
//   "light" or "minimal" (shared/device/deviceTier). A place seen long ago is
//   fetched from the browser's cache and parsed again, or its mesh and relief
//   sent again, where the large sizes still held it: a short wait there, less
//   memory.
//
// Mapbox reads its tile cache size when a map is created. The mesh and relief
// sizes are read at each use, with the device's tier of that moment.
//
// The sizes are numbers here, not imports of the modules they bound: those
// are the workers' code, which this module's readers must not pull into the
// page (cacheBudget.test.ts ties the large sizes to the modules' own
// constants). Loadable under node: nothing run at load.
import { deviceTier, probeRenderer } from "../../shared/device/deviceTier";

export interface CacheBudget {
  /** The visible map's `maxTileCacheSize`; null: Mapbox's own sizing. */
  mapTiles: number | null;
  /** The lid's hidden map's `maxTileCacheSize`; null: Mapbox's own sizing. */
  lidTiles: number | null;
  /** Vertices of plateau meshes the mesh worker holds for the page. */
  meshVertices: number;
  /** Selections the relief worker stores, and their projected vertices. */
  reliefVersions: number;
  reliefVertices: number;
  /** Selections the page keeps to send to the relief worker again. */
  reliefRecords: number;
  /** Relief tile answers the page keeps. */
  reliefTiles: number;
}

/** A device of the tier "full"'s. */
export const LARGE_CACHES: CacheBudget = {
  mapTiles: null,
  lidTiles: null,
  meshVertices: 300_000,
  reliefVersions: 40,
  reliefVertices: 1_000_000,
  reliefRecords: 40,
  reliefTiles: 2000,
};

/** A weak device's. The tiles: about two views of a phone for the visible
 *  map (the level just left stays, for the way back), one shot's worth for
 *  the hidden one. */
export const SMALL_CACHES: CacheBudget = {
  mapTiles: 12,
  lidTiles: 6,
  meshVertices: 60_000,
  reliefVersions: 12,
  reliefVertices: 250_000,
  reliefRecords: 12,
  reliefTiles: 500,
};

/** The sizes on a device of this tier. */
export function cacheBudgetFor(tier: "full" | "light" | "minimal"): CacheBudget {
  return tier === "full" ? LARGE_CACHES : SMALL_CACHES;
}

/** The sizes now: the device's tier of the moment. */
export function cacheBudgetNow(): CacheBudget {
  return cacheBudgetFor(deviceTier());
}

/** The sizes for a map about to be created. The graphics chip's name is read
 *  first, from a throwaway context (once per page): the visible map has no
 *  context yet, and Mapbox reads the size at creation only. */
export function cacheBudgetAtCreation(): CacheBudget {
  probeRenderer();
  return cacheBudgetNow();
}

/** The Mapbox option of a tile budget: none for Mapbox's own sizing. */
export function tileCacheOption(tiles: number | null): { maxTileCacheSize?: number } {
  return tiles === null ? {} : { maxTileCacheSize: tiles };
}
