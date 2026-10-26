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
// projection.lidBases, tint.setSelection, mask.setData, mask.drapedIndexed,
// lid.capture, slabs.sync, pins.buildMarkers, vue.hierarchy, vue.outline,
// vue.mapUnits, vue.deriveScope, pmtiles.firstTiles.

import { perfOn, perfVocabulary } from "@/shared/perf/perf";

/** What a main-thread request fetched, from its URL. */
function netKind(url: string): string | null {
  if (/\/api\/dem\/[^/]+\/\d+\/\d+\/\d+/.test(url)) return "dem.tiles";
  if (/\/api\/dem\/?(\?|$)/.test(url)) return "dem.post";
  if (url.includes("/api/boundaries/departement/")) return "boundaries.departement";
  if (url.includes("/api/boundaries/communes")) return "boundaries.communes";
  if (url.includes("/api/boundaries/")) return "boundaries.levels";
  if (url.includes("/api/map")) return "api.map";
  if (url.includes("/api/")) return "api.other";
  if (/mapbox\.com/.test(url)) return "mapbox";
  if (/\.pmtiles(\?|$)/.test(url)) return "pmtiles";
  return null;
}

/** Register the map's vocabulary (once; a no-op without the testing tools). */
export function installPerfVocabulary() {
  if (!perfOn) return;
  perfVocabulary({
    net: netKind,
    script: (url) => (/mapbox-gl/.test(url) ? "mapbox-gl" : null),
  });
}
