// What a main-thread request fetched, from its URL: the map's request kinds in
// a perf report (perfVocabulary). Pure and import-free, so it runs under
// `node --test` (netKind.test.ts).

/** The outline files (root.json, then one file per unit under k/, u/ or g/),
 *  wherever they are served from. A dev server's `/src/…` module of the same
 *  name is code, not an outline. */
const OUTLINE_FILE = /\/outlines\/[^/]+\/(root\.json|[kug]\/[^/]+\.json)(\?|$)/;

/** The request's kind, or null when the map has no word for it. */
export function netKind(url: string): string | null {
  if (OUTLINE_FILE.test(url) && !url.includes("/src/")) return "outlines";
  if (/\/api\/dem\/[^/]+\/\d+\/\d+\/\d+/.test(url)) return "dem.tiles";
  if (/\/api\/dem\/?(\?|$)/.test(url)) return "dem.post";
  if (url.includes("/api/map")) return "api.map";
  if (url.includes("/api/")) return "api.other";
  if (/mapbox\.com/.test(url)) return "mapbox";
  if (/\.pmtiles(\?|$)/.test(url)) return "pmtiles";
  return null;
}
