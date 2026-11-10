import { createHash } from "node:crypto";
import {
  getCanonicalLocation,
  getKnownCoordinates,
  isGenericLocation,
  LOCATION_RULES,
  normalizeLocation,
  splitCityOfArrondissement,
  type Audition,
  type AuditionPlaceColumn,
  type AuditionPlaceWrite,
  type BanPick,
  type GazetteerPick,
  type Json,
  type PlaceCandidate,
  type PlacePick,
} from "@ac/shared";
import {
  isHomonyms,
  pickHomonym,
  type GeoEntry,
  type GeoLevel,
  type Homonym,
  type Homonyms,
  type Located,
} from "../geo/match";
import {
  FR_GEO_RELEASE,
  frChain,
  frDepartementChain,
  frRegionChain,
  PlaceError,
  type FrChain,
  type GeoReadOptions,
  type GeoUnitWrite,
} from "./fr";
import { onlinePlaceOf } from "./lieu";

// Where an audition's lieu goes, computed once when the audition is written
// and stored on its row (auditions.place_*), instead of at every read. In
// order (design D5):
//   1. a generic text ("France", "En ligne") is on no point: unplaced;
//   2. a place picked from the world gazetteer is that place (places picker);
//   3. an address an admin picked from the BAN suggestions is that address,
//      in its commune — if it lies there (30 km of its centre), and unless a
//      LOCATION_RULES lieu claims the text — whatever other auditions of the
//      same name say: a pick is how an admin corrects a lieu;
//   4. text alone: a lieu already placed under the same name is where this
//      one goes too (lieux are grouped by name, as on the map before);
//   5. else the geocoder, as before (geo/geocode.ts, geo/match.ts), its
//      same-named communes settled against the lieux already placed.
// The units come from the official commune API (fr.ts). A geocoder or commune
// API that does not answer leaves the row to be placed later ('retry').

/** The first 8 hex of the sha256 of LOCATION_RULES: what a placement was computed under (auditions.placed_rules). */
export function rulesHash(rules: unknown = LOCATION_RULES): string {
  return createHash("sha256").update(JSON.stringify(rules)).digest("hex").slice(0, 8);
}

/** Every place column, so that a placement replaces the previous one whole. */
export type PlaceColumns = Required<Pick<AuditionPlaceWrite, AuditionPlaceColumn>>;

export interface Placement {
  /** The units the columns reference: made sure of (upsertGeoUnits) before the columns are written. */
  units: GeoUnitWrite[];
  columns: PlaceColumns;
  /**
   * The geocoder found same-named communes, and they were not settled
   * (`settle: false`): the columns are the unplaced lieu's, to settle later
   * (settleCandidates) against the support of every lieu placed meanwhile.
   */
  homonyms?: PlaceCandidate[];
}

/** A placement as stored on a row, as reuse copies it. */
export type StoredPlace = Pick<
  Audition,
  | "place_unit"
  | "place_path"
  | "locality_id"
  | "lat"
  | "lng"
  | "place_precision"
  | "place_candidates"
  | "geo_release"
>;

/**
 * The outside world: the geocoder, the commune API, the database. Swapped in
 * tests. `cachedOnly`: answer from what is already known, else 'retry' (the
 * geocoder) or a 503 PlaceError (the commune API) — no call upstream.
 */
export interface PlaceDeps {
  /** The geocoder's answer for a canonical name; 'retry' when it could not be asked. */
  locate(key: string, opts?: GeoReadOptions): Promise<Located | "retry">;
  /** Where an INSEE code sits (null: no such code); throws a 503 PlaceError when geo.api is down. */
  commune(insee: string, opts?: GeoReadOptions): Promise<FrChain | null>;
  departement(code: string, opts?: GeoReadOptions): Promise<FrChain | null>;
  /** A région, by its name as the geocoder spells it. */
  region(name: string, opts?: GeoReadOptions): Promise<FrChain | null>;
  /** A placed, up-to-date French offline audition's place under this lieu key, under the current rules. */
  reuse(key: string): Promise<StoredPlace | null>;
  /** Per département code, the lieux that settle same-named communes (placement_support()). */
  support(): Promise<Map<string, number>>;
}

