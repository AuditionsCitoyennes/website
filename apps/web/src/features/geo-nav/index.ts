// The Témoignages experience minus WebGL: the scope, the side panel, the
// camera commands and the analyses ring — one component for now — and the
// server's tree it is built from (map phase 1): the store and the place
// reads.
export { default as GeoNav } from "./GeoNav.vue";
export { useUnitTree, type TreeRequest, type UnitTree } from "./data/useUnitTree";
export { EMPTY_KEY, placesKeys } from "./keys";
export { fetchFacets, retryable, retryWait, RETRIES, type CountsRequest } from "./data/placesApi";
// What a pan does to the selected zone (ac:scope-drag), for the DEV dialog.
export { scopeDragMode, setScopeDragMode } from "./model/scopeHold";
// Whether a touch screen asks outline files ahead (ac:outlines-ahead), for the DEV dialog.
export { prefetchMode, setPrefetchMode } from "./data/prefetchSwitch";
// Whether a long wait shows its sign and its sentence (ac:slow-sign), for the DEV dialog.
export { slowSignMode, setSlowSignMode } from "./model/slowSignSwitch";
// What opening a lieu with one audition does (ac:lieu-single), for the DEV dialog.
export { lieuSingleMode, setLieuSingleMode } from "./model/lieuSingleSwitch";
// Whether the panel's cards run to its edges (ac:cards-bleed), for the DEV dialog.
export { cardsBleed, setCardsBleed } from "./panel/cardsBleedSwitch";
// What an open lieu does when the map is used (ac:lieu-hold), for the DEV dialog.
export { lieuHoldMode, setLieuHoldMode } from "./model/lieuHoldSwitch";

// `window.__acOutlines()`: the outline files in the page (testing tools only).
if (__TEST_TOOLS__) void import("./data/outlinesProbe");
// The boot curtain's switch (testing tools: the DEV dialog's « Liste » row).
export { bootList, setBootList, BOOT_LISTS, DEFAULT_BOOT_LIST } from "./bootListSwitch";
// When the decorative outlines come (testing tools: the DEV dialog's « Contours voisins » row).
export { outlinesDecor, setOutlinesDecor, OUTLINES_DECORS } from "./data/outlinesDecorSwitch";
// Which reads of the map page wait (testing tools: the DEV dialog's « Données
// des filtres » and « Préchargement des témoignages » rows).
export {
  FILTERS_IDLE_CAP_MS,
  FILTERS_IDLE_MS,
  filtersDataWanted,
  filtersLoad,
  prefetch,
  setFiltersLoad,
  setPrefetch,
} from "./data/bootReadsSwitch";
