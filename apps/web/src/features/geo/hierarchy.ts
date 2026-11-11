// The hierarchy: testimonies rolled up by administrative unit (monde → pays →
// région → département → ville → arrondissement → lieu), each unit carrying a
// count, a weighted centroid, and a bounding box so the camera can frame it.

import { FRANCE_CENTER, isOneTerritory, splitCityNamed, type LocationGroup } from "@ac/shared";
import { boundsCenter, METRO_FRANCE, pointBounds, unionBounds } from "./bounds";
import type { GeoLevel, GeoRef, GeoUnit, HeightClass, LevelKey } from "./types";

/** A lieu's label: its canonical name without the redundant ", <ville>"
 *  suffix (the ville is shown above it in the tree / breadcrumb). */
export function placeLabel(canonical: string, city: string | null | undefined): string {
  if (city) {
    const suffix = `, ${city}`;
    if (canonical.toLowerCase().endsWith(suffix.toLowerCase())) {
      return canonical.slice(0, canonical.length - suffix.length);
    }
  }
  return canonical;
}

interface Builder {
  id: string;
  depth: number;
  levelKey: LevelKey;
  label: string;
  parentId: string | null;
  /** Its parent's childAncestors: one array for all the siblings. */
  ancestors: readonly string[];
  /** Built once, when its first child is. */
  childAncestors?: readonly string[];
  level?: GeoLevel;
  code?: string;
  children: Map<string, Builder>;
  leaf?: { coords: [number, number]; count: number; canonical: string; insee?: string };
}

type ChainArea = Pick<
  LocationGroup,
  "region" | "departementCode" | "departementName" | "city" | "arrondissement" | "canonicalName"
>;

interface ChainStep {
  key: string;
  id: string;
  levelKey: LevelKey;
  label: string;
  /** Where it is found in France's gazetteer, by its label too: its level
   *  (none for a lieu) and its code when the group gives it (the country's,
   *  a département's; a ville's or an arrondissement's INSEE code comes from
   *  its lieux). */
  level?: GeoLevel;
  code?: string;
}

// The units a group sits in, pays first, lieu last: THE id encoding of the
// hierarchy. A ville's lieux hang right under it unless it is split into
// arrondissements; a group with no département skips that level. Every unit of
// the corpus is French; the names are the ones the boundaries are matched by.
function chainSteps(g: ChainArea): ChainStep[] | null {
  if (!g.region) return null; // admin-less → no place on the map
  const steps: ChainStep[] = [];
  const push = (
    key: string,
    levelKey: LevelKey,
    label: string,
    level?: GeoLevel,
    code?: string,
  ) => {
    const parent = steps[steps.length - 1];
    steps.push({ key, id: parent ? `${parent.id}/${key}` : key, levelKey, label, level, code });
  };
  push("France", "country", "France", "country", "FR");
  push(`r:${g.region}`, "region", g.region, "region");
  // An overseas territory is one level: its région (@ac/shared frOverseas).
  if (g.departementCode && !isOneTerritory(g.region, g.departementName)) {
    const label = g.departementName ?? g.departementCode;
    push(`d:${g.departementCode}`, "dep", label, "county", g.departementCode);
  }
  if (g.city) {
    push(`v:${g.city}`, "city", g.city, "locality");
    if (g.arrondissement) push(`a:${g.arrondissement}`, "arr", g.arrondissement, "locality");
  }
  push(`p:${g.canonicalName}`, "place", placeLabel(g.canonicalName, g.city));
  return steps;
}

// A département, a ville and an arrondissement rise half as high (map/lib/polygon).
const HALF_HEIGHT: ReadonlySet<LevelKey> = new Set(["dep", "city", "arr"]);
export function heightClassOf(levelKey: LevelKey): HeightClass {
  return HALF_HEIGHT.has(levelKey) ? "half" : "full";
}

/** A French unit's reference: its step's, with the INSEE code a ville or an
 *  arrondissement shares with its lieux. */
function geoRefOf(b: Builder, insee: string | undefined): GeoRef | undefined {
  const { level, label: nom } = b;
  if (!level) return undefined;
  const code = level === "locality" ? insee : b.code;
  return code === undefined ? { country: "FR", level, nom } : { country: "FR", level, code, nom };
}

/** The ids of every unit a group belongs to, root first: ["France",
 *  "France/r:…", "…/d:…", "…/v:…", ("…/a:…"), "…/p:<canonical>"]; null when it
 *  has no région. The same ids as buildGeoHierarchy's units. */
export function unitChainOf(g: ChainArea): string[] | null {
  return chainSteps(g)?.map((s) => s.id) ?? null;
}

/**
 * Build the full hierarchy from the geocoded map groups. Groups with no région
 * (admin-less / generic locations) are skipped — they carry no place on the map.
 * Returns the synthetic "Monde" root plus an id → unit index.
 */
