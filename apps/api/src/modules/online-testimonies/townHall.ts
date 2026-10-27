import {
  arrondissementFromCitycode,
  ordinalFr,
  SHARED_MAIRIE,
  splitCityOfArrondissement,
  splitCityOfCommune,
  type OnlinePlace,
} from "@ac/shared";
import {
  fetchCommune,
  frChainOfCommune,
  PlaceError,
  type FrChain,
  type GeoCommune,
} from "../places/fr";

export { PlaceError };

// The town hall of a commune — or of an arrondissement in Paris, Lyon and
// Marseille — for online auditions, from the official commune API
// (geo.api.gouv.fr, "Découpage administratif"; see places/fr.ts). The
// visitor's browser only sends an INSEE code: the name, the town hall's
// position and its place in the map's hierarchy are all resolved here, never
// taken from the client.
//
// Not through the BAN geocoder: "Mairie de X" does not geocode to the town
// hall, and the shared LOCATION_RULES would hijack some labels (any "bron").
// The commune API gives the town hall's point directly (`mairie`).

/** "de Lyon", "d'Annecy", "du Havre", "des Lilas". */
function deCommune(name: string): string {
  if (/^Le /.test(name)) return `du ${name.slice(3)}`;
  if (/^Les /.test(name)) return `des ${name.slice(4)}`;
  if (/^[AEIOUYÂÀÉÈÊËÎÏÔÖÛÜŒ]/i.test(name)) return `d'${name}`;
  return `de ${name}`;
}

/**
 * The town hall's name — which is also the online audition's `location`, and
 * so the place's name on the map: it must be unique. Town halls of communes
 * carry their département ("Mairie de Saint-Denis (93)" is not Réunion's).
 */
function mairieLabel(commune: GeoCommune, key: string): string {
  const split = splitCityOfArrondissement(key);
  if (!split) return `Mairie ${deCommune(commune.nom)} (${commune.departement?.code ?? "?"})`;
  if (key === "75103") return "Mairie de Paris Centre";
  const sector = [key, ...Object.keys(SHARED_MAIRIE).filter((c) => SHARED_MAIRIE[c] === key)]
    .map((c) => Number(c) - split.base)
    .sort((a, b) => a - b);
  if (sector.length > 1) {
    return `Mairie des ${sector.map(ordinalFr).join(" et ")} arrondissements de ${split.name}`;
  }
  return `Mairie du ${ordinalFr(sector[0])} arrondissement de ${split.name}`;
}

export interface OnlineTownHall {
  /** INSEE code the town hall is filed under (the online audition's citycode). */
  key: string;
  /** Its name, and the online audition's location. */
  location: string;
  place: OnlinePlace;
  /** Where the point is: the town hall itself, or the commune's centre when geo.api has no town hall. */
  pointKind: "mairie" | "centre";
  /** Where the town hall's commune or arrondissement sits (the audition's place_path); null if geo.api leaves it out. */
  chain: FrChain | null;
}

/** The town hall of the commune or arrondissement with this INSEE code. */
export async function resolveTownHall(insee: string): Promise<OnlineTownHall> {
  if (splitCityOfCommune(insee)) {
    throw new PlaceError("Pour Paris, Lyon et Marseille, choisissez votre arrondissement.", 400);
  }
  const key = SHARED_MAIRIE[insee] ?? insee;
  const commune = await fetchCommune(key);
  if (!commune) throw new PlaceError("Commune introuvable : choisissez-la dans la liste.", 400);
  // Collectivités d'outre-mer: outside the official town-hall data.
  if (commune.zone === "com") {
    throw new PlaceError("Les collectivités d'outre-mer ne sont pas encore prises en charge.", 400);
  }
  const point = commune.mairie?.coordinates ?? commune.centre?.coordinates;
  if (!point) throw new PlaceError("La mairie de cette commune est introuvable.", 400);
  const split = splitCityOfArrondissement(key);
  return {
    key,
    location: mairieLabel(commune, key),
    place: {
      insee: key,
      commune: split?.name ?? commune.nom,
      arrondissement: arrondissementFromCitycode(key),
      departementCode: commune.departement?.code ?? null,
      departementName: commune.departement?.nom ?? null,
      region: commune.region?.nom ?? null,
      lat: point[1],
      lng: point[0],
    },
    pointKind: commune.mairie ? "mairie" : "centre",
    chain: frChainOfCommune(commune),
  };
}
