// The hierarchy: testimonies rolled up by administrative unit (monde → pays →
// région → département → ville → arrondissement → lieu), each unit carrying a
// count, a weighted centroid, and a bounding box so the camera can frame it.

import { FRANCE_CENTER, splitCityNamed, type LocationGroup } from "@ac/shared";
import { boundsCenter, METRO_FRANCE, pointBounds, unionBounds } from "./bounds";
import type { GeoLevel, GeoRef, GeoUnit, HeightClass, LevelKey } from "./types";

// Drop the redundant ", <ville>" suffix from a lieu label (the ville is shown
// above it in the tree / breadcrumb).
function placeLabel(g: Pick<LocationGroup, "canonicalName" | "city">): string {
  const canon = g.canonicalName;
  if (g.city) {
    const suffix = `, ${g.city}`;
    if (canon.toLowerCase().endsWith(suffix.toLowerCase())) {
      return canon.slice(0, canon.length - suffix.length);
    }
  }
  return canon;
}

/** What a unit of the corpus' chain is found by in France's gazetteer (its
 *  INSEE code comes later for a ville or an arrondissement: its lieux'). */
type StepRef = { level: GeoLevel; code?: string; nom: string };

interface Builder {
  id: string;
  depth: number;
  levelKey: LevelKey;
  label: string;
  parentId: string | null;
  ancestors: string[];
  ref?: StepRef;
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
  /** None for a lieu. */
  ref?: StepRef;
}

// The units a group sits in, pays first, lieu last: THE id encoding of the
// hierarchy. A ville's lieux hang right under it unless it is split into
// arrondissements; a group with no département skips that level. Every unit of
// the corpus is French; the names are the ones the boundaries are matched by.
function chainSteps(g: ChainArea): ChainStep[] | null {
  if (!g.region) return null; // admin-less → no place on the map
  const steps: ChainStep[] = [];
  const push = (key: string, levelKey: LevelKey, label: string, ref?: StepRef) => {
    const parent = steps[steps.length - 1];
    steps.push({ key, id: parent ? `${parent.id}/${key}` : key, levelKey, label, ref });
  };
  push("France", "country", "France", { level: "country", code: "FR", nom: "France" });
  push(`r:${g.region}`, "region", g.region, { level: "region", nom: g.region });
  if (g.departementCode) {
    const label = g.departementName ?? g.departementCode;
    push(`d:${g.departementCode}`, "dep", label, {
      level: "county",
      code: g.departementCode,
      nom: label,
    });
  }
  if (g.city) {
    push(`v:${g.city}`, "city", g.city, { level: "locality", nom: g.city });
    if (g.arrondissement) {
      push(`a:${g.arrondissement}`, "arr", g.arrondissement, {
        level: "locality",
        nom: g.arrondissement,
      });
    }
  }
  push(`p:${g.canonicalName}`, "place", placeLabel(g));
  return steps;
}

// A département, a ville and an arrondissement rise half as high (map/lib/polygon).
const HALF_HEIGHT: ReadonlySet<LevelKey> = new Set(["dep", "city", "arr"]);
function heightClassOf(levelKey: LevelKey): HeightClass {
  return HALF_HEIGHT.has(levelKey) ? "half" : "full";
}

/** A French unit's reference: the step's, with the INSEE code a ville or an
 *  arrondissement shares with its lieux. */
function geoRefOf(ref: StepRef | undefined, insee: string | undefined): GeoRef | undefined {
  if (!ref) return undefined;
  const code = ref.level === "locality" ? insee : ref.code;
  return code === undefined
    ? { country: "FR", level: ref.level, nom: ref.nom }
    : { country: "FR", level: ref.level, code, nom: ref.nom };
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
        ancestors: [...parent.ancestors, parent.id],
        ref: step.ref,
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
      geoRef: geoRefOf(b.ref, insee),
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
