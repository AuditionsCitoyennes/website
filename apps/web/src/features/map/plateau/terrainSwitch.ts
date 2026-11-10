// Whether the map may stand the plateau on elevated terrain this page load.
//
// Mapbox GL refuses elevated terrain in a browser that adds noise to canvas
// reads (fingerprinting protection: Safari's advanced protection or a privacy
// extension, Brave shields, Firefox strict): its style reads a small gradient
// back from an OffscreenCanvas once, and on any deviation drops every
// `setTerrain` silently and warns once, « Terrain and hillshade are disabled
// because of Canvas2D limitations when fingerprinting protection is enabled
// (e.g. in private browsing mode). » This module runs the same read before the
// map is made (canvasReadsNoisy); with noise the page stands no plateau: the
// outline, its grey and the hover fill are drawn flat (useScopeMask), and the
// plateau run, the DEM slots, the lid's hidden map, the relief worker and the
// mesh worker never start (usePlateau, GeoDrillMap).
//
// Forced in the builds with the testing tools — the dev server and staging
// (__TEST_TOOLS__, vite.config), kept in localStorage like the plateau mesh's
// mode (meshSwitch.ts) and drawn as the Témoignages page's DEV switch's
// "Relief" row:
//
// - "auto" (the default): elevated terrain unless the canvas reads are noisy.
// - "off": the flat drawing whatever the browser (our path only: Mapbox is
//   not made to refuse anything, nothing of ours asks it for terrain).
//
// Read once per page load: switching reloads the page. Production has neither
// key nor switch: DEFAULT_TERRAIN_MODE, and the canvas read alone.

export type TerrainMode = "auto" | "off";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_TERRAIN_MODE: TerrainMode = "auto";

export const TERRAIN_MODES: readonly TerrainMode[] = ["auto", "off"];

function storedTerrainMode(): TerrainMode {
  try {
    const raw = localStorage.getItem("ac:terrain");
    return (TERRAIN_MODES as readonly string[]).includes(raw ?? "")
      ? (raw as TerrainMode)
      : DEFAULT_TERRAIN_MODE;
  } catch {
    return DEFAULT_TERRAIN_MODE;
  }
}

/** This page load's mode. */
export const terrainMode: TerrainMode = __TEST_TOOLS__ ? storedTerrainMode() : DEFAULT_TERRAIN_MODE;

/** Another mode: kept, and the page loaded again with it. */
export function setTerrainMode(mode: TerrainMode) {
  if (!__TEST_TOOLS__ || mode === terrainMode) return;
  try {
    localStorage.setItem("ac:terrain", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}

/**
 * Mapbox GL's own test (3.34.1 `hasCanvasFingerprintNoise`, not exported):
 * an 85×1 OffscreenCanvas filled with a gradient of one-pixel rects, read
 * back; true when any red, green or blue byte differs from what was drawn.
 * False without OffscreenCanvas or createImageBitmap (Mapbox then runs no
 * test either) and when anything throws. The drift guard in
 * terrainSwitch.test.ts pins Mapbox's text.
 */
export function canvasReadsNoisy(g: typeof globalThis = globalThis): boolean {
  try {
    const Offscreen = g.OffscreenCanvas;
    if (!Offscreen || typeof g.createImageBitmap !== "function") return false;
    if (!new Offscreen(1, 1).getContext("2d")) return false;
    const canvas = new Offscreen(255 / 3, 1);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    let inc = 0;
    for (let i = 0; i < canvas.width; ++i) {
      ctx.fillStyle = `rgba(${inc++},${inc++},${inc++}, 255)`;
      ctx.fillRect(i, 0, 1, 1);
    }
    const read = ctx.getImageData(0, 0, canvas.width, canvas.height);
    inc = 0;
    for (let i = 0; i < read.data.length; ++i) {
      if (i % 4 !== 3 && inc++ !== read.data[i]) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function terrainAvailableFor(mode: TerrainMode, noisy: boolean): boolean {
  return mode !== "off" && !noisy;
}

/** This page's canvas reads, as Mapbox will judge them (read once, at this module's load). */
export const canvasNoise: boolean = canvasReadsNoisy();

/** Whether the map may stand the plateau on elevated terrain this page load. */
export const terrainAvailable: boolean = terrainAvailableFor(terrainMode, canvasNoise);
