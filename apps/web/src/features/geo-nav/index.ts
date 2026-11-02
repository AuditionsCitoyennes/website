// The Témoignages experience minus WebGL: the scope, the side panel, the
// camera commands and the analyses ring — one component for now — and the
// server's tree it can be built from (map phase 1): the store, the place
// reads, and what the comparer matches with (testing tools): the trees, the
// panel's orders and the results' frame; where its outlines come from
// (ac:contours, testing tools).
export { default as GeoNav } from "./GeoNav.vue";
export { useUnitTree, type TreeRequest, type UnitTree } from "./data/useUnitTree";
export { EMPTY_KEY, onPlacesReload, placesKeys } from "./keys";
export { fetchFacets, retryable, retryWait, RETRIES, type CountsRequest } from "./data/placesApi";
export { bySort, groupOwnAuditions, resultBounds } from "./model/auditions";
export { compareTrees, type TreeComparison, type TreeDiff } from "./data/compareTrees";
export type { BoundaryFC } from "./data/useBoundaryQueries";
// A lieu's label as the tree gives it (the comparer names the server's lieux so).
export { placeLabel } from "@/features/geo";
export { contoursMode, setContoursMode, type ContoursMode } from "./data/contoursSwitch";

// `window.__acOutlines()`: the outline files in the page (testing tools only).
if (__TEST_TOOLS__) void import("./data/outlinesProbe");
