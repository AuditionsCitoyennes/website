// The Témoignages experience minus WebGL: the scope, the side panel, the
// camera commands and the analyses ring — one component for now — and the
// server's tree it is built from (map phase 1): the store and the place
// reads.
export { default as GeoNav } from "./GeoNav.vue";
export { useUnitTree, type TreeRequest, type UnitTree } from "./data/useUnitTree";
export { EMPTY_KEY, placesKeys } from "./keys";
export { fetchFacets, retryable, retryWait, RETRIES, type CountsRequest } from "./data/placesApi";

// `window.__acOutlines()`: the outline files in the page (testing tools only).
if (__TEST_TOOLS__) void import("./data/outlinesProbe");
// How a phone's camera re-frames a short sheet's late list (the testing
// options menu's « Recadrage tardif »).
export { sheetLateMode, setSheetLateMode, type SheetLateMode } from "./panel/sheetLateSwitch";
// Which reads of the map page wait (the Filtres dialog's data).
export { FILTERS_IDLE_CAP_MS, FILTERS_IDLE_MS, filtersDataWanted } from "./data/bootReadsSwitch";
