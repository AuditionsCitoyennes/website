// The hierarchy from the server's place counts (map phase 1, design E2): the
// units and lieux the Témoignages store holds for one filter key, as a fresh
// GeoUnit tree with the corpus builder's semantics (hierarchy.ts) — counts,
// padded point boxes, France's constant frame, labels, the children's order —
// so that everything downstream reads it unchanged. Ids are the database's:
// "world", ISO countries, fr:reg|dep|com:<INSEE>, l:<hash> for a lieu. Pure.

import {
  FRANCE_CENTER,
  type PlaceLieuRow,
  type PlaceResultLieu,
  type PlaceUnitRow,
} from "@ac/shared";
import { boundsCenter, METRO_FRANCE, pointBounds, unionBounds } from "./bounds";
import { heightClassOf, placeLabel } from "./hierarchy";
import type { Bounds, GeoLevel, GeoRef, GeoUnit, LevelKey } from "./types";

/** The root's id, the counts' "unit" for the whole map. */
export const WORLD = "world";

/** A unit as the store holds it. */
export interface UnitTreeEntry {
  /** Its row, from an answer above it; null for the world and for a unit
   *  asked for that nothing matches. */
  row: PlaceUnitRow | null;
  /** Its child units' ids, once known (`loaded`). */
  childIds?: readonly string[];
  /** Its own lieux' ids, once known (`loaded`). */
  lieuIds?: readonly string[];
  /** Its children and lieux are known. */
  loaded: boolean;
}

/**
 * A lieu known from a list (a result's row) before the tree holds it (the
 * lazy path): placed under its unit — or the deepest unit of its path the
 * tree holds — until its own row comes, or its unit is known without it
 * (map phase 1, design E1, K).
 */
export interface LieuStub extends PlaceResultLieu {
  /** Its matching testimonies, as far as the list knows them. */
  n: number;
}

/** What one filter key's store holds. */
export interface UnitTreeData {
  units: ReadonlyMap<string, UnitTreeEntry>;
  lieux: ReadonlyMap<string, PlaceLieuRow>;
  /** Lieux known from a list only, by id (none: the tree holds every lieu listed). */
  stubs?: ReadonlyMap<string, LieuStub>;
  /** The world's answer held the whole tree. */
  readonly complete?: boolean;
}

