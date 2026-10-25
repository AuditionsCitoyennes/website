// The analyses as SLABS: two small pieces of ground beside the territory, one
// above its top edge (the themes), one under its bottom edge (the plaque),
// each the box its content is laid out in, and the raised pieces standing on
// it at the plateau's height (GeoDrillMap draws them): the plaque one piece,
// the whole box; the themes three in a row — the ring, each of its parts a
// piece of its own, a bar of the theme's colour, the label's box — with the
// ground between them. Their words lie on their lids, glued to the map
// (ScopeAnalysisOverlay): they move, grow, shrink, tilt and turn with it.
//
// Pure — no mapbox, no DOM — so that the sizes can be checked offline. Six
// modules, this one the leaf the others share: the constants the whole site
// reads (the fit's pitch, its fill, the words' share of the type scale), the
// earth's measures, mercator and the two spaces a slab is laid out in.

/** The pitch the camera frames a raised territory at (GeoDrillMap's ELEV_PITCH). */
export const FIT_PITCH_DEG = 45;

/** How much of the rectangle a territory's fit gives its silhouette, on the
 *  axis that limits it — the rest is map around it, the silhouette still
 *  centred (fitSilhouette's `fill`). GeoNav's, in production; its DEV switch
 *  ("Cadrage", analyses/devSwitch) compares others. */
export const FRAME_FILL = 0.8;

/** The analyses' words right after a fit: this much of the type scale's sizes
 *  on screen (solveSlabScales' `textScale`). Their content boxes are laid out
 *  at the type scale's sizes (the CSS keeps its tokens); the slabs are drawn
 *  that much smaller on the map, padding and gaps with them. In production;
 *  the DEV switch ("Taille", analyses/devSwitch) compares others. */
export const TEXT_SCALE = 0.8;

export const DEG = Math.PI / 180;
export const R_EARTH = 6378137;
export const C_EARTH = 2 * Math.PI * R_EARTH;
/** Latitude kept within: mercator stops at ±85. */
export const MAX_LAT = 84;

export const mercX = (lng: number) => (lng + 180) / 360;
export const mercY = (lat: number) => {
  const s = Math.sin(lat * DEG);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
export const lngOf = (x: number) => x * 360 - 180;
export const latOf = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / DEG;
export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
export const clampLat = (lat: number) => Math.min(MAX_LAT, Math.max(-MAX_LAT, lat));

/**
 * The space a slab is laid out in: across (X, from the territory's middle
 * meridian) and along (Y, growing southward).
 * - "mercator": mercator units, as the flat map is drawn (z ≥ 6): a slab is a
 *   lat/lng rectangle there, a rectangle on the map.
 * - "ground": metres, east and south, as the globe is drawn (France's slabs,
 *   sized below z 5.5): a lat/lng rectangle several degrees tall would come
 *   out a trapezoid there — the meridians closing in northward, 10–15 % over
 *   France's top slab —, so its width is kept in metres instead, the same at
 *   every latitude: a rectangle on the ground.
 */
export type SlabSpace = "mercator" | "ground";
export const yOf = (space: SlabSpace, lat: number) =>
  space === "mercator" ? mercY(lat) : -lat * DEG * R_EARTH;
export const latOfY = (space: SlabSpace, y: number) =>
  space === "mercator" ? latOf(y) : -y / R_EARTH / DEG;
/** [lng, lat] of a point X across from meridian `mid` at Y along. */
export function lngLatOf(space: SlabSpace, mid: number, x: number, y: number): [number, number] {
  const lat = clampLat(latOfY(space, y));
  if (space === "mercator") return [lngOf(mercX(mid) + x), lat];
  return [mid + x / (R_EARTH * Math.cos(lat * DEG)) / DEG, lat];
}