export interface PlaceOptions {
  pick?: PlacePick;
  deps?: Partial<PlaceDeps>;
  /**
   * false: same-named communes are not settled here but returned unplaced,
   * with `homonyms` (the job settles them at the end of its pass). Default true.
   */
  settle?: boolean;
  /** No call to the geocoder or the commune API: their caches, else 'retry'. */
  cachedOnly?: boolean;
}

/** The database or an upstream did not answer: try again later (a PlaceDeps member may throw it). */
export class RetryLater extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryLater";
  }
}

const STORED =
  "place_unit, place_path, locality_id, lat, lng, place_precision, place_candidates, geo_release";

// The database and the geocoder's cache, loaded on first use: the backfill
// generator (scripts/place-backfill) places lieux with this module and deps of
// its own, without the API's configuration (config.ts reads apps/api/.env).
const database = async () => (await import("../../lib/supabase")).adminClient;
const geocoder = () => import("../geo/geocode");

export const defaultPlaceDeps: PlaceDeps = {
  async locate(key, opts) {
    const { getCachedEntry, resolve } = await geocoder();
    if (opts?.cachedOnly) {
      const known = getCachedEntry(key);
      return known === undefined ? "retry" : known;
    }
    const v = await resolve(key);
    // null without a cache entry: the lookup failed (or is backing off), it is not "no place".
    return v === null && getCachedEntry(key) === undefined ? "retry" : v;
  },
  commune: frChain,
  departement: frDepartementChain,
  region: frRegionChain,
  async reuse(key) {
    // Only a placement computed under the rules in force: one made under
    // others (before the boot's rules pass, or by an older instance still
    // running) is not copied — copied, it would carry the current stamp, and
    // no rules pass would ever correct it.
    const { data, error } = await (
      await database()
    )
      .from("auditions")
      .select(STORED)
      .eq("lieu_key", key)
      .eq("audition_en_ligne", false)
      .eq("place_stale", false)
      .eq("placed_rules", rulesHash())
      .not("place_path", "is", null)
      .like("place_unit", "fr:%")
      .order("created_at", { ascending: false, nullsFirst: false })
      .order("id")
      .limit(1);
    if (error) throw new RetryLater(`reuse: ${error.message}`);
    return data[0] ?? null;
  },
  async support() {
    const { data, error } = await (await database()).rpc("placement_support");
    if (error) throw new RetryLater(`placement_support: ${error.message}`);
    const counts = (data ?? {}) as Record<string, number>;
    return new Map(Object.entries(counts));
  },
};

/** How far from its commune's centre a picked address may lie. */
const PICK_MAX_KM = 30;

