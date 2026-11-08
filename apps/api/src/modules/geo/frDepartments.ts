/*
 * Auditions Citoyennes — data ingestion pipeline
 * Copyright (C) 2026 Auditions Citoyennes
 *
 * This program is free software under the GNU AGPL v3 or later.
 * <https://www.gnu.org/licenses/>
 */

// Département code → { name, region, centre }. Names from geo.api.gouv.fr
// (/departements?fields=nom,code,region), overseas collectivities BAN covers
// added by hand (975, 977, 978: each its own région). Used by the geocoder for
// a lieu that names a département or a région, not a town. Static so the API
// makes no runtime call.
//
// `centre` ([lat, lng]) is where a lieu placed at that level sits: the centre
// the deleted boundaries/geometry gave the unit (of its largest ring), computed over
// france-geojson's departements-avec-outre-mer / regions-avec-outre-mer. Two
// exceptions: Hauts-de-Seine, a crescent whose centre falls in Paris (its
// pole of inaccessibility instead), and the three collectivities france-geojson
// lacks (their chef-lieu, from BAN).
type LatLng = [number, number];

export const FR_DEPARTMENTS: Record<string, { name: string; region: string; centre: LatLng }> = {
  "01": { name: "Ain", region: "Auvergne-Rhône-Alpes", centre: [46.0997, 5.3487] },
  "02": { name: "Aisne", region: "Hauts-de-France", centre: [49.561, 3.5592] },
  "03": { name: "Allier", region: "Auvergne-Rhône-Alpes", centre: [46.3936, 3.1877] },
  "04": {
    name: "Alpes-de-Haute-Provence",
    region: "Provence-Alpes-Côte d'Azur",
    centre: [44.1062, 6.2448],
  },
  "05": { name: "Hautes-Alpes", region: "Provence-Alpes-Côte d'Azur", centre: [44.6638, 6.265] },
  "06": {
    name: "Alpes-Maritimes",
    region: "Provence-Alpes-Côte d'Azur",
    centre: [43.9382, 7.1163],
  },
  "07": { name: "Ardèche", region: "Auvergne-Rhône-Alpes", centre: [44.7527, 4.4256] },
  "08": { name: "Ardennes", region: "Grand Est", centre: [49.6162, 4.6407] },
  "09": { name: "Ariège", region: "Occitanie", centre: [42.921, 1.5036] },
  "10": { name: "Aube", region: "Grand Est", centre: [48.3046, 4.1614] },
  "11": { name: "Aude", region: "Occitanie", centre: [43.1032, 2.4137] },
  "12": { name: "Aveyron", region: "Occitanie", centre: [44.2811, 2.6785] },
  "13": {
    name: "Bouches-du-Rhône",
    region: "Provence-Alpes-Côte d'Azur",
    centre: [43.5433, 5.0857],
  },
  "14": { name: "Calvados", region: "Normandie", centre: [49.0998, -0.3616] },
  "15": { name: "Cantal", region: "Auvergne-Rhône-Alpes", centre: [45.0512, 2.669] },
  "16": { name: "Charente", region: "Nouvelle-Aquitaine", centre: [45.7187, 0.2031] },
  "17": { name: "Charente-Maritime", region: "Nouvelle-Aquitaine", centre: [45.7657, -0.6542] },
  "18": { name: "Cher", region: "Centre-Val de Loire", centre: [47.0658, 2.4911] },
  "19": { name: "Corrèze", region: "Nouvelle-Aquitaine", centre: [45.3573, 1.8777] },
  "21": { name: "Côte-d'Or", region: "Bourgogne-Franche-Comté", centre: [47.4261, 4.7727] },
  "22": { name: "Côtes-d'Armor", region: "Bretagne", centre: [48.4405, -2.8645] },
  "23": { name: "Creuse", region: "Nouvelle-Aquitaine", centre: [46.0906, 2.0182] },
  "24": { name: "Dordogne", region: "Nouvelle-Aquitaine", centre: [45.1049, 0.7412] },
  "25": { name: "Doubs", region: "Bourgogne-Franche-Comté", centre: [47.1659, 6.3627] },
  "26": { name: "Drôme", region: "Auvergne-Rhône-Alpes", centre: [44.6791, 5.1635] },
  "27": { name: "Eure", region: "Normandie", centre: [49.1137, 0.9964] },
  "28": { name: "Eure-et-Loir", region: "Centre-Val de Loire", centre: [48.388, 1.37] },
  "29": { name: "Finistère", region: "Bretagne", centre: [48.2611, -4.0571] },
  "2A": { name: "Corse-du-Sud", region: "Corse", centre: [41.8643, 8.9875] },
  "2B": { name: "Haute-Corse", region: "Corse", centre: [42.3949, 9.2062] },
  "30": { name: "Gard", region: "Occitanie", centre: [43.9936, 4.1799] },
  "31": { name: "Haute-Garonne", region: "Occitanie", centre: [43.3589, 1.175] },
  "32": { name: "Gers", region: "Occitanie", centre: [43.6929, 0.4529] },
  "33": { name: "Gironde", region: "Nouvelle-Aquitaine", centre: [44.839, -0.5831] },
  "34": { name: "Hérault", region: "Occitanie", centre: [43.5795, 3.3685] },
  "35": { name: "Ille-et-Vilaine", region: "Bretagne", centre: [48.1509, -1.6341] },
  "36": { name: "Indre", region: "Centre-Val de Loire", centre: [46.7783, 1.576] },
  "37": { name: "Indre-et-Loire", region: "Centre-Val de Loire", centre: [47.2585, 0.6911] },
  "38": { name: "Isère", region: "Auvergne-Rhône-Alpes", centre: [45.2639, 5.5742] },
  "39": { name: "Jura", region: "Bourgogne-Franche-Comté", centre: [46.7293, 5.6974] },
  "40": { name: "Landes", region: "Nouvelle-Aquitaine", centre: [43.9658, -0.7837] },
  "41": { name: "Loir-et-Cher", region: "Centre-Val de Loire", centre: [47.6168, 1.4279] },
  "42": { name: "Loire", region: "Auvergne-Rhône-Alpes", centre: [45.728, 4.1646] },
  "43": { name: "Haute-Loire", region: "Auvergne-Rhône-Alpes", centre: [45.1281, 3.8063] },
  "44": { name: "Loire-Atlantique", region: "Pays de la Loire", centre: [47.363, -1.6792] },
  "45": { name: "Loiret", region: "Centre-Val de Loire", centre: [47.9119, 2.344] },
  "46": { name: "Lot", region: "Occitanie", centre: [44.6246, 1.6055] },
  "47": { name: "Lot-et-Garonne", region: "Nouvelle-Aquitaine", centre: [44.3679, 0.4607] },
  "48": { name: "Lozère", region: "Occitanie", centre: [44.5175, 3.4997] },
  "49": { name: "Maine-et-Loire", region: "Pays de la Loire", centre: [47.3898, -0.5594] },
  "50": { name: "Manche", region: "Normandie", centre: [49.0813, -1.3288] },
  "51": { name: "Marne", region: "Grand Est", centre: [48.9499, 4.2385] },
  "52": { name: "Haute-Marne", region: "Grand Est", centre: [48.1104, 5.2255] },
  "53": { name: "Mayenne", region: "Pays de la Loire", centre: [48.1472, -0.6574] },
  "54": { name: "Meurthe-et-Moselle", region: "Grand Est", centre: [48.7882, 6.1624] },
  "55": { name: "Meuse", region: "Grand Est", centre: [48.9914, 5.3815] },
  "56": { name: "Morbihan", region: "Bretagne", centre: [47.8554, -2.8045] },
  "57": { name: "Moselle", region: "Grand Est", centre: [49.0375, 6.6614] },
  "58": { name: "Nièvre", region: "Bourgogne-Franche-Comté", centre: [47.1157, 3.5042] },
  "59": { name: "Nord", region: "Hauts-de-France", centre: [50.4488, 3.2162] },
  "60": { name: "Oise", region: "Hauts-de-France", centre: [49.4099, 2.4249] },
  "61": { name: "Orne", region: "Normandie", centre: [48.6231, 0.1278] },
  "62": { name: "Pas-de-Calais", region: "Hauts-de-France", centre: [50.4926, 2.2888] },
  "63": { name: "Puy-de-Dôme", region: "Auvergne-Rhône-Alpes", centre: [45.7259, 3.1402] },
  "64": { name: "Pyrénées-Atlantiques", region: "Nouvelle-Aquitaine", centre: [43.2566, -0.7581] },
  "65": { name: "Hautes-Pyrénées", region: "Occitanie", centre: [43.0513, 0.1664] },
  "66": { name: "Pyrénées-Orientales", region: "Occitanie", centre: [42.5993, 2.5207] },
  "67": { name: "Bas-Rhin", region: "Grand Est", centre: [48.6715, 7.552] },
  "68": { name: "Haut-Rhin", region: "Grand Est", centre: [47.8594, 7.274] },
  "69": { name: "Rhône", region: "Auvergne-Rhône-Alpes", centre: [45.871, 4.6408] },
  "70": { name: "Haute-Saône", region: "Bourgogne-Franche-Comté", centre: [47.6412, 6.0872] },
  "71": { name: "Saône-et-Loire", region: "Bourgogne-Franche-Comté", centre: [46.6448, 4.5428] },
  "72": { name: "Sarthe", region: "Pays de la Loire", centre: [47.9949, 0.2226] },
  "73": { name: "Savoie", region: "Auvergne-Rhône-Alpes", centre: [45.4775, 6.4429] },
  "74": { name: "Haute-Savoie", region: "Auvergne-Rhône-Alpes", centre: [46.0346, 6.4284] },
  "75": { name: "Paris", region: "Île-de-France", centre: [48.8566, 2.3428] },
  "76": { name: "Seine-Maritime", region: "Normandie", centre: [49.6547, 1.0272] },
  "77": { name: "Seine-et-Marne", region: "Île-de-France", centre: [48.6275, 2.9341] },
  "78": { name: "Yvelines", region: "Île-de-France", centre: [48.8153, 1.8413] },
  "79": { name: "Deux-Sèvres", region: "Nouvelle-Aquitaine", centre: [46.557, -0.3178] },
  "80": { name: "Somme", region: "Hauts-de-France", centre: [49.9579, 2.2761] },
  "81": { name: "Tarn", region: "Occitanie", centre: [43.7857, 2.1657] },
  "82": { name: "Tarn-et-Garonne", region: "Occitanie", centre: [44.0858, 1.2822] },
  "83": { name: "Var", region: "Provence-Alpes-Côte d'Azur", centre: [43.4438, 6.2442] },
  "84": { name: "Vaucluse", region: "Provence-Alpes-Côte d'Azur", centre: [43.994, 5.1852] },
  "85": { name: "Vendée", region: "Pays de la Loire", centre: [46.6726, -1.2877] },
  "86": { name: "Vienne", region: "Nouvelle-Aquitaine", centre: [46.5649, 0.4595] },
  "87": { name: "Haute-Vienne", region: "Nouvelle-Aquitaine", centre: [45.8922, 1.2348] },
  "88": { name: "Vosges", region: "Grand Est", centre: [48.1962, 6.3802] },
  "89": { name: "Yonne", region: "Bourgogne-Franche-Comté", centre: [47.8405, 3.5633] },
  "90": {
    name: "Territoire de Belfort",
    region: "Bourgogne-Franche-Comté",
    centre: [47.6317, 6.9286],
  },
  "91": { name: "Essonne", region: "Île-de-France", centre: [48.5226, 2.2434] },
  "92": { name: "Hauts-de-Seine", region: "Île-de-France", centre: [48.7958, 2.2716] },
  "93": { name: "Seine-Saint-Denis", region: "Île-de-France", centre: [48.9176, 2.4784] },
  "94": { name: "Val-de-Marne", region: "Île-de-France", centre: [48.7774, 2.4693] },
  "95": { name: "Val-d'Oise", region: "Île-de-France", centre: [49.0827, 2.131] },
  "971": { name: "Guadeloupe", region: "Guadeloupe", centre: [16.1594, -61.6797] },
  "972": { name: "Martinique", region: "Martinique", centre: [14.6533, -61.0187] },
  "973": { name: "Guyane", region: "Guyane", centre: [3.9235, -53.2353] },
  "974": { name: "La Réunion", region: "La Réunion", centre: [-21.1333, 55.5325] },
  "976": { name: "Mayotte", region: "Mayotte", centre: [-12.8228, 45.1438] },
  "975": {
    name: "Saint-Pierre-et-Miquelon",
    region: "Saint-Pierre-et-Miquelon",
    centre: [46.7745, -56.195],
  },
  "977": { name: "Saint-Barthélemy", region: "Saint-Barthélemy", centre: [17.9025, -62.8289] },
  "978": { name: "Saint-Martin", region: "Saint-Martin", centre: [18.0874, -63.0794] },
};

