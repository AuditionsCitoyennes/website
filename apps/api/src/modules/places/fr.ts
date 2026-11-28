import { arrondissementFromCitycode, splitCityOfArrondissement, type GeoUnit } from "@ac/shared";
import { z } from "zod";
import { ByteLru } from "../../lib/byteLru";
import { answerFault, upstreamFetch } from "../../lib/cappedFetch";
import { inseeCode, lineOf, lngLat, placeName } from "../geo/ban";
import { FR_DEPARTMENTS } from "../geo/frDepartments";

// Where a French INSEE code sits — France, its région, its département, its
// commune and, in Paris, Lyon and Marseille, the arrondissement under the
// commune — from the official commune API (geo.api.gouv.fr, "Découpage
// administratif": the live COG). The ids are the map tiles': FR, fr:reg:<code>,
// fr:dep:<code>, fr:com:<code>. The names are geo.api's, but an
// arrondissement's, which keeps the map's "Lyon 7e".
//
// Overseas France is under FR: a DROM is a région (01–06) over its
// département; a collectivité (975, 977, 978, 986–988) is both, under one code.
//
// An answer becomes units of the public map, which nothing corrects
// afterwards: it is read within lib/cappedFetch.ts's limit, never through a
// redirect, and checked before it is used or kept — the code answered is the
// code asked, an INSEE code; the département and the région are ones that
// exist; names are one line of at most 100 characters; points are on the
// globe. An answer that fails is "no such code": nothing is made of it. A
// région, and a département of the static table (geo/frDepartments.ts), are
// named by this file and that table, and such a département sits under the
// région the table gives: of those, an answer only says which.

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

/**
 * The codes the commune API files as a département with no région above: the
 * collectivités d'outre-mer, and the two territories without inhabitants
 * (984, 989).
 */
const COLLECTIVITES = ["975", "977", "978", "984", "986", "987", "988", "989"];
const DEPARTEMENT_CODES = new Set([...Object.keys(FR_DEPARTMENTS), ...COLLECTIVITES]);
/** The régions by their code (the five DROM first), named as FR_DEPARTMENTS names them. */
const FR_REGIONS: Record<string, string> = {
  "01": "Guadeloupe",
  "02": "Martinique",
  "03": "Guyane",
  "04": "La Réunion",
  "06": "Mayotte",
  "11": "Île-de-France",
  "24": "Centre-Val de Loire",
  "27": "Bourgogne-Franche-Comté",
  "28": "Normandie",
  "32": "Hauts-de-France",
  "44": "Grand Est",
  "52": "Pays de la Loire",
  "53": "Bretagne",
  "75": "Nouvelle-Aquitaine",
  "76": "Occitanie",
  "84": "Auvergne-Rhône-Alpes",
  "93": "Provence-Alpes-Côte d'Azur",
  "94": "Corse",
};
const REGION_CODE_OF = new Map(Object.entries(FR_REGIONS).map(([code, name]) => [name, code]));
/** The régions, and the collectivités, each its own. */
const REGION_CODES = new Set([...Object.keys(FR_REGIONS), ...COLLECTIVITES]);

/** A field geo.api may leave out (or null): undefined then. */
const optional = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((v) => v ?? undefined);

const areaOf = (codes: ReadonlySet<string>) =>
  z.object({ code: z.string().refine((code) => codes.has(code)), nom: placeName });
const departementRef = areaOf(DEPARTEMENT_CODES);
const regionRef = areaOf(REGION_CODES);

interface Area {
  code: string;
  nom: string;
}

/** A région under its name here; a collectivité, which this file does not name, under the answer's. */
const namedRegion = (r: Area): Area => ({ code: r.code, nom: FR_REGIONS[r.code] ?? r.nom });

/** A département under the static table's name; one the table lacks, under the answer's. */
const namedDepartement = (d: Area): Area => ({
  code: d.code,
  nom: FR_DEPARTMENTS[d.code]?.name ?? d.nom,
});

/**
 * The région above a département: the table's for a département it holds
 * (none above a collectivité, its own région), whatever the answer said;
 * the answer's for the others.
 */
function regionAbove(dep: Area | undefined, answered: Area | undefined): Area | undefined {
  const known = dep && FR_DEPARTMENTS[dep.code];
  if (!known) return answered && namedRegion(answered);
  const code = REGION_CODE_OF.get(known.region);
  return code ? { code, nom: known.region } : undefined;
}

interface GeoPoint {
  type: "Point";
  coordinates: [number, number]; // [lng, lat]
}

