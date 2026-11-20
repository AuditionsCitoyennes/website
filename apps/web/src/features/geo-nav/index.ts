// The Témoignages experience minus WebGL: the scope, the side panel, the
// camera commands and the analyses ring — one component for now — and the
// server's tree it is built from (map phase 1): the store and the place
// reads.
export { default as GeoNav } from "./GeoNav.vue";
export { useUnitTree, type TreeRequest, type UnitTree } from "./data/useUnitTree";
export { EMPTY_KEY, placesKeys } from "./keys";
export { fetchFacets, retryable, retryWait, RETRIES, type CountsRequest } from "./data/placesApi";
// What an open lieu does when the map is used (ac:lieu-hold), for the DEV dialog.
export { lieuHoldMode, setLieuHoldMode } from "./model/lieuHoldSwitch";

// `window.__acOutlines()`: the outline files in the page (testing tools only).
if (__TEST_TOOLS__) void import("./data/outlinesProbe");
// Which reads of the map page wait (the Filtres dialog's data).
export { FILTERS_IDLE_CAP_MS, FILTERS_IDLE_MS, filtersDataWanted } from "./data/bootReadsSwitch";