/** Région name (as BAN and FR_DEPARTMENTS spell it) → where a lieu placed at that level sits. */
export const FR_REGIONS: Record<string, LatLng> = {
  "Auvergne-Rhône-Alpes": [45.5126, 4.5369],
  "Bourgogne-Franche-Comté": [47.2342, 4.8068],
  Bretagne: [48.1813, -2.8377],
  "Centre-Val de Loire": [47.4847, 1.6844],
  Corse: [42.1517, 9.106],
  "Grand Est": [48.6889, 5.6131],
  Guadeloupe: [16.1594, -61.6797],
  Guyane: [3.9235, -53.2353],
  "Hauts-de-France": [49.9693, 2.7715],
  "La Réunion": [-21.1333, 55.5325],
  Martinique: [14.6533, -61.0187],
  Mayotte: [-12.8228, 45.1438],
  Normandie: [49.1202, 0.1108],
  "Nouvelle-Aquitaine": [45.2033, 0.212],
  Occitanie: [43.7024, 2.1453],
  "Pays de la Loire": [47.4793, -0.8137],
  "Provence-Alpes-Côte d'Azur": [43.9556, 6.0604],
  "Île-de-France": [48.7093, 2.5034],
  "Saint-Pierre-et-Miquelon": [46.7745, -56.195],
  "Saint-Barthélemy": [17.9025, -62.8289],
  "Saint-Martin": [18.0874, -63.0794],
};

/** Département code from a French postcode (handles Corsica 2A/2B + DOM 97x/98x). */
export function departementFromPostcode(postcode: string | null | undefined): string | null {
  if (!postcode) return null;
  const p = postcode.trim();
  if (!/^\d{5}$/.test(p)) return null;
  if (p.startsWith("20")) return Number(p) < 20200 ? "2A" : "2B"; // Corse
  if (p.startsWith("97") || p.startsWith("98")) return p.slice(0, 3); // DOM/COM
  return p.slice(0, 2);
}
