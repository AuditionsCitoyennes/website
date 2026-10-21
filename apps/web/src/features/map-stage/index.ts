// The one Mapbox instance above the pages: the stage that moves it between the
// home page's card and /temoignages, the page that lends it its whole area, and
// the slots the pages lend it through.
export { default as MapStage } from "./MapStage.vue";
export const StagePage = () => import("./StagePage.vue");
export { useMapStage, type StageRect } from "./useMapStage";
