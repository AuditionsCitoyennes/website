// The map's WebGL context, lost and given back (lib/contextWatch.ts): mapbox
// rebuilds what is its own and does not run onAdd again for a custom layer,
// so on its `webglcontextrestored` the map's two custom layers are set up
// again and the lid's picture is taken again:
//
//  1. "tint": the flat view's grey sheet (useScopeMask, ScopeTintLayer.onAdd);
//  2. "plateau": the walls, the lid's mesh, the boundary lines, the hover
//     fill, the halo and the slabs' pieces, in both regimes
//     (PlateauWallLayer.onContextRestored) — and whatever that layer's onAdd
//     sets up besides;
//  3. "lid": the picture on the plateau's top, shot again when a plateau
//     stands (usePlateauLid.onContextRestored): its texture cannot be
//     uploaded again, the bitmap was closed.
//
// The meshes are the ones the page still holds: nothing is built again, no
// selection is run again, the camera does not move. A step that throws is
// reported and the others still run.

import type mapboxgl from "mapbox-gl";
import { perfNote, perfOn } from "@/shared/perf/perf";
import type { PlateauWallLayer } from "../gl/PlateauWallLayer";
import { createContextWatch, type ContextState } from "../lib/contextWatch";
import type { usePlateau } from "./usePlateau";
import type { usePlateauLid } from "./usePlateauLid";
import type { useScopeMask } from "./useScopeMask";

export interface ContextRestoreInputs {
  getMap: () => mapboxgl.Map | null;
  /** The plateau's layer. */
  wall: Pick<PlateauWallLayer, "onContextRestored">;
  /** The grey sheet's owner. */
  mask: Pick<ReturnType<typeof useScopeMask>, "onContextRestored">;
  lid: Pick<ReturnType<typeof usePlateauLid>, "onContextRestored">;
  plateau: Pick<ReturnType<typeof usePlateau>, "active" | "seq" | "raised">;
}

export function useContextRestore({ getMap, wall, mask, lid, plateau }: ContextRestoreInputs) {
  const watch = createContextWatch(
    [
      { name: "tint", run: () => mask.onContextRestored() },
      {
        name: "plateau",
        run: () => {
          const gl = getMap()?.getCanvas().getContext("webgl2");
          if (gl) wall.onContextRestored(gl);
        },
      },
      {
        name: "lid",
        run: () => {
          if (plateau.active()) lid.onContextRestored(plateau.seq(), plateau.raised());
        },
      },
    ],
    (name, err) => console.error(`Map context restore, step "${name}" failed:`, err),
  );

  /** Hear this map's context events (once, when the map is created). */
  function attach(map: mapboxgl.Map) {
    map.on("webglcontextlost", () => {
      watch.lost();
      if (perfOn) perfNote("gl.contextLost", 0, { losses: watch.state().losses });
    });
    map.on("webglcontextrestored", () => {
      const t0 = performance.now();
      const failed = watch.restored();
      if (perfOn) {
        perfNote("gl.contextRestored", performance.now() - t0, {
          restores: watch.state().restores,
          failed: failed.join(","),
        });
      }
    });
  }

  return {
    attach,
    /** The context's share of the __acPlateau probe. */
    probe: (): ContextState => watch.state(),
  };
}
