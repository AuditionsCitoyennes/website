import { arrondissementFromCitycode, splitCityOfArrondissement, type GeoUnit } from "@ac/shared";

// Where a French INSEE code sits — France, its région, its département, its
// commune and, in Paris, Lyon and Marseille, the arrondissement under the
// commune — from the official commune API (geo.api.gouv.fr, "Découpage
// administratif": the live COG). The ids are the map tiles': FR, fr:reg:<code>,
// fr:dep:<code>, fr:com:<code>. The names are geo.api's, but an
// arrondissement's, which keeps the map's "Lyon 7e".
//
// Overseas France is under FR: a DROM is a région (01–06) over its
// département; a collectivité (975, 977, 978) is both, under one code.

const GEO = "https://geo.api.gouv.fr";
const COMMUNE_FIELDS = "nom,code,type,codeParent,departement,region,mairie,centre,zone";

/** What the French units are released as (geo_units.geo_release). */
export const FR_GEO_RELEASE = "geoapi-2026";

/** A place the API cannot take (400), or the commune API down (503); the message is the visitor's. */
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

export interface GeoCommune {
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

interface GeoDepartement {
  nom: string;
  code: string;
  region?: { code: string; nom: string };
}

interface GeoRegion {
  nom: string;
  code: string;
}

// Units hardly move: kept a month (a code that does not exist, an hour).
const DAY = 24 * 60 * 60 * 1000;
const cache = new Map<string, { until: number; value: unknown }>();

/** How a geo.api read may go: `cachedOnly`, from the cache or not at all (no call). */
export interface GeoReadOptions {
  cachedOnly?: boolean;
}

const unavailable = (cause: unknown) => {
  const e = new PlaceError(
    "Le service des communes ne répond pas pour le moment. Réessayez dans un instant.",
    503,
  );
  e.cause = cause;
  return e;
};

/**
 * One geo.api read, cached; null for a 404. Throws a 503 PlaceError when the
 * API does not answer, twice — or, `cachedOnly`, when the cache does not hold it.
 */
async function geoGet<T>(path: string, opts: GeoReadOptions = {}): Promise<T | null> {
  const hit = cache.get(path);
  if (hit && hit.until > Date.now()) return hit.value as T | null;
  if (opts.cachedOnly) throw unavailable(new Error("not cached"));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${GEO}${path}`, {
        headers: { "User-Agent": "AuditionsCitoyennes/1.0" },
        signal: AbortSignal.timeout(4000),
      });
      if (res.status === 404) {
        cache.set(path, { until: Date.now() + DAY / 24, value: null });
        return null;
      }
      if (!res.ok) throw new Error(`geo.api.gouv.fr ${res.status}`);
      const value = (await res.json()) as T;
      cache.set(path, { until: Date.now() + 30 * DAY, value });
      return value;
    } catch (e) {
      lastError = e;
    }
  }
  throw unavailable(lastError);
}

/** A commune or an arrondissement municipal, with its town hall and centre; null when the code does not exist. */
export function fetchCommune(code: string, opts?: GeoReadOptions): Promise<GeoCommune | null> {
  return geoGet<GeoCommune>(`/communes/${encodeURIComponent(code)}?fields=${COMMUNE_FIELDS}`, opts);
}

/** A département (collectivités d'outre-mer included) with its région; null when the code does not exist. */
export function fetchDepartement(
  code: string,
  opts?: GeoReadOptions,
): Promise<GeoDepartement | null> {
  return geoGet<GeoDepartement>(
    `/departements/${encodeURIComponent(code)}?fields=nom,code,region`,
    opts,
  );
}

/** The régions (DROM included; a collectivité's région is its département: fetchDepartement). */
export async function fetchRegions(opts?: GeoReadOptions): Promise<GeoRegion[]> {
  return (await geoGet<GeoRegion[]>("/regions?fields=nom,code", opts)) ?? [];
}

/** A geo_units row as the API writes it. */
export type GeoUnitWrite = Pick<
  GeoUnit,
  | "id"
  | "parent_id"
  | "level"
  | "country"
  | "name"
  | "code"
  | "lat"
  | "lng"
  | "source"
  | "geo_release"
>;

/** Where a French unit sits, root first. */
export interface FrChain {
  /** FR, the région, the département[, the commune[, the arrondissement]]. */
  units: GeoUnitWrite[];
  /** Their ids, root first: an audition's place_path. */
  path: string[];
  /** The last of them: an audition's place_unit. */
  unit: string;
  /** The commune (an arrondissement's too); null above the commune. */
  localityId: string | null;
  /** The leaf's centre ([lat, lng]), when geo.api gives one. */
  centre: [number, number] | null;
  /** The leaf's town hall ([lat, lng]), when geo.api gives one (a commune or arrondissement). */
  mairie?: [number, number] | null;
}

function unit(
  id: string,
  parent: string | null,
  level: "country" | "region" | "county" | "locality",
  name: string,
  code: string | null,
  point: [number, number] | null = null,
): GeoUnitWrite {
  return {
    id,
    parent_id: parent,
    level,
    country: "FR",
    name,
    code,
    lat: point?.[0] ?? null,
    lng: point?.[1] ?? null,
    source: "insee",
    geo_release: FR_GEO_RELEASE,
  };
}

const FRANCE = unit("FR", null, "country", "France", null);

function chainOf(
  units: GeoUnitWrite[],
  localityId: string | null,
  centre: [number, number] | null,
  mairie: [number, number] | null = null,
): FrChain {
  const path = units.map((u) => u.id);
  return { units, path, unit: path[path.length - 1], localityId, centre, mairie };
}

/** France, the région and the département: a collectivité's région is the département itself. */
function upperUnits(
  region: { code: string; nom: string } | undefined,
  dep: { code: string; nom: string },
): GeoUnitWrite[] {
  const reg = region ?? dep;
  return [
    FRANCE,
    unit(`fr:reg:${reg.code}`, "FR", "region", reg.nom, reg.code),
    unit(`fr:dep:${dep.code}`, `fr:reg:${reg.code}`, "county", dep.nom, dep.code),
  ];
}

const latLng = (p: GeoPoint | undefined): [number, number] | null =>
  p ? [p.coordinates[1], p.coordinates[0]] : null;

/** The chain of a commune or arrondissement geo.api returned (null when it lacks its département). */
export function frChainOfCommune(c: GeoCommune): FrChain | null {
  if (!c.departement) return null;
  const units = upperUnits(c.region, c.departement);
  const dep = units[2].id;
  const centre = latLng(c.centre);
  const mairie = latLng(c.mairie);
  const city = splitCityOfArrondissement(c.code);
  if (city) {
    const commune = `fr:com:${c.codeParent ?? city.commune}`;
    units.push(
      unit(commune, dep, "locality", city.name, c.codeParent ?? city.commune),
      unit(
        `fr:com:${c.code}`,
        commune,
        "locality",
        arrondissementFromCitycode(c.code) ?? c.nom,
        c.code,
        centre,
      ),
    );
    return chainOf(units, commune, centre, mairie);
  }
  units.push(unit(`fr:com:${c.code}`, dep, "locality", c.nom, c.code, centre));
  return chainOf(units, `fr:com:${c.code}`, centre, mairie);
}

/** Where the commune or arrondissement with this INSEE code sits; null when the code does not exist. */
export async function frChain(insee: string, opts?: GeoReadOptions): Promise<FrChain | null> {
  const c = await fetchCommune(insee, opts);
  return c ? frChainOfCommune(c) : null;
}

/** Where a département sits (a lieu placed at that level); null when the code does not exist. */
export async function frDepartementChain(
  code: string,
  opts?: GeoReadOptions,
): Promise<FrChain | null> {
  const d = await fetchDepartement(code, opts);
  if (!d) return null;
  return chainOf(upperUnits(d.region, d), null, null);
}

/** Where a région sits (a lieu placed at that level), by its name as the geocoder spells it; null when none is. */
export async function frRegionChain(name: string, opts?: GeoReadOptions): Promise<FrChain | null> {
  const r = (await fetchRegions(opts)).find((x) => x.nom === name);
  if (!r) return null;
  return chainOf([FRANCE, unit(`fr:reg:${r.code}`, "FR", "region", r.nom, r.code)], null, null);
}