export function buildGeoHierarchy(groups: LocationGroup[]): {
  root: GeoUnit;
  index: Map<string, GeoUnit>;
} {
  const root: Builder = {
    id: "world",
    depth: 0,
    levelKey: "world",
    label: "Monde",
    parentId: null,
    ancestors: [],
    children: new Map(),
  };

  const ensure = (parent: Builder, step: ChainStep): Builder => {
    let n = parent.children.get(step.key);
    if (!n) {
      n = {
        id: step.id,
        depth: parent.depth + 1,
        levelKey: step.levelKey,
        label: step.label,
        parentId: parent.id,
        // concat: an exact-size array, where a spread's is three times as big.
        ancestors: (parent.childAncestors ??= parent.ancestors.concat(parent.id)),
        level: step.level,
        code: step.code,
        children: new Map(),
      };
      parent.children.set(step.key, n);
    }
    return n;
  };

  for (const g of groups) {
    const steps = chainSteps(g);
    if (!steps) continue; // admin-less → no pin (these get removed upstream)
    let leaf = root;
    for (const step of steps) leaf = ensure(leaf, step);
    leaf.leaf = {
      coords: g.coordinates,
      // Added up: several groups can be the same lieu (the imported meetings
      // come one group each, and some addresses held several).
      count: (leaf.leaf?.count ?? 0) + g.totalTestimonies,
      canonical: g.canonicalName,
      insee: g.citycode ?? undefined,
    };
  }

  const index = new Map<string, GeoUnit>();
  const convert = (b: Builder): GeoUnit => {
    if (b.leaf) {
      const u: GeoUnit = {
        id: b.id,
        depth: b.depth,
        levelKey: b.levelKey,
        label: b.label,
        parentId: b.parentId,
        ancestors: b.ancestors,
        heightClass: heightClassOf(b.levelKey),
        count: b.leaf.count,
        // Copy, don't alias: `coords` comes from caller-supplied LocationGroups
        // and may be a reactive Proxy. GeoUnit.center is read in per-frame paths
        // (marker placement, bounds maths), so the library owns a plain array.
        center: [b.leaf.coords[0], b.leaf.coords[1]],
        bounds: pointBounds(b.leaf.coords),
        children: [],
        canonical: b.leaf.canonical,
        insee: b.leaf.insee,
      };
      index.set(u.id, u);
      return u;
    }
    const children = [...b.children.values()].map(convert).sort((x, y) => y.count - x.count);
    const childBounds = children.length ? unionBounds(children.map((c) => c.bounds)) : METRO_FRANCE;
    const isCountry = b.levelKey === "country";
    // Ville / arrondissement carry the INSEE code shared by all their places (an
    // arrondissement's places share its code; a simple commune's places share the
    // commune code). Paris, Lyon and Marseille, split across arrondissements whose
    // places carry the arrondissement's code, get the whole commune's code.
    const codes = children.map((c) => c.insee);
    const common = codes[0] && codes.every((c) => c === codes[0]) ? codes[0] : undefined;
    // INSEE is meaningful only at ville (commune) and arrondissement — never roll
    // a commune code up into a département/région.
    let insee: string | undefined;
    if (b.levelKey === "city") insee = splitCityNamed(b.label)?.commune ?? common;
    else if (b.levelKey === "arr") insee = common;
    const u: GeoUnit = {
      id: b.id,
      depth: b.depth,
      levelKey: b.levelKey,
      label: b.label,
      parentId: b.parentId,
      ancestors: b.ancestors,
      geoRef: geoRefOf(b, insee),
      heightClass: heightClassOf(b.levelKey),
      count: children.reduce((s, c) => s + c.count, 0),
      center: isCountry ? FRANCE_CENTER : boundsCenter(childBounds),
      bounds: isCountry ? METRO_FRANCE : childBounds,
      children,
      insee,
    };
    index.set(u.id, u);
    return u;
  };

  return { root: convert(root), index };
}

/** Ancestor chain (root → … → unit), inclusive, for breadcrumbs. */
export function ancestorsOf(index: Map<string, GeoUnit>, id: string): GeoUnit[] {
  const chain: GeoUnit[] = [];
  let cur: GeoUnit | undefined = index.get(id);
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentId ? index.get(cur.parentId) : undefined;
  }
  return chain;
}

/**
 * All units of a given LEVEL (for zoom-driven rendering). Keyed by levelKey, not
 * numeric depth, because the hierarchy is ragged — a place under Villeurbanne
 * (no arrondissement) is one level shallower than a place under Lyon 7e.
 */
export function unitsByLevelKey(root: GeoUnit, key: LevelKey): GeoUnit[] {
  const out: GeoUnit[] = [];
  const walk = (u: GeoUnit) => {
    if (u.levelKey === key) {
      out.push(u);
      return; // don't descend past the level we want
    }
    u.children.forEach(walk);
  };
  walk(root);
  return out;
}
