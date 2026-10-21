// The explorer the stage shows: the public corpus and the map's groups,
// filtered once for both the pins and the panel. MapStage mounts it (lazily,
// through the loader); app/AppDialogs.vue invalidates its queries.
export const loadTemoignagesExplorer = () => import("./TemoignagesExplorer.vue");
export { testimoniesKeys } from "./api/queries";
