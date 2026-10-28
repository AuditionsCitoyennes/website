// The Témoignages experience minus WebGL: the scope, the side panel, the
// camera commands and the analyses ring — one component for now — and the
// server's tree it can be built from (map phase 1): the store, the place
// reads, and what the comparer matches with (testing tools): the trees, the
// panel's orders and the results' frame.
export { default as GeoNav } from "./GeoNav.vue";
export { useUnitTree, type TreeRequest, type UnitTree } from "./data/useUnitTree";
export { EMPTY_KEY, placesKeys } from "./keys";
export { fetchFacets, retryable, retryWait, RETRIES, type CountsRequest } from "./data/placesApi";
export { bySort, groupOwnAuditions, resultBounds } from "./model/auditions";
export { compareTrees, type TreeComparison, type TreeDiff } from "./data/compareTrees";
export type { BoundaryFC } from "./data/useBoundaryQueries";
// A lieu's label as the tree gives it (the comparer names the server's lieux so).
export { placeLabel } from "@/features/geo";
