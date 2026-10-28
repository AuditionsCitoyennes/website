// The comparer's tree matching (map phase 1, the "comparer" data source, the
// testing tools only): the hierarchy the corpus makes (the map's groups)
// against the server's tree, unit by unit. The ids differ (name paths, unit
// ids), so units are matched by what they are: a country by its code, a
// région by its name, a département by its code, a ville or an arrondissement
// by its INSEE code, a lieu by its canonical name. Every difference of a
// matched pair is listed — count, label, level, centre, box, codes, the
// outline it is given, and the order of its children. A unit of the server's
// tree whose children are not known yet (the lazy path) is compared without
// them.

import {
  buildGeoHierarchy,
  buildTreeFromUnits,
  featureFor,
  outlineSourceOf,
  type GeoUnit,
  type UnitTreeData,
} from "@/features/geo";
import type { LocationGroup } from "@ac/shared";
import type { BoundaryFC } from "./useBoundaryQueries";

export interface TreeDiff {
  /** The unit, as the corpus names it (its path id), or the server's id. */
  id: string;
  field: string;
  corpus: unknown;
  server: unknown;
}

export interface TreeComparison {
  /** The corpus' tree, whole (its lieux name the analyses' largest). */
  corpusIndex: Map<string, GeoUnit>;
  /** The units matched (the world first). */
  pairs: { corpus: GeoUnit; server: GeoUnit }[];
  diffs: TreeDiff[];
  /** Units whose children the server has not sent yet. */
  pending: number;
}

/** What a unit is, whatever its id. */
function matchKey(u: GeoUnit): string {
  switch (u.levelKey) {
    case "world":
      return "world";
    case "country":
      return `country:${u.geoRef?.code ?? u.label}`;
    case "region":
      return `region:${u.label}`;
    case "dep":
      return `dep:${u.geoRef?.code ?? u.label}`;
    case "city":
    case "arr":
      return `${u.levelKey}:${u.insee ?? u.label}`;
    case "place":
      return `place:${u.canonical ?? u.label}`;
  }
}

/** The outline a unit is given: its france-geojson feature's code, its
 *  commune's INSEE code, the métropole, or none. */
function outlineOf(u: GeoUnit, fcs: { regions?: BoundaryFC; departements?: BoundaryFC }): string {
  const src = outlineSourceOf(u);
  if (!src) return "none";
  if (src.kind === "metropole") return "metropole";
  if (src.kind === "commune") return `commune:${src.insee}`;
  const fc = src.kind === "regions" ? fcs.regions : fcs.departements;
  if (!fc) return `${src.kind}:?`;
  return `${src.kind}:${featureFor(fc.features, src)?.properties.code ?? "none"}`;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The corpus' tree of `groups` against the server's tree of `data`. `fcs`:
 * the boundaries loaded, to tell which outline each unit is given (by name
 * for the corpus' régions, by code for the server's).
 */
export function compareTrees(
  groups: LocationGroup[],
  data: UnitTreeData,
  fcs: { regions?: BoundaryFC; departements?: BoundaryFC } = {},
): TreeComparison {
  const built = buildGeoHierarchy(groups);
  const corpus = built.root;
  const server = buildTreeFromUnits(data).root;
  const out: TreeComparison = { corpusIndex: built.index, pairs: [], diffs: [], pending: 0 };

  const walk = (c: GeoUnit, s: GeoUnit) => {
    out.pairs.push({ corpus: c, server: s });
    const diff = (field: string, a: unknown, b: unknown) => {
      if (!same(a, b)) out.diffs.push({ id: c.id, field, corpus: a, server: b });
    };
    diff("levelKey", c.levelKey, s.levelKey);
    diff("label", c.label, s.label);
    diff("count", c.count, s.count);
    diff("depth", c.depth, s.depth);
    diff("heightClass", c.heightClass, s.heightClass);
    diff("center", c.center, s.center);
    diff("bounds", c.bounds, s.bounds);
    diff("insee", c.insee ?? null, s.insee ?? null);
    diff("canonical", c.canonical ?? null, s.canonical ?? null);
    diff("geoRef.country", c.geoRef?.country ?? null, s.geoRef?.country ?? null);
    diff("geoRef.level", c.geoRef?.level ?? null, s.geoRef?.level ?? null);
    diff("geoRef.nom", c.geoRef?.nom ?? null, s.geoRef?.nom ?? null);
    // A région has no code in the corpus (the map's groups carry its name).
    if (c.levelKey !== "region")
      diff("geoRef.code", c.geoRef?.code ?? null, s.geoRef?.code ?? null);
    diff("outline", outlineOf(c, fcs), outlineOf(s, fcs));
    if (s.childrenPending) {
      out.pending++;
      return;
    }
    const sKids = new Map(s.children.map((k) => [matchKey(k), k]));
    const cKids = new Map(c.children.map((k) => [matchKey(k), k]));
    diff("children", c.children.map(matchKey), s.children.map(matchKey));
    for (const [key, ck] of cKids) {
      const sk = sKids.get(key);
      if (sk) walk(ck, sk);
    }
  };
  walk(corpus, server);
  return out;
}
