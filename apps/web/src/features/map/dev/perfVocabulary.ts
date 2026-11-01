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
//
// Spans: dem.post, plateau.rise, plateau.setGeometry, projection.ringBases,
// projection.lidBases, tint.setSelection, mask.setData, mask.drapedIndexed, outline.setData,
// lid.capture, slabs.sync, pins.buildMarkers, vue.hierarchy, vue.outline,
// vue.mapUnits, vue.deriveScope, pmtiles.firstTiles, and
//   camera.fit        a fit's camera, computed (useMapCamera.runCamera →
//                     fitCamera; detail: shape, hull points)
//   outline.change    a note (0 ms) per run of GeoDrillMap's outline watcher
//                     (detail: features, pending)
//   dem.tilesReady    a DEM slot's addSource → the first event after which its
//                     tiles are all loaded, at least one tile in (usePlateau;
//                     detail: scope, route, tiles, errTiles)
// Reserved for the phases to come, so their tables share one vocabulary:
// dem.key, plateau.meshBuild, plateau.globeBuild, plateau.globeLate,
// mesh.roundTrip, outline.fetch, outline.decode, outline.fallback.
//
// Requests: `net` sees the main thread's fetches only (Resource Timing), and
// reads no bytes cross-origin. Bytes, and what Mapbox's or our workers fetch,
// need a CDP trace with the workers attached.

import { perfOn, perfVocabulary } from "@/shared/perf/perf";
import { netKind } from "./netKind";

/** Register the map's vocabulary (once; a no-op without the testing tools). */
export function installPerfVocabulary() {
  if (!perfOn) return;
  perfVocabulary({
    net: netKind,
    script: (url) => (/mapbox-gl/.test(url) ? "mapbox-gl" : null),
  });
}