/** Great-circle distance in km between two [lat, lng]. */
export function distanceKm([lat1, lng1]: [number, number], [lat2, lng2]: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const PRECISION: Record<GeoLevel, PlaceColumns["place_precision"]> = {
  address: "address",
  commune: "commune",
  departement: "departement",
  region: "region",
};

/**
 * Where a lieu goes: a placement to store (placed or unplaced), or 'retry'
 * when the geocoder, the commune API or the database did not answer.
 * `location` is the audition's, as stored (normalised).
 */
export async function placeLieu(
  location: string,
  opts: PlaceOptions = {},
): Promise<Placement | "retry"> {
  const deps = withReadOptions({ ...defaultPlaceDeps, ...opts.deps }, opts);
  const { pick } = opts;
  try {
    if (pick?.kind === "gazetteer") return placeGazetteerPick(pick);
    const key = getCanonicalLocation(location);
    if (isGenericLocation(key)) return unplaced(location, key, null);
    if (pick?.kind === "ban") {
      // An explicit pick never yields to another audition's placement; one
      // that does not hold up is the geocoder's to place, from the text.
      const placed = await placeBanPick(location, key, pick, deps);
      if (placed) return placed;
    } else {
      const reused = await deps.reuse(key);
      if (reused) return fromStored(location, key, reused);
    }
    return await placeByGeocoder(location, key, deps, opts.settle ?? true);
  } catch (e) {
    if (e instanceof RetryLater || (e instanceof PlaceError && e.status === 503)) return "retry";
    throw e;
  }
}

/** Places picked from the world gazetteer arrive with the places picker (the schemas refuse them until then). */
function placeGazetteerPick(pick: GazetteerPick): never {
  throw new Error(`gazetteer picks are not supported yet (${pick.country} ${pick.unit_id})`);
}

/**
 * An address picked from the BAN suggestions: in its commune, at its point —
 * if that lies within 30 km of the commune's centre. Null (the text places
 * it) otherwise, and for a curated lieu: its rule says where it is, and the
 * commune is the one under its curated point — a pick whose text a rule
 * claims ("Rue d'Hébron" holds "bron") must not pin the rule's point under
 * the picked commune.
 */
async function placeBanPick(
  location: string,
  key: string,
  pick: BanPick,
  deps: PlaceDeps,
): Promise<Placement | null> {
  if (getKnownCoordinates(key)) return null;
  const chain = await deps.commune(pick.citycode);
  const point: [number, number] = [pick.lat, pick.lng];
  if (!chain?.centre || distanceKm(point, chain.centre) > PICK_MAX_KM) return null;
  // Every pick is a precise point (BAN_PICK_TYPES).
  return placed(location, key, chain, point, "address", null);
}

/** The deps with the read options bound (`cachedOnly`: no upstream call). */
function withReadOptions(deps: PlaceDeps, opts: PlaceOptions): PlaceDeps {
  if (!opts.cachedOnly) return deps;
  const read = { cachedOnly: true };
  return {
    ...deps,
    locate: (key) => deps.locate(key, read),
    commune: (insee) => deps.commune(insee, read),
    departement: (code) => deps.departement(code, read),
    region: (name) => deps.region(name, read),
  };
}

async function placeByGeocoder(
  location: string,
  key: string,
  deps: PlaceDeps,
  settle: boolean,
): Promise<Placement> {
  const v = await deps.locate(key);
  if (v === "retry") throw new RetryLater(`geocoder: ${key}`);
  if (v === null) return unplaced(location, key, null);
  if (!isHomonyms(v)) return placeEntry(location, key, v, null, deps);
  const candidates = v.homonyms.map(toCandidate);
  if (!settle) return { ...unplaced(location, key, candidates), homonyms: candidates };
  const settled = pickHomonym(v, await deps.support());
  return settled
    ? placeEntry(location, key, settled, candidates, deps)
    : unplaced(location, key, candidates);
}

/**
 * An unplaced lieu's same-named communes settled again, against the lieux
 * placed since — no geocoder call. Null while still unsettled.
 */
export async function settleCandidates(
  location: string,
  key: string,
  candidates: PlaceCandidate[],
  deps: Partial<PlaceDeps> = {},
): Promise<Placement | null | "retry"> {
  const all: PlaceDeps = { ...defaultPlaceDeps, ...deps };
  try {
    const settled = pickHomonym(fromCandidates(candidates), await all.support());
    return settled ? await placeEntry(location, key, settled, candidates, all) : null;
  } catch (e) {
    if (e instanceof RetryLater || (e instanceof PlaceError && e.status === 503)) return "retry";
    throw e;
  }
}

/** A geocoder entry, placed: its units from the commune API, its point (a curated lieu's own). */
async function placeEntry(
  location: string,
  key: string,
  entry: GeoEntry,
  candidates: PlaceCandidate[] | null,
  deps: PlaceDeps,
): Promise<Placement> {
  const chain = await chainOfEntry(entry, deps);
  if (!chain) return unplaced(location, key, candidates);
  const known = getKnownCoordinates(key);
  const precision = known ? "address" : PRECISION[entry.level];
  return placed(location, key, chain, known ?? entry.coords, precision, candidates);
}

async function chainOfEntry(entry: GeoEntry, deps: PlaceDeps): Promise<FrChain | null> {
  if (entry.citycode) {
    return (await deps.commune(entry.citycode)) ?? (await communeFromEntry(entry, deps));
  }
  if (entry.level === "departement" && entry.depCode) return deps.departement(entry.depCode);
  if (entry.level === "region" && entry.region) return deps.region(entry.region);
  return null;
}

/**
 * A commune the commune API does not know (BAN ahead of, or behind, the COG):
 * under its département, with BAN's names, as the geocoder filed it before.
 */
async function communeFromEntry(entry: GeoEntry, deps: PlaceDeps): Promise<FrChain | null> {
  const citycode = entry.citycode!;
  const dep = entry.depCode ? await deps.departement(entry.depCode) : null;
  if (!dep || !entry.city) return null;
  const base = { country: "FR", source: "insee", geo_release: FR_GEO_RELEASE } as const;
  const split = splitCityOfArrondissement(citycode);
  const commune = split?.commune ?? citycode;
  const point = { lat: entry.coords[0], lng: entry.coords[1] };
  const units: GeoUnitWrite[] = [
    ...dep.units,
    {
      ...base,
      id: `fr:com:${commune}`,
      parent_id: dep.unit,
      level: "locality",
      name: entry.city,
      code: commune,
      ...(split ? { lat: null, lng: null } : point),
    },
  ];
  if (split) {
    units.push({
      ...base,
      id: `fr:com:${citycode}`,
      parent_id: `fr:com:${commune}`,
      level: "locality",
      name: entry.arrondissement ?? citycode,
      code: citycode,
      ...point,
    });
  }
  const path = units.map((u) => u.id);
  return {
    units,
    path,
    unit: path[path.length - 1],
    localityId: `fr:com:${commune}`,
    centre: entry.coords,
  };
}

function placed(
  location: string,
  key: string,
  chain: FrChain,
  [lat, lng]: [number, number],
  precision: PlaceColumns["place_precision"],
  candidates: PlaceCandidate[] | null,
): Placement {
  return {
    units: chain.units,
    columns: {
      place_unit: chain.unit,
      place_path: chain.path,
      locality_id: chain.localityId,
      lieu_key: key,
      lat,
      lng,
      place_precision: precision,
      place_candidates: candidates as unknown as Json,
      placed_location: location,
      placed_rules: rulesHash(),
      geo_release: FR_GEO_RELEASE,
    },
  };
}

/** On no point of the map, as computed from `location` (its same-named communes, if that is why). */
export function unplaced(
  location: string,
  key: string,
  candidates: PlaceCandidate[] | null,
): Placement {
  return {
    units: [],
    columns: {
      place_unit: null,
      place_path: null,
      locality_id: null,
      lieu_key: key,
      lat: null,
      lng: null,
      place_precision: "unplaced",
      place_candidates: candidates as unknown as Json,
      placed_location: location,
      placed_rules: rulesHash(),
      geo_release: null,
    },
  };
}

/** What keepPlacedAbroad reads of a row. */
export type AbroadRow = Pick<
  Audition,
  | "location"
  | "audition_en_ligne"
  | "place_path"
  | "place_unit"
  | "locality_id"
  | "lat"
  | "lng"
  | "place_precision"
  | "place_candidates"
  | "placed_rules"
  | "geo_release"
>;

/**
 * A row placed abroad (a gazetteer pick, A7) whose text changed without a
 * new pick: it keeps its unit and point, only its lieu's name follows the
 * text. Null for a row placed in France, or not placed.
 */
export function keepPlacedAbroad(row: AbroadRow): Placement | null {
  const path = row.place_path;
  if (!path || path[0] === "FR" || !row.place_unit || row.lat === null || row.lng === null) {
    return null;
  }
  return {
    units: [],
    columns: {
      place_unit: row.place_unit,
      place_path: path,
      locality_id: row.locality_id,
      lieu_key: row.audition_en_ligne ? row.location : normalizeLocation(row.location),
      lat: row.lat,
      lng: row.lng,
      place_precision: row.place_precision,
      place_candidates: row.place_candidates,
      placed_location: row.location,
      placed_rules: row.placed_rules,
      geo_release: row.geo_release,
    },
  };
}

/** What placeOnline reads of a row. */
export type OnlineRow = Pick<Audition, "location" | "audition_en_ligne" | "citycode" | "place">;

/**
 * An online audition: its town hall's units, the point stored with it, its
 * own label as lieu key. 'retry' when the commune API did not answer (or,
 * `cachedOnly`, was not to be asked).
 */
export async function placeOnline(
  row: OnlineRow,
  deps: Partial<PlaceDeps> = {},
  cachedOnly = false,
): Promise<Placement | "retry"> {
  const online = onlinePlaceOf(row);
  const none: Placement = {
    units: [],
    columns: {
      place_unit: null,
      place_path: null,
      locality_id: null,
      lieu_key: row.location,
      lat: null,
      lng: null,
      place_precision: "unplaced",
      place_candidates: null,
      placed_location: row.location,
      placed_rules: null,
      geo_release: null,
    },
  };
  if (!online || !row.citycode) return none;
  let chain;
  try {
    chain = await (deps.commune ?? frChain)(row.citycode, { cachedOnly });
  } catch (e) {
    if (e instanceof PlaceError && e.status === 503) return "retry";
    throw e;
  }
  if (!chain) return none;
  return {
    units: chain.units,
    columns: {
      place_unit: chain.unit,
      place_path: chain.path,
      locality_id: chain.localityId,
      lieu_key: row.location,
      lat: online.lat,
      lng: online.lng,
      // As the online form files it (resolveTownHall): the town hall's own
      // point, or the commune's centre where geo.api has no town hall.
      place_precision: chain.mairie ? "address" : "commune",
      place_candidates: null,
      placed_location: row.location,
      placed_rules: null,
      geo_release: FR_GEO_RELEASE,
    },
  };
}

/** Another audition's placement of the same lieu, copied — its same-named communes too, so that it never counts as support. */
function fromStored(location: string, key: string, s: StoredPlace): Placement {
  return {
    units: [],
    columns: {
      place_unit: s.place_unit,
      place_path: s.place_path,
      locality_id: s.locality_id,
      lieu_key: key,
      lat: s.lat,
      lng: s.lng,
      place_precision: s.place_precision,
      place_candidates: s.place_candidates,
      placed_location: location,
      placed_rules: rulesHash(),
      geo_release: s.geo_release,
    },
  };
}

function toCandidate(h: Homonym): PlaceCandidate {
  return {
    name: h.city ?? "",
    departementCode: h.depCode,
    citycode: h.citycode,
    arrondissement: h.arrondissement,
    departementName: h.depName,
    region: h.region,
    lat: h.coords[0],
    lng: h.coords[1],
    level: h.level,
    population: h.population,
  };
}

function fromCandidates(candidates: PlaceCandidate[]): Homonyms {
  return {
    homonyms: candidates.map((c) => ({
      coords: [c.lat, c.lng],
      city: c.name || null,
      citycode: c.citycode,
      arrondissement: c.arrondissement,
      depCode: c.departementCode,
      depName: c.departementName,
      region: c.region,
      level: c.level,
      population: c.population,
    })),
  };
}

/** A row's stored candidates, when they are what this module stores. */
export function storedCandidates(value: unknown): PlaceCandidate[] | null {
  if (!Array.isArray(value)) return null;
  const ok = value.every(
    (c) =>
      c &&
      typeof c === "object" &&
      typeof (c as PlaceCandidate).lat === "number" &&
      typeof (c as PlaceCandidate).lng === "number",
  );
  return ok ? (value as PlaceCandidate[]) : null;
}
