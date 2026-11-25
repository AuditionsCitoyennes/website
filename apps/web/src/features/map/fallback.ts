// What the map's box shows when the map cannot start (GeoDrillMap.vue: no
// token in the build, the style refused, no WebGL, the engine failing): a
// still picture of France (the loading curtain's, shared/ui/MapCurtain.vue
// `bare`), muted, under one plain sentence for visitors. The developer's hint
// (the token's variable) goes to the console, in a development build only.
// The same box, over a map that stays, with a « Réessayer »: the style's
// request failed and the attempts made by themselves did too
// (lib/styleRecovery.ts). The Témoignages page shows no panel meanwhile
// (geo-nav/panelBoot.ts).
//
// To see it without a broken network: Chrome started with --disable-webgl
// --disable-3d-apis (no WebGL), or the requests to api.mapbox.com/styles
// answered 401 (refused) or failed (« Réessayer »).
//
// Pure: loadable under node (shared/device/cardOpenSwitch.test.ts).

/** The sentence a visitor reads in the map's box when it cannot start. */
export const MAP_FALLBACK_TEXT = "La carte n'a pas pu s'afficher.";
