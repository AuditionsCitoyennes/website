import {
  arrondissementFromCitycode,
  getCanonicalLocation,
  getKnownCoordinates,
  type Audition,
  type AuditionArea,
  type LieuCandidate,
  type LieuPlacement,
  type LocationGroup,
  type MapAudition,
} from "@ac/shared";
import type { GeoEntry } from "../geo/match";
import type { GeoUnitName } from "./geoUnits";
import { onlinePlaceOf, placeKeyOf } from "./lieu";

// /api/map's groups and the admin list's areas from the places stored on the
// rows (map phase 1), in the shapes the geocoder built them in before: a
// group per lieu, its fields from the units on its path. Pure: the rows, the
// units and — for the rows not placed yet — the geocoder's answers come in.

/** The area fields of a lieu, as LocationGroup and AuditionArea carry them. */
export interface LieuArea {
  city: string | null;
  citycode: string | null;
  arrondissement: string | null;
  departementCode: string | null;
  departementName: string | null;
  region: string | null;
}

/** What the grouping reads of an audition row. */
export type PlacedRow = Pick<
  Audition,
  | "location"
  | "audition_en_ligne"
  | "place"
  | "place_path"
  | "locality_id"
  | "lieu_key"
  | "lat"
  | "lng"
  | "place_precision"
  | "place_candidates"
  | "place_stale"
  | "lieu_id"
>;

/** The area of a stored path, from its units; null when one of them is not in `units`. */
export function areaOfPath(
  path: readonly string[],
  localityId: string | null,
  units: ReadonlyMap<string, GeoUnitName>,
): LieuArea | null {
  if (!path.every((id) => units.has(id))) return null;
  const at = (prefix: string) => {
    const id = path.find((p) => p.startsWith(prefix));
    return id ? units.get(id)! : null;
  };
  const leaf = path[path.length - 1];
  const dep = at("fr:dep:");
  const citycode = leaf.startsWith("fr:com:") ? units.get(leaf)!.code : null;
  const locality = localityId ? units.get(localityId) : undefined;
  if (localityId && !locality) return null;
  return {
    city: locality?.name ?? null,
    citycode,
    arrondissement: leaf !== localityId ? arrondissementFromCitycode(citycode) : null,
    departementCode: dep?.code ?? null,
    departementName: dep?.name ?? null,
    region: at("fr:reg:")?.name ?? null,
  };
}

/** The area of a geocoder entry, as the geocoder build gives it. */
export function areaOfEntry(entry: GeoEntry | null | undefined): LieuArea {
  return {
    city: entry?.city ?? null,
    citycode: entry?.citycode ?? null,
    arrondissement: entry?.arrondissement ?? null,
    departementCode: entry?.depCode ?? null,
    departementName: entry?.depName ?? null,
    region: entry?.region ?? null,
  };
}

/** A row's stored place: placed (with its area), unplaced, or not stored yet (stale, or a unit missing). */
export type StoredPlacement =
  | { kind: "placed"; area: LieuArea; path: string[]; lieuId: string; point: [number, number] }
  | { kind: "unplaced" }
  | { kind: "stale" };

export function storedPlacementOf(
  row: PlacedRow,
  units: ReadonlyMap<string, GeoUnitName>,
): StoredPlacement {
  if (row.place_stale !== false) return { kind: "stale" };
  if (!row.place_path) return { kind: "unplaced" };
  const area = areaOfPath(row.place_path, row.locality_id, units);
  if (!area || !row.lieu_id || row.lat === null || row.lng === null) return { kind: "stale" };
  return {
    kind: "placed",
    area,
    path: row.place_path,
    lieuId: row.lieu_id,
    point: [row.lat, row.lng],
  };
}

/** What the map is told of an audition: no text, no author id, no timestamps. */
export function toMapAudition(a: MapRow): MapAudition {
  return {
    id: a.id,
    title: a.title,
    date: a.date,
    location: a.location,
    testimony_count: a.testimony_count,
  };
}

/** An audition as /api/map reads it. */
export type MapRow = PlacedRow &
  Pick<Audition, "id" | "title" | "date"> & { testimony_count: number };

/**
 * /api/map's groups from the stored places: one per lieu (its id), in the
 * order of each lieu's newest audition (`rows` come newest first), its point
 * and area from that audition. As before:
 *   - an online audition's town hall is its own place (auditions.place);
 *   - a lieu on no point (unplaced) is left out.
 * A row not placed yet (`stale`: written by the old app, moved since) is
 * filed as the geocoder filed it — `fallback`, its settled entries by
 * canonical name — and joins the first lieu of that name, where the
 * placement job will put it (text-only placements reuse the lieu's).
 */
