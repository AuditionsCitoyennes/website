// What the plateau stands on, by the device's tier (shared/device/deviceTier):
//
// - "relief", on a device whose tier is "full": the ground rises with the
//   plateau — the unit's own DEM (the relief worker's tiles) as the map's
//   terrain, its exaggeration animated, so the map draped under the lid, the
//   pins and the draped colours stand at the plateau's height.
// - "flat", on a "light" or "minimal" device: the ground stays where it is.
//   The wall, the lid, its lines, the grey outside and the rise are the
//   plateau's own layer and do not change; no DEM tile is made, the relief
//   worker is not started, and the map draws without a terrain (on the globe,
//   below zoom 6, mapbox drapes whatever the terrain: there it is a flat
//   one). The pins of the raised unit are lifted to the lid's height and a
//   pointer over the lid reads the lid, so both stay in step with the picture
//   on it. The audit of 2026-11-12 measured it on a slow processor: about
//   60 % less time in long frames over three flights.
//
// Read at each selection, with the device's tier of that moment (a tier
// measured in the first flight applies from the next territory): a plateau
// standing keeps the ground it was raised on.
//
// No import and nothing run at load: loadable under node (groundSwitch.test.ts).

/** What a plateau stands on. */
export type Ground = "relief" | "flat";

/** The ground of a plateau raised now on a device of this tier. */
export function groundFor(tier: "full" | "light" | "minimal"): Ground {
  return tier === "full" ? "relief" : "flat";
}

/** The WebGL renderer's name of a context somebody already has (the map's):
 *  what the device's tier reads to tell a software renderer. Null where the
 *  browser does not say. */
export function rendererOf(
  gl: Pick<WebGLRenderingContext, "getExtension" | "getParameter" | "RENDERER"> | null | undefined,
): string | null {
  if (!gl) return null;
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info") as {
      UNMASKED_RENDERER_WEBGL: number;
    } | null;
    const name: unknown = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}
