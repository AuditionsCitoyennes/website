// How much the map keeps in memory to come back faster to a place already
// seen (`ac:map-caches`, the Témoignages page's DEV dialog, « Mémoire »):
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
// - "large": the sizes before this switch, on every device.
// - "small": a third to a fifth of them. A place seen long ago is fetched from
//   the browser's cache and parsed again, or its mesh and relief sent again,
//   where "large" still held it: a short wait there, less memory everywhere.
// - "auto" (the default): "small" on a device whose tier is "light" or
//   "minimal" (shared/device/deviceTier), "large" on every other.
//
// The choice is read once per page load (switching reloads: Mapbox reads its
// tile cache size when a map is created). The mesh and relief sizes are read
// at each use, with the device's tier of that moment. Production has neither
// key nor switch: DEFAULT_MAP_CACHES.
//
// The sizes are numbers here, not imports of the modules they bound: those
// are the workers' code, which this module's readers must not pull into the
// page (cacheBudget.test.ts ties "large" to the modules' own constants).
// Loadable under node: nothing run at load but the switch's read.
import { deviceTier, probeRenderer } from "../../shared/device/deviceTier";

export type MapCaches = "auto" | "large" | "small";

/** The choice of a build without the testing tools, and the switch's default. */
export const DEFAULT_MAP_CACHES: MapCaches = "auto";

export const MAP_CACHES: readonly MapCaches[] = ["auto", "large", "small"];

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

/** The sizes before this switch. */
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

/** The kept choice, else the default (garbage or blocked storage too). */
export function storedMapCaches(): MapCaches {
  try {
    const raw = localStorage.getItem("ac:map-caches");
    return (MAP_CACHES as readonly string[]).includes(raw ?? "")
      ? (raw as MapCaches)
      : DEFAULT_MAP_CACHES;
  } catch {
    return DEFAULT_MAP_CACHES;
  }
}

/** This page load's choice. */
export const mapCaches: MapCaches = __TEST_TOOLS__ ? storedMapCaches() : DEFAULT_MAP_CACHES;

/** Another choice: kept, and the page loaded again with it. */
export function setMapCaches(choice: MapCaches) {
  if (!__TEST_TOOLS__ || choice === mapCaches) return;
  try {
    localStorage.setItem("ac:map-caches", choice);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}

/** The sizes of a choice on a device of this tier. */
export function cacheBudgetFor(choice: MapCaches, tier: "full" | "light" | "minimal"): CacheBudget {
  if (choice === "large") return LARGE_CACHES;
  if (choice === "small") return SMALL_CACHES;
  return tier === "full" ? LARGE_CACHES : SMALL_CACHES;
}

/** The sizes now: this page load's choice, the device's tier of the moment. */
export function cacheBudgetNow(): CacheBudget {
  return cacheBudgetFor(mapCaches, deviceTier());
}

/** The sizes for a map about to be created. Under "auto" the graphics chip's
 *  name is read first, from a throwaway context (once per page): the visible
 *  map has no context yet, and Mapbox reads the size at creation only. */
export function cacheBudgetAtCreation(): CacheBudget {
  if (mapCaches === "auto") probeRenderer();
  return cacheBudgetNow();
}

/** The Mapbox option of a tile budget: none for Mapbox's own sizing. */
export function tileCacheOption(tiles: number | null): { maxTileCacheSize?: number } {
  return tiles === null ? {} : { maxTileCacheSize: tiles };
}
