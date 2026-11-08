// The credits owed for the boundaries the explorer draws, shown in the map's
// attribution before Mapbox's own (GeoDrillMap's `attribution`). Visitor text,
// so French; HTML, of which Mapbox keeps only `<a href="http(s)…">` anchors
// (sanitizeLinks: every other tag becomes text, rel is forced to
// "noopener nofollow"). Each array is one entry per « | » of the credit line.
//
// The credit follows what is actually drawn:
// - the outline files in (`ok`): Etalab's contours-administratifs;
// - « Pays » only once country files are drawn (outline-world turns
//   `countries` on);
// - anything else draws no boundary — no files read (`session` null: the
//   corpus source, the comparer), the files not in yet (`loading`: the boot
//   curtain hides the map anyway), the session fallen back (`fallback`) — and
//   credits none: one empty list.
//
// Sources read 2026-11-02: data.gouv.fr datasets « Contours administratifs »
// (licence ODbL; IGN Admin Express, OpenStreetMap for the collectivités
// d'outre-mer, the territories' own data for Polynésie française (CC BY) and
// Nouvelle-Calédonie (Licence Ouverte)), « Admin Express » (IGN, Licence
// Ouverte 2.0); docs.overturemaps.org/attribution (divisions: ODbL,
// © OpenStreetMap contributors).
//
// Pure: frozen module-level arrays, one per case, so the same inputs give the
// same array (GeoDrillMap re-creates its control only when the text changes).

/** Where the outline files' session stands (useOutlineFiles' `ready`); null
 *  when the explorer reads no files at all. */
export type OutlineSession = "loading" | "ok" | "fallback" | null;

// Licence Ouverte 2.0 on data.gouv.fr: Etalab's own licence page now
// redirects to the data.gouv.fr home page.
const LO = "https://www.data.gouv.fr/pages/legal/licences/etalab-2-0";
const OSM = "https://www.openstreetmap.org/copyright";
const ODBL = "https://opendatacommons.org/licenses/odbl/1-0/";

/** Polynésie française (987) and Nouvelle-Calédonie (988): their communes come
 *  from the territories' own datasets, in the outline files too.
 *  data.gouv.fr gives CC BY no version. */
const PF_NC =
  'Polynésie française : <a href="https://www.data.gouv.fr/datasets/geographie-administrative-de-la-polynesie-francaise">Section Cadastre-Topographie</a>, <a href="https://opendefinition.org/licenses/cc-by/">CC BY</a> ; ' +
  `Nouvelle-Calédonie : DITTT, Gouvernement de la Nouvelle-Calédonie, <a href="${LO}">Licence Ouverte</a>`;

const FILES_FRANCE =
  `Contours : IGN – Admin Express et <a href="${OSM}">© les contributeurs OpenStreetMap</a> (collectivités d'outre-mer), via Etalab — ` +
  `<a href="${LO}">Licence Ouverte</a>, <a href="${ODBL}">ODbL</a>`;

const COUNTRIES = `Pays : <a href="https://overturemaps.org">Overture Maps Foundation</a>, <a href="${OSM}">© les contributeurs OpenStreetMap</a> — <a href="${ODBL}">ODbL</a>`;

const NONE: readonly string[] = Object.freeze([]);
const FILES_STRINGS: readonly string[] = Object.freeze([FILES_FRANCE, PF_NC]);
const FILES_WORLD_STRINGS: readonly string[] = Object.freeze([FILES_FRANCE, PF_NC, COUNTRIES]);

/** The credits for the boundaries drawn now (see the header). */
export function boundaryAttribution({
  session,
  countries,
}: {
  session: OutlineSession;
  countries: boolean;
}): readonly string[] {
  if (session !== "ok") return NONE;
  return countries ? FILES_WORLD_STRINGS : FILES_STRINGS;
}
