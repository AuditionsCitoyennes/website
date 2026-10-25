// The window probes the map exposes for checking it in a browser, composed from
// each composable's share: `__acMap` (the map, DEV), `__acPlateau` (read-only,
// present in production too: the plateau/terrain path only runs in a real
// browser, never in a headless preview, so diagnosing "the map looks
// low-detail" needs a way to read the live state from the console) and
// `__acFrame` (the frame bus, DEV).

import type mapboxgl from "mapbox-gl";
import type { usePlateauFrames } from "../composables/usePlateauFrames";
import type { usePlateau } from "../composables/usePlateau";
import type { usePlateauLid } from "../composables/usePlateauLid";
import type { usePlateauSlabs } from "../composables/usePlateauSlabs";
import { installPerfVocabulary } from "./perfVocabulary";

type Probes = {
  __acMap?: mapboxgl.Map;
  __acPlateau?: () => unknown;
  __acFrame?: () => unknown;
};

export interface ProbeSources {
  getMap: () => mapboxgl.Map | null;
  frames: Pick<ReturnType<typeof usePlateauFrames>, "probe">;
  plateau: Pick<ReturnType<typeof usePlateau>, "probe">;
  lid: Pick<ReturnType<typeof usePlateauLid>, "probe">;
  slabs: Pick<ReturnType<typeof usePlateauSlabs>, "probe">;
}

/** Install the probes; returns what unmount calls (the frame probe is removed,
 *  the others stay, as before). */
export function installProbes({ getMap, frames, plateau, lid, slabs }: ProbeSources): () => void {
  const w = window as unknown as Probes;
  const map = getMap();
  if (import.meta.env.DEV && map) w.__acMap = map;
  installPerfVocabulary(); // the perf probes' names for the map's requests (testing tools)
  w.__acPlateau = () => {
    const m = getMap();
    return {
      zoom: m ? +m.getZoom().toFixed(2) : null,
      terrainActive: !!m?.getTerrain(),
      ...plateau.probe(),
      dpr: window.devicePixelRatio || 1,
      canvasDevicePx: m?.getCanvas().width ?? null,
      // The lid's texture: its size, resolution and cover (usePlateauLid).
      ...lid.probe(),
      // The analyses' slabs standing (see syncSlabs).
      slabs: slabs.probe(),
    };
  };
  if (import.meta.env.DEV) w.__acFrame = frames.probe;
  return () => {
    if (import.meta.env.DEV && w.__acFrame === frames.probe) delete w.__acFrame;
  };
}
