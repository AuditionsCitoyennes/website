// The map's words for the perf probes (shared/perf): the interactions it
// measures, and how its requests and scripts are named in a report.
//
//   select-plateau    a unit selected (a row, a pin, its territory, a crumb;
//                     geo-nav/model/useNavActions) → the first frame the
//                     plateau is drawn at full rise (usePlateauFrames)
//   scope-mask        the scope written (GeoNav.vue) → the grey re-cut around
//                     it, or found unchanged (useScopeMask)
//   drill-boundaries  a unit selected → its outline has every geometry it
//                     will get (GeoNav.vue, useMapFeed.outlineReady)
//   lieu-pins         a lieu opened → the dots around it placed (useMapPins)
//   tap-answer        a tap's pointer event → the first frame painted after
//                     the app issued its answer (shared/perf/tapAnswer.ts;
//                     the answer: geo-nav/model/useNavActions; detail:
//                     target — canvas, pin, pill, row, other —, pointer,
//                     pressMs, answerMs, via)
//
// Counters, under `__acPerf.dump().probes` (motionProbes.ts): motion-mutations
// (the map mutations the app issued while the camera moved, a plateau rose or
// sank or a pointer was down), plateau-runs (the plateau pipeline's runs per
// selection), and tap-answer's taps seen and answered by target.
//
// Spans: plateau.rise, plateau.setGeometry, projection.ringBases,
// projection.lidBases, tint.setSelection, mask.setData, mask.drapedIndexed, outline.setData,
// lid.capture, slabs.sync, pins.buildMarkers, vue.hierarchy, vue.outline,
// vue.mapUnits, vue.deriveScope, pmtiles.firstTiles, and
//   camera.fit        a fit's camera, computed (useMapCamera.runCamera →
//                     fitCamera; detail: shape, hull points)
//   outline.change    a note (0 ms) per run of GeoDrillMap's outline watcher
//                     (detail: features, pending)
//   dem.tilesReady    a DEM slot's addSource → the first tile event after
//                     which its tiles are all loaded (usePlateau; detail:
//                     scope, tiles, errTiles — a 404 comes as
//                     `sourcedata`, any other failure as a map `error`, after
//                     which mapbox reads the source loaded: errTiles > 0 is
//                     no ready time)
//   plateau.globeBuild  ac:mesh=merc: a lazy setGeometry's globe set, built
//                     after the map's idle (PlateauWallLayer; detail: scope;
//                     worker: the worker's build time, noted on reception,
//                     `mesh: "worker"`)
//   plateau.globeLate the same set built by the first globe frame drawn
//                     before that, or by `__acMeshHash({ globe: true })`
//   dem.key           a selection's version key from the relief worker
//                     (usePlateau; detail: scope)
//   plateau.meshBuild ac:mesh=worker: a mesh's build in the worker, its own
//                     time, noted when the reply is received, so the span
//                     ends there, not at the worker's end (gl/meshClient.ts;
//                     detail: scope, part, cold — the request sent geometries)
//   mesh.roundTrip    ac:mesh=worker: a request posted → its reply received,
//                     both on the page (detail: scope, first, puts, cloneMs —
//                     the page's tokens, flattening and postMessage)
//   plateau.meshWait  ac:mesh=worker: how long a run waited for its mesh
//                     beyond its other gates (the key, the tile wait;
//                     with the sink: the mesh's time past the sink's end, 0
//                     if it came first) (usePlateau; detail: scope, path —
//                     same, quiet, swap —, first)
//   plateau.outline   ac:late-files=quiet: a note (0 ms) per outline judged
//                     against what stands (usePlateau.outlineChanged; detail:
//                     verdict — run, owed, redress, nothing)
//   plateau.redress   ac:late-files=quiet: the standing plateau's lines
//                     reshaped in place, from the outline to the mesh applied
//                     (usePlateau.redress; detail: scope, lines)
//   plateau.coldStart ac:cold-start=early: a note (0 ms) when a run holding
//                     for an outline starts the sink and the coming unit's
//                     lid (usePlateau.coldStart; detail: scope, sink)
// Reserved for the phases to come, so their tables share one vocabulary:
// outline.fetch, outline.decode, outline.fallback.
// plateau.setGeometry's detail names the mesh mode that built it (`mesh`:
// ac:mesh, plateau/meshSwitch.ts) and, with merc, its globe set's mode and
// what chose it (`globe`, `zCanon`, `zoom`); with worker it times the apply
// alone and adds `part` (merc, both), `start` (the mode the build was asked
// with) and `via` (worker, main); its output's fingerprint is
// `__acMeshHash()` (dev/probes.ts), once per call with `__acMeshHashEvery`.
//
// Requests: `net` sees the main thread's fetches only (Resource Timing), and
// reads no bytes cross-origin. Bytes, and what Mapbox's or our workers fetch,
// need a CDP trace with the workers attached.

import { perfOn, perfVocabulary } from "@/shared/perf/perf";
import { perfTapTargets } from "@/shared/perf/tapAnswer";
import { netKind } from "./netKind";

/** Register the map's vocabulary (once; a no-op without the testing tools). */
export function installPerfVocabulary() {
  if (!perfOn) return;
  perfVocabulary({
    net: netKind,
    script: (url) => (/mapbox-gl/.test(url) ? "mapbox-gl" : null),
  });
  // The map's tap targets (tap-answer): its canvas, a lieu's dot, a unit's pill
  // (useMapPins.makePin: a dot is a `.geo-pin` too, so it is tried first).
  perfTapTargets([
    { kind: "canvas", selector: ".mapboxgl-canvas" },
    { kind: "pin", selector: ".geo-pin-leaf" },
    { kind: "pill", selector: ".geo-pin" },
  ]);
}
