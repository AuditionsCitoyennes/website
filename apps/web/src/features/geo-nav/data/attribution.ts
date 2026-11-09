// The credits owed for the boundaries the explorer draws, shown in the map's
// attribution before Mapbox's own (GeoDrillMap's `attribution`). Visitor text,
// so French; HTML, of which Mapbox keeps only `<a href="http(s)…">` anchors
// (sanitizeLinks: every other tag becomes text, rel is forced to
// "noopener nofollow"). Each array is one entry per « | » of the credit line.
//
// The credit follows what is actually drawn, not the switch alone:
// - `api` (the testing tools' other mode) and no files read (`session` null:
//   the corpus source, the comparer): the vendored france-geojson levels (the
//   line its README asks for, verbatim) and the Géo API's communes.
// - `fichiers` with the files in (`ok`): Etalab's contours-administratifs.
// - « Pays » only once country files are drawn (outline-world turns
//   `countries` on).
// - `fichiers` until the files are in (`loading`: the boot curtain hides the
//   map anyway) or once the session fell back (`fallback`: every unit known
//   absent): no boundary is drawn, none is credited — one empty list.
//
// Sources read 2026-11-02: data.gouv.fr datasets « Contours administratifs »
// (licence ODbL; IGN Admin Express, OpenStreetMap for the collectivités
// d'outre-mer, the territories' own data for Polynésie française (CC BY) and
// Nouvelle-Calédonie (Licence Ouverte)), « Admin Express » (IGN, Licence
// Ouverte 2.0); etalab/api-geo's download-sources.sh (the Géo API serves that
// dataset's communes); docs.overturemaps.org/attribution (divisions: ODbL,
// © OpenStreetMap contributors).
//
// Pure: frozen module-level arrays, one per case, so the same inputs give the
// same array (GeoDrillMap re-creates its control only when the text changes).
import type { ContoursMode } from "./contoursSwitch";

/** Where the outline files' session stands (useOutlineFiles' `ready`); null
 *  when the explorer reads no files at all. */
export type OutlineSession = "idle" | "loading" | "ok" | "fallback" | null;

// Licence Ouverte 2.0 on data.gouv.fr: Etalab's own licence page now
// redirects to the data.gouv.fr home page.
const LO = "https://www.data.gouv.fr/pages/legal/licences/etalab-2-0";
const OSM = "https://www.openstreetmap.org/copyright";
const ODBL = "https://opendatacommons.org/licenses/odbl/1-0/";

/** Polynésie française (987) and Nouvelle-Calédonie (988): their communes come
 *  from the territories' own datasets, in the Géo API's answers and in the
 *  outline files alike. */
const PF_NC =
  'Polynésie française : <a href="https://www.data.gouv.fr/datasets/geographie-administrative-de-la-polynesie-francaise">Section Cadastre-Topographie</a>, <a href="https://opendefinition.org/licenses/cc-by/">CC BY</a> ; ' +
  `Nouvelle-Calédonie : DITTT, Gouvernement de la Nouvelle-Calédonie, <a href="${LO}">Licence Ouverte</a>`;

// The Géo API's communes are the outline files' dataset (Etalab's
// contours-administratifs): the same licences on both lines, Admin Express's
// Licence Ouverte and the dataset's ODbL. data.gouv.fr gives CC BY no version.
const API_STRINGS: readonly string[] = Object.freeze([
  `Source : IGN — Admin Express COG 2018, via france-geojson (Grégoire David) — <a href="${LO}">Licence Ouverte</a>`,
  `Communes : <a href="https://geo.api.gouv.fr">API Géo</a> (IGN – Admin Express et <a href="${OSM}">© les contributeurs OpenStreetMap</a> pour les collectivités d'outre-mer) — <a href="${LO}">Licence Ouverte</a>, <a href="${ODBL}">ODbL</a>`,
  PF_NC,
]);

const FILES_FRANCE =
  `Contours : IGN – Admin Express et <a href="${OSM}">© les contributeurs OpenStreetMap</a> (collectivités d'outre-mer), via Etalab — ` +
  `<a href="${LO}">Licence Ouverte</a>, <a href="${ODBL}">ODbL</a>`;

const COUNTRIES = `Pays : <a href="https://overturemaps.org">Overture Maps Foundation</a>, <a href="${OSM}">© les contributeurs OpenStreetMap</a> — <a href="${ODBL}">ODbL</a>`;

const NONE: readonly string[] = Object.freeze([]);
const FILES_STRINGS: readonly string[] = Object.freeze([FILES_FRANCE, PF_NC]);
const FILES_WORLD_STRINGS: readonly string[] = Object.freeze([FILES_FRANCE, PF_NC, COUNTRIES]);

/** The credits for the boundaries drawn now (see the header). */
export function boundaryAttribution({
  mode,
  session,
  countries,
}: {
  mode: ContoursMode;
  session: OutlineSession;
  countries: boolean;
}): readonly string[] {
  if (mode !== "fichiers" || session === null || session === "idle") return API_STRINGS;
  if (session !== "ok") return NONE;
  return countries ? FILES_WORLD_STRINGS : FILES_STRINGS;
}
