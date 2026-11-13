// The window probes the map exposes for checking it in a browser, composed from
// each composable's share: `__acMap` (the map, DEV), `__acPlateau` (read-only,
// present in production too: the plateau/terrain path only runs in a real
// browser, never in a headless preview, so diagnosing "the map looks
// low-detail" needs a way to read the live state from the console) and
// `__acFrame` (the frame bus, DEV). Testing tools only (__TEST_TOOLS__): the
// map's idleness check, `__acPerf.rendersIn(ms)`, the plateau mesh's
// fingerprint, `__acMeshHash()` (PlateauWallLayer.meshDigest), the two
// motion counters of `__acPerf.dump().probes` (motionProbes.ts:
// `motion-mutations`, `plateau-runs`), and the still-map scheduler's state:
// `__acPerf.busy()` (what keeps the map from being still now) and
// `__acPerf.whenStill(timeoutMs?)` (a promise of how long a job asked now
// waits for the map to be still).

import type mapboxgl from "mapbox-gl";
import type { usePlateauFrames } from "../composables/usePlateauFrames";
import type { usePlateau } from "../composables/usePlateau";
import type { usePlateauLid } from "../composables/usePlateauLid";
import type { usePlateauSlabs } from "../composables/usePlateauSlabs";
import { stillMap, whenMapStill } from "../lib/stillMap";
import { installMotionProbes } from "./motionProbes";
import { installPerfVocabulary } from "./perfVocabulary";

type Probes = {
  __acMap?: mapboxgl.Map;
  __acPlateau?: () => unknown;
  __acFrame?: () => unknown;
  __acPerf?: Record<string, unknown>;
  __acMeshHash?: (opts?: { globe?: boolean }) => unknown;
};

/** Idleness check: request one repaint, then count the map's `render` events over
 *  `ms`. Read the verdict from `renders`: an idle map renders a small fixed number
 *  of frames (1-2) whatever `ms` is, while a self-repainting map's count grows with
 *  `ms` (about ms/40 for the old 25 Hz halo loop). `idleFired` only shows the map
 *  can reach idle at all: a timer-paced loop lets it fire between its frames too.
 *  `map: false` means no map was mounted (then `renders` is 0, `idleFired` false). */
function rendersIn(
  map: mapboxgl.Map | null,
  ms: number,
): Promise<{ renders: number; idleFired: boolean; map: boolean }> {
  if (!map) return Promise.resolve({ renders: 0, idleFired: false, map: false });
  return new Promise((resolve) => {
    let renders = 0;
    let idleFired = false;
    const onRender = () => renders++;
    const onIdle = () => {
      idleFired = true;
    };
    map.on("render", onRender);
    map.once("idle", onIdle);
    map.triggerRepaint();
    setTimeout(() => {
      map.off("render", onRender);
      map.off("idle", onIdle);
      resolve({ renders, idleFired, map: true });
    }, ms);
  });
}

/** The still-map scheduler, asked from the console: an empty job, and how long
 *  it waited — on a still map a turn, in a flight until the flight's end. */
function whenStill(timeoutMs?: number) {
  const t0 = performance.now();
  const busyAtAsk = stillMap.busy();
  return new Promise((resolve) => {
    whenMapStill(
      () =>
        resolve({
          waitedMs: Math.round(performance.now() - t0),
          busyAtAsk,
          busyAtRun: stillMap.busy(),
        }),
      timeoutMs === undefined ? {} : { timeoutMs },
    );
  });
}

export interface ProbeSources {
  getMap: () => mapboxgl.Map | null;
  frames: Pick<ReturnType<typeof usePlateauFrames>, "probe">;
  plateau: Pick<ReturnType<typeof usePlateau>, "probe">;
  lid: Pick<ReturnType<typeof usePlateauLid>, "probe">;
  slabs: Pick<ReturnType<typeof usePlateauSlabs>, "probe">;
  /** The plateau mesh's fingerprint (testing tools; null without them). */
  meshDigest: ((opts?: { globe?: boolean }) => unknown) | null;
}

/** Install the probes; returns what unmount calls (the frame and idleness probes are removed,
 *  the others stay, as before). */
export function installProbes({
  getMap,
  frames,
  plateau,
  lid,
  slabs,
  meshDigest,
}: ProbeSources): () => void {
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
  const rendersInProbe = __TEST_TOOLS__ ? (ms = 1000) => rendersIn(getMap(), ms) : null;
  if (rendersInProbe && w.__acPerf) w.__acPerf.rendersIn = rendersInProbe;
  if (__TEST_TOOLS__ && w.__acPerf) {
    w.__acPerf.busy = stillMap.busy;
    w.__acPerf.whenStill = whenStill;
  }
  if (__TEST_TOOLS__ && meshDigest) w.__acMeshHash = meshDigest;
  // The map's mutators wrapped and counted while the map moves (testing tools).
  const uninstallMotion = __TEST_TOOLS__ && map ? installMotionProbes(map) : null;
  return () => {
    if (import.meta.env.DEV && w.__acFrame === frames.probe) delete w.__acFrame;
    if (__TEST_TOOLS__ && w.__acPerf?.rendersIn === rendersInProbe) delete w.__acPerf.rendersIn;
    if (__TEST_TOOLS__ && w.__acPerf?.whenStill === whenStill) {
      delete w.__acPerf.busy;
      delete w.__acPerf.whenStill;
    }
    if (__TEST_TOOLS__ && meshDigest && w.__acMeshHash === meshDigest) delete w.__acMeshHash;
    if (uninstallMotion) uninstallMotion();
  };
}