export function groupsFromRows(
  rows: readonly MapRow[],
  units: ReadonlyMap<string, GeoUnitName>,
  fallback: ReadonlyMap<string, GeoEntry | null> = new Map(),
): LocationGroup[] {
  const groups: LocationGroup[] = [];
  // By lieu id ("l:…") and by name ("n:…"): the group a row joins.
  const index = new Map<string, LocationGroup>();
  const join = (g: LocationGroup, a: MapRow) => {
    g.auditions.push(toMapAudition(a));
    g.totalTestimonies += a.testimony_count;
  };
  const open = (
    name: string,
    point: [number, number],
    area: LieuArea,
    stored: { path: string[]; lieuId: string } | null,
    a: MapRow,
  ) => {
    const g: LocationGroup = {
      canonicalName: name,
      coordinates: point,
      auditions: [toMapAudition(a)],
      totalTestimonies: a.testimony_count,
      ...area,
      unitPath: stored?.path ?? null,
      lieuId: stored?.lieuId ?? null,
    };
    groups.push(g);
    if (!index.has(`n:${name}`)) index.set(`n:${name}`, g);
    if (stored) index.set(`l:${stored.lieuId}`, g);
    return g;
  };

  for (const a of rows) {
    const stored = storedPlacementOf(a, units);
    const online = onlinePlaceOf(a);
    if (online) {
      const name = placeKeyOf(a);
      const g = index.get(`n:${name}`);
      if (g) join(g, a);
      else {
        open(
          name,
          [online.lat, online.lng],
          {
            city: online.commune,
            citycode: online.insee,
            arrondissement: online.arrondissement,
            departementCode: online.departementCode,
            departementName: online.departementName,
            region: online.region,
          },
          stored.kind === "placed" ? stored : null,
          a,
        );
      }
      continue;
    }
    if (stored.kind === "unplaced") continue;
    if (stored.kind === "placed") {
      const name = a.lieu_key!;
      // Its lieu; else a lieu of that name opened by rows not placed yet,
      // which this one's place will be theirs.
      const byName = index.get(`n:${name}`);
      const g = index.get(`l:${stored.lieuId}`) ?? (byName && !byName.lieuId ? byName : undefined);
      if (g) {
        join(g, a);
        index.set(`l:${stored.lieuId}`, g);
      } else open(name, stored.point, stored.area, stored, a);
      continue;
    }
    // Not placed yet: as the geocoder places it.
    const name = getCanonicalLocation(a.location);
    const g = index.get(`n:${name}`);
    if (g) {
      join(g, a);
      continue;
    }
    const entry = fallback.get(name) ?? null;
    const point = getKnownCoordinates(name) ?? entry?.coords ?? null;
    if (point) open(name, point, areaOfEntry(entry), null, a);
  }
  return groups;
}

const PLACEMENT: Record<string, LieuPlacement> = {
  address: "address",
  commune: "commune",
  // A locality abroad is placed as precisely as a commune; a country, as an area.
  locality: "commune",
  departement: "departement",
  region: "region",
  country: "region",
};

/** The same-named communes stored with an unplaced lieu, as the admins are told them. */
function candidatesOf(value: unknown): LieuCandidate[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((c: Partial<LieuCandidate> | null) => {
    if (!c || typeof c.name !== "string" || !c.name) return [];
    const departementCode = c.departementCode ?? null;
    const key = `${c.name}|${departementCode}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ name: c.name, departementCode }];
  });
}

/**
 * The admin list's area of an audition, from its stored place: where the map
 * files it, and how precisely. A row not placed yet is "pending" (the
 * placement job is on it), with the geocoder's area when it has one
 * (`fallback`, by canonical name).
 */
export function areaOfRow(
  row: PlacedRow,
  units: ReadonlyMap<string, GeoUnitName>,
  fallback: ReadonlyMap<string, GeoEntry | null> = new Map(),
): AuditionArea {
  const online = onlinePlaceOf(row);
  if (online) {
    return {
      canonicalName: placeKeyOf(row),
      city: online.commune,
      departementCode: online.departementCode,
      departementName: online.departementName,
      region: online.region,
      placement: "address",
    };
  }
  const stored = storedPlacementOf(row, units);
  if (stored.kind === "stale") {
    const name = placeKeyOf(row);
    const area = areaOfEntry(fallback.get(name));
    return {
      canonicalName: name,
      city: area.city,
      departementCode: area.departementCode,
      departementName: area.departementName,
      region: area.region,
      placement: "pending",
    };
  }
  const name = row.lieu_key ?? placeKeyOf(row);
  if (stored.kind === "unplaced") {
    return {
      canonicalName: name,
      city: null,
      departementCode: null,
      departementName: null,
      region: null,
      placement: "unplaced",
      ...(row.place_candidates ? { candidates: candidatesOf(row.place_candidates) } : {}),
    };
  }
  return {
    canonicalName: name,
    city: stored.area.city,
    departementCode: stored.area.departementCode,
    departementName: stored.area.departementName,
    region: stored.area.region,
    placement: PLACEMENT[row.place_precision ?? ""] ?? "address",
  };
}
