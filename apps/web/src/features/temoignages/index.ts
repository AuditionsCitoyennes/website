// The explorer the stage shows: the server's place reads (map phase 1) — or,
// behind the testing tools' switch, the public corpus and the map's groups —
// filtered once for both the pins and the panel. MapStage mounts it (lazily,
// through the loader); app/AppDialogs.vue invalidates its queries.
export const loadTemoignagesExplorer = () => import("./TemoignagesExplorer.vue");
export { testimoniesKeys } from "./api/queries";
// A secondary entry: the barrel would bring the map into app/'s chunk.
export { placesKeys } from "@/features/geo-nav/keys";