export interface GeoCommune {
  nom: string;
  code: string;
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

const point = z.object({ type: z.literal("Point"), coordinates: lngLat });

// Only the fields read here and in online-testimonies/townHall.ts: what an
// answer holds beyond them is dropped before it is kept. A commune's code
// starts with its département's, and an arrondissement's commune is its
// city's: an answer that says otherwise is refused.
const communeAnswer: z.ZodType<GeoCommune> = z
  .object({
    nom: placeName,
    code: inseeCode,
    codeParent: optional(inseeCode),
    departement: optional(departementRef),
    region: optional(regionRef),
    mairie: optional(point),
    centre: optional(point),
    zone: optional(lineOf(20)),
  })
  .refine((c) => !c.departement || c.code.startsWith(c.departement.code), {
    path: ["departement", "code"],
  })
  .refine(
    (c) => {
      const city = splitCityOfArrondissement(c.code);
      return !c.codeParent || !city || c.codeParent === city.commune;
    },
    { path: ["codeParent"] },
  )
  .transform((c) => ({
    ...c,
    departement: c.departement && namedDepartement(c.departement),
    region: regionAbove(c.departement, c.region),
  }));
const departementAnswer: z.ZodType<GeoDepartement> = departementRef
  .extend({ region: optional(regionRef) })
  .transform((d) => ({ ...namedDepartement(d), region: regionAbove(d, d.region) }));
const regionsAnswer: z.ZodType<GeoRegion[]> = z
  .array(regionRef)
  .max(40)
  .transform((regions) => regions.map(namedRegion));

// Units hardly move: kept a month (a code that does not exist, an hour).
// Bounded: 8 MB of answers as checked (a commune's weighs a few hundred
// bytes) and 2,000 entries — each counts for a 2,000th of the budget at
// least — the least recently read going first.
const DAY = 24 * 60 * 60 * 1000;
const CACHE_MAX_BYTES = 8 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 2000;
const CACHE_ENTRY_MIN_BYTES = Math.ceil(CACHE_MAX_BYTES / CACHE_MAX_ENTRIES);
const cache = new ByteLru<{ until: number; value: unknown }>("geo-api", CACHE_MAX_BYTES, "heap");

function keep(path: string, value: unknown, forMs: number): void {
  const bytes = Buffer.byteLength(JSON.stringify(value)) + path.length;
  cache.set(path, { until: Date.now() + forMs, value }, Math.max(CACHE_ENTRY_MIN_BYTES, bytes));
}

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

const geoFetch = upstreamFetch();

/**
 * One geo.api read, cached; null for a 404, and for an answer `schema`
 * refuses (said in the log: a lieu left unplaced for it is to look at).
 * Throws a 503 PlaceError when the API does not answer, twice (said in the
 * log when the failure is its answer: a redirect, a size, not JSON) — or,
 * `cachedOnly`, when the cache does not hold it.
 */
async function geoGet<T>(
  path: string,
  schema: z.ZodType<T>,
  opts: GeoReadOptions = {},
): Promise<T | null> {
  const hit = cache.get(path);
  if (hit && hit.until > Date.now()) return hit.value as T | null;
  if (opts.cachedOnly) throw unavailable(new Error("not cached"));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await geoFetch(`${GEO}${path}`, {
        headers: { "User-Agent": "AuditionsCitoyennes/1.0" },
        signal: AbortSignal.timeout(4000),
      });
      if (res.status === 404) {
        keep(path, null, DAY / 24);
        return null;
      }
      if (!res.ok) throw new Error(`geo.api.gouv.fr ${res.status}`);
      const parsed = schema.safeParse(await res.json());
      if (!parsed.success) {
        const [issue] = parsed.error.issues;
        console.warn("geo.api.gouv.fr: answer refused", {
          path,
          field: issue.path.join("."),
          issue: issue.message,
        });
        keep(path, null, DAY / 24);
        return null;
      }
      keep(path, parsed.data, 30 * DAY);
      return parsed.data;
    } catch (e) {
      lastError = e;
    }
  }
  // A failure that is the API's answer (a redirect, an answer too heavy or
  // not JSON) does not pass by itself: said in the log.
  const fault = answerFault(lastError);
  if (fault) console.warn("geo.api.gouv.fr: call failed", { path, fault });
  throw unavailable(lastError);
}

/** `schema`, for the unit asked by its code: an answer about another code is refused. */
const asked = <T extends { code: string }>(schema: z.ZodType<T>, code: string) =>
  schema.refine((answer) => answer.code === code, { path: ["code"] });

/** A commune or an arrondissement municipal, with its town hall and centre; null when the code does not exist. */
export function fetchCommune(code: string, opts?: GeoReadOptions): Promise<GeoCommune | null> {
  return geoGet(
    `/communes/${encodeURIComponent(code)}?fields=${COMMUNE_FIELDS}`,
    asked(communeAnswer, code),
    opts,
  );
}

/** A département (collectivités d'outre-mer included) with its région; null when the code does not exist. */
export function fetchDepartement(
  code: string,
  opts?: GeoReadOptions,
): Promise<GeoDepartement | null> {
  return geoGet(
    `/departements/${encodeURIComponent(code)}?fields=nom,code,region`,
    asked(departementAnswer, code),
    opts,
  );
}

/** The régions (DROM included; a collectivité's région is its département: fetchDepartement). */
export async function fetchRegions(opts?: GeoReadOptions): Promise<GeoRegion[]> {
  return (await geoGet("/regions?fields=nom,code", regionsAnswer, opts)) ?? [];
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
