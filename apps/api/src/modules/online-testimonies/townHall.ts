import type { OnlinePlace } from "@ac/shared";
import { arrondissementFromCitycode } from "../geo/geocode";

// The town hall of a commune — or of an arrondissement in Paris, Lyon and
// Marseille — for online auditions, from the official commune API
// (geo.api.gouv.fr, "Découpage administratif"). The visitor's browser only
// sends an INSEE code: the name, the town hall's position and its place in
// the map's hierarchy are all resolved here, never taken from the client.
//
// Not through the BAN geocoder: "Mairie de X" does not geocode to the town
// hall, and the shared LOCATION_RULES would hijack some labels (any "bron").
// The commune API gives the town hall's point directly (`mairie`).

const GEO = "https://geo.api.gouv.fr/communes";
const FIELDS = "nom,code,type,codeParent,departement,region,mairie,centre,zone";

/** Paris, Lyon and Marseille as a whole: an arrondissement must be chosen. */
const SPLIT_CITIES = new Set(["75056", "69123", "13055"]);

/**
 * Arrondissements whose town hall is another's: Paris 1er–4e share Paris
 * Centre's (in the 3e), and Marseille's sixteen share eight, one per sector
 * (filed under its first arrondissement). One online audition per town hall.
 */
const SHARED_MAIRIE: Record<string, string> = {
  "75101": "75103",
  "75102": "75103",
  "75104": "75103",
  "13207": "13201",
  "13203": "13202",
  "13204": "13205",
  "13206": "13208",
  "13210": "13209",
  "13211": "13212",
  "13213": "13214",
  "13216": "13215",
};

export class PlaceError extends Error {
  constructor(
    message: string,
    public status: 400 | 503,
  ) {
    super(message);
    this.name = "PlaceError";
  }
}

interface GeoPoint {
  type: "Point";
  coordinates: [number, number]; // [lng, lat]
}

interface GeoCommune {
  nom: string;
  code: string;
  type?: string;
  codeParent?: string;
  departement?: { code: string; nom: string };
  region?: { code: string; nom: string };
  mairie?: GeoPoint;
  centre?: GeoPoint;
  zone?: string;
}

// A commune's town hall hardly moves: kept a month (a code that does not
// exist, an hour).
const cache = new Map<string, { until: number; value: GeoCommune | null }>();
const DAY = 24 * 60 * 60 * 1000;

async function fetchCommune(code: string): Promise<GeoCommune | null> {
  const hit = cache.get(code);
  if (hit && hit.until > Date.now()) return hit.value;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${GEO}/${code}?fields=${FIELDS}`, {
        headers: { "User-Agent": "AuditionsCitoyennes/1.0" },
        signal: AbortSignal.timeout(4000),
      });
      if (res.status === 404) {
        cache.set(code, { until: Date.now() + DAY / 24, value: null });
        return null;
      }
      if (!res.ok) throw new Error(`geo.api.gouv.fr ${res.status}`);
      const value = (await res.json()) as GeoCommune;
      cache.set(code, { until: Date.now() + 30 * DAY, value });
      return value;
    } catch (e) {
      lastError = e;
    }
  }
  const unavailable = new PlaceError(
    "Le service des communes ne répond pas pour le moment. Réessayez dans un instant.",
    503,
  );
  unavailable.cause = lastError;
  throw unavailable;
}

const ordinal = (n: number) => (n === 1 ? "1er" : `${n}e`);

/** "de Lyon", "d'Annecy", "du Havre", "des Lilas". */
function deCommune(name: string): string {
  if (/^Le /.test(name)) return `du ${name.slice(3)}`;
  if (/^Les /.test(name)) return `des ${name.slice(4)}`;
  if (/^[AEIOUYÂÀÉÈÊËÎÏÔÖÛÜŒ]/i.test(name)) return `d'${name}`;
  return `de ${name}`;
}

function splitCityOf(code: string): { name: string; base: number } | null {
  if (/^751\d\d$/.test(code)) return { name: "Paris", base: 75100 };
  if (/^6938\d$/.test(code)) return { name: "Lyon", base: 69380 };
  if (/^132\d\d$/.test(code)) return { name: "Marseille", base: 13200 };
  return null;
}

/**
 * The town hall's name — which is also the online audition's `location`, and
 * so the place's name on the map: it must be unique. Town halls of communes
 * carry their département ("Mairie de Saint-Denis (93)" is not Réunion's).
 */
function mairieLabel(commune: GeoCommune, key: string): string {
  const split = splitCityOf(key);
  if (!split) return `Mairie ${deCommune(commune.nom)} (${commune.departement?.code ?? "?"})`;
  if (key === "75103") return "Mairie de Paris Centre";
  const sector = [key, ...Object.keys(SHARED_MAIRIE).filter((c) => SHARED_MAIRIE[c] === key)]
    .map((c) => Number(c) - split.base)
    .sort((a, b) => a - b);
  if (sector.length > 1) {
    return `Mairie des ${sector.map(ordinal).join(" et ")} arrondissements de ${split.name}`;
  }
  return `Mairie du ${ordinal(sector[0])} arrondissement de ${split.name}`;
}

export interface OnlineTownHall {
  /** INSEE code the town hall is filed under (the online audition's citycode). */
  key: string;
  /** Its name, and the online audition's location. */
  location: string;
  place: OnlinePlace;
}

/** The town hall of the commune or arrondissement with this INSEE code. */
export async function resolveTownHall(insee: string): Promise<OnlineTownHall> {
  if (SPLIT_CITIES.has(insee)) {
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
  const split = splitCityOf(key);
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
  };
}