/** Something the server orders: units and lieux alike. */
export interface ServerOrdered {
  id: string;
  n: number;
  /** The date of its first lieu's newest audition. */
  rank: string;
  /** That audition's id. */
  tie: string;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The children's order (design A18): testimonies desc, then rank desc, tie,
 * id — today's count sort over /api/map's newest-first groups, so that
 * siblings from different answers merge in that order.
 */
export function byServerOrder(a: ServerOrdered, b: ServerOrdered): number {
  return b.n - a.n || cmp(b.rank, a.rank) || cmp(a.tie, b.tie) || cmp(a.id, b.id);
}

const GEO_LEVELS: ReadonlySet<string> = new Set([
  "country",
  "dependency",
  "region",
  "county",
  "localadmin",
  "locality",
]);

/** The site's level of a gazetteer unit (design E2, step 3). */
function levelKeyOf(row: PlaceUnitRow, parent: PlaceUnitRow | null): LevelKey {
  switch (row.level) {
    case "country":
    case "dependency":
      return "country";
    case "region":
      return "region";
    case "county":
      return "dep";
    case "locality":
      return parent?.level === "locality" ? "arr" : "city";
    default:
      return "city";
  }
}

/** A row's box [min lat, min lng, max lat, max lng], each point padded as
 *  pointBounds pads one: the union of its lieux' boxes. */
function paddedBox(row: PlaceUnitRow): Bounds {
  const [minLat, minLng, maxLat, maxLng] = row.bbox;
  const lo = pointBounds([minLat, minLng]);
  const hi = pointBounds([maxLat, maxLng]);
  // In pointBounds' key order: probes and snapshots print it as the corpus'.
  return { minLat: lo.minLat, maxLat: hi.maxLat, minLng: lo.minLng, maxLng: hi.maxLng };
}

function geoRefOf(row: PlaceUnitRow): GeoRef {
  const level = (GEO_LEVELS.has(row.level) ? row.level : "locality") as GeoLevel;
  // A country's code is its id (geo_units leaves it null).
  const code = row.code ?? (level === "country" || level === "dependency" ? row.id : null);
  return code === null
    ? { country: row.country, level, nom: row.name }
    : { country: row.country, level, code, nom: row.name };
}

/**
 * The tree a store's data makes, rooted at the world. A unit whose children
 * are not known yet has none, and `childrenPending`. Returns the root and an
 * id → unit index.
 */
export function buildTreeFromUnits(data: UnitTreeData): {
  root: GeoUnit;
  index: Map<string, GeoUnit>;
} {
  const index = new Map<string, GeoUnit>();

  const lieuUnit = (
    l: Pick<PlaceLieuRow, "id" | "key" | "city" | "lat" | "lng" | "n">,
    parent: GeoUnit,
  ): GeoUnit => {
    const center: [number, number] = [l.lat, l.lng];
    const u: GeoUnit = {
      id: l.id,
      depth: parent.depth + 1,
      levelKey: "place",
      label: placeLabel(l.key, l.city),
      parentId: parent.id,
      ancestors: [...parent.ancestors, parent.id],
      heightClass: heightClassOf("place"),
      count: l.n,
      center,
      bounds: pointBounds(center),
      children: [],
      canonical: l.key,
      // As the corpus' lieux carry their group's INSEE code: their ville's or
      // arrondissement's.
      insee: parent.levelKey === "city" || parent.levelKey === "arr" ? parent.insee : undefined,
    };
    index.set(u.id, u);
    return u;
  };

  /** A unit's children, lieux among them, in the server's order. */
  const childrenOf = (u: GeoUnit, entry: UnitTreeEntry | undefined): GeoUnit[] => {
    if (!entry?.loaded) return [];
    const kids: (ServerOrdered & { unit?: PlaceUnitRow; lieu?: PlaceLieuRow })[] = [];
    for (const id of entry.childIds ?? []) {
      const row = data.units.get(id)?.row;
      if (row) kids.push({ id, n: row.n, rank: row.rank, tie: row.tie, unit: row });
    }
    for (const id of entry.lieuIds ?? []) {
      const lieu = data.lieux.get(id);
      if (lieu) kids.push({ id, n: lieu.n, rank: lieu.rank, tie: lieu.tie, lieu });
    }
    kids.sort(byServerOrder);
    return kids.map((k) => (k.unit ? unitOf(k.unit, u) : lieuUnit(k.lieu!, u)));
  };

  const unitOf = (row: PlaceUnitRow, parent: GeoUnit): GeoUnit => {
    const parentRow = row.parent ? (data.units.get(row.parent)?.row ?? null) : null;
    const levelKey = levelKeyOf(row, parentRow);
    const geoRef = geoRefOf(row);
    const isFrance = levelKey === "country" && row.id === "FR";
    const bounds = isFrance ? METRO_FRANCE : paddedBox(row);
    const entry = data.units.get(row.id);
    const u: GeoUnit = {
      id: row.id,
      depth: parent.depth + 1,
      levelKey,
      label: row.name,
      parentId: parent.id,
      ancestors: [...parent.ancestors, parent.id],
      geoRef,
      heightClass: heightClassOf(levelKey),
      count: row.n,
      center: isFrance ? FRANCE_CENTER : boundsCenter(bounds),
      bounds,
      children: [],
      insee:
        (levelKey === "city" || levelKey === "arr") && geoRef.country === "FR"
          ? (geoRef.code ?? undefined)
          : undefined,
    };
    if (!entry?.loaded) u.childrenPending = true;
    index.set(u.id, u);
    u.children = childrenOf(u, entry);
    return u;
  };

  const worldEntry = data.units.get(WORLD);
  const root: GeoUnit = {
    id: WORLD,
    depth: 0,
    levelKey: "world",
    label: "Monde",
    parentId: null,
    ancestors: [],
    heightClass: heightClassOf("world"),
    count: 0,
    center: boundsCenter(METRO_FRANCE),
    bounds: METRO_FRANCE,
    children: [],
  };
  index.set(WORLD, root);
  root.children = childrenOf(root, worldEntry);
  if (!worldEntry?.loaded) root.childrenPending = true;
  // As the corpus' root: the sum of its children, framed on their union.
  root.count = root.children.reduce((s, c) => s + c.count, 0);
  if (root.children.length) {
    root.bounds = unionBounds(root.children.map((c) => c.bounds));
    root.center = boundsCenter(root.bounds);
  }
  // Lieux known from a list only, after the counts (a unit's count already
  // holds its lieux'): last among the children of their unit, or of the
  // deepest unit of their path the tree holds — until the tree knows their
  // unit's lieux: then the lieu is there, or it does not match.
  for (const stub of data.stubs?.values() ?? []) {
    if (index.has(stub.id)) continue;
    const own = data.units.get(stub.unit);
    if (own?.loaded && !own.lieuIds?.includes(stub.id)) continue;
    let parent = root;
    for (let i = stub.path.length - 1; i >= 0; i--) {
      const u = index.get(stub.path[i]);
      if (u && u.levelKey !== "place") {
        parent = u;
        break;
      }
    }
    parent.children.push(lieuUnit(stub, parent));
  }
  return { root, index };
}
