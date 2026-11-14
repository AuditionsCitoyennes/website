import { noteRenderer } from "@/shared/device/deviceTier";

// Whether the browser makes a WebGL 2 context (the live map, Mapbox GL JS 3,
// needs one), probed once on a throwaway canvas and released at once; the
// renderer's name read on the way is handed to the device tier
// (shared/device/deviceTier.ts: a software renderer is the tier "minimal").
// For the home page's card under the "auto" policy (homeMapPolicy.ts), right
// before it would be lent: a visitor who never heads there pays nothing.

let probed: boolean | undefined;

export function probeWebgl2(): boolean {
  if (probed !== undefined) return probed;
  probed = false;
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (gl) {
      probed = true;
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const name: unknown = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
      noteRenderer(typeof name === "string" && name ? name : null);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    /* no WebGL 2 here */
  }
  return probed;
}
