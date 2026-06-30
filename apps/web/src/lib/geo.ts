// Administrative-level aggregation for the testimonies map.
//
// Both navigation prototypes (explicit-scope drill-down and zoom-driven
// aggregation) read from ONE hierarchy built here: testimonies are rolled up by
// administrative unit (monde → pays → région → département → ville →
// arrondissement → lieu), each unit carrying a count, a weighted centroid, and
// a bounding box so the camera can frame it.

import { FRANCE_CENTER, type LocationGroup } from "@ac/shared";

// Metropolitan France extent — used to frame + centre the country pin, since the
// current data covers only a corner and a data-derived centre would be far off.
const METRO_FRANCE: Bounds = { minLat: 41.3, maxLat: 51.1, minLng: -5.2, maxLng: 9.6 };

export type LevelKey =
  | "world"
  | "country"
  | "region"
  | "dep"
  | "city"
  | "arr"
  | "place";

// Depth = index in this list (monde = 0 … lieu = 6).
export const LEVELS: LevelKey[] = [
  "world",
  "country",
  "region",
  "dep",
  "city",
  "arr",
  "place",
];

export interface Bounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface GeoUnit {
  id: string; // path-encoded, e.g. "France/r:Bretagne/d:35"
  depth: number; // 0 world … 6 place
  levelKey: LevelKey;
  label: string;
  parentId: string | null;
  count: number;
  center: [number, number]; // [lat, lng]
  bounds: Bounds;
  children: GeoUnit[];
  /** Leaf places only: the canonical location name (joins back to auditions). */
  canonical?: string;
  /** INSEE code of a commune (ville) or arrondissement municipal — the join key
   *  to fetch its boundary geometry. Undefined for levels above ville. */
  insee?: string;
}

// The three French communes split into arrondissements municipaux — their places
// carry arrondissement INSEE codes, so the ville node needs the commune code.
const BIG3_COMMUNE: Record<string, string> = {
  Paris: "75056",
  Lyon: "69123",
  Marseille: "13055",
};

function pointBounds([lat, lng]: [number, number]): Bounds {
  return { minLat: lat, maxLat: lat, minLng: lng, maxLng: lng };
}

function unionBounds(list: Bounds[]): Bounds {
  return list.reduce((acc, b) => ({
    minLat: Math.min(acc.minLat, b.minLat),
    maxLat: Math.max(acc.maxLat, b.maxLat),
    minLng: Math.min(acc.minLng, b.minLng),
    maxLng: Math.max(acc.maxLng, b.maxLng),
  }));
}

// A macro pin sits at the centre of its area's bounding box — the geometric
// middle of where its children are — rather than a count-weighted centroid that
// would drag it toward the densest child. (A true administrative centroid needs
// real boundary geometry, which the prototype doesn't have yet.)
function boundsCenter(b: Bounds): [number, number] {
  return [(b.minLat + b.maxLat) / 2, (b.minLng + b.maxLng) / 2];
}

// Drop the redundant ", <ville>" suffix from a lieu label (the ville is shown
// above it in the tree / breadcrumb).
function placeLabel(g: LocationGroup): string {
  const canon = g.canonicalName;
  if (g.city) {
    const suffix = `, ${g.city}`;
    if (canon.toLowerCase().endsWith(suffix.toLowerCase())) {
      return canon.slice(0, canon.length - suffix.length);
    }
  }
  return canon;
}

interface Builder {
  id: string;
  depth: number;
  levelKey: LevelKey;
  label: string;
  parentId: string | null;
  children: Map<string, Builder>;
  leaf?: { coords: [number, number]; count: number; canonical: string; insee?: string };
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
    children: new Map(),
  };

  const ensure = (
    parent: Builder,
    key: string,
    levelKey: LevelKey,
    label: string,
  ): Builder => {
    let n = parent.children.get(key);
    if (!n) {
      n = {
        id: parent.depth === 0 ? key : `${parent.id}/${key}`,
        depth: parent.depth + 1,
        levelKey,
        label,
        parentId: parent.id,
        children: new Map(),
      };
      parent.children.set(key, n);
    }
    return n;
  };

  for (const g of groups) {
    if (!g.region) continue; // admin-less → no pin (these get removed upstream)

    let cur = ensure(root, "France", "country", "France");
    cur = ensure(cur, `r:${g.region}`, "region", g.region);
    if (g.departementCode) {
      cur = ensure(cur, `d:${g.departementCode}`, "dep", g.departementName ?? g.departementCode);
    }
    if (g.city) {
      cur = ensure(cur, `v:${g.city}`, "city", g.city);
      if (g.arrondissement) {
        cur = ensure(cur, `a:${g.arrondissement}`, "arr", g.arrondissement);
      }
    }
    const leaf = ensure(cur, `p:${g.canonicalName}`, "place", placeLabel(g));
    leaf.leaf = {
      coords: g.coordinates,
      count: g.totalTestimonies,
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
        count: b.leaf.count,
        center: b.leaf.coords,
        bounds: pointBounds(b.leaf.coords),
        children: [],
        canonical: b.leaf.canonical,
        insee: b.leaf.insee,
      };
      index.set(u.id, u);
      return u;
    }
    const children = [...b.children.values()].map(convert).sort((x, y) => y.count - x.count);
    const childBounds = children.length
      ? unionBounds(children.map((c) => c.bounds))
      : METRO_FRANCE;
    const isCountry = b.levelKey === "country";
    // Ville / arrondissement carry the INSEE code shared by all their places (an
    // arrondissement's places share its code; a simple commune's places share the
    // commune code). Big-3 villes split across arrondissements get the commune code.
    const codes = children.map((c) => c.insee);
    const common = codes[0] && codes.every((c) => c === codes[0]) ? codes[0] : undefined;
    // INSEE is meaningful only at ville (commune) and arrondissement — never roll
    // a commune code up into a département/région.
    let insee: string | undefined;
    if (b.levelKey === "city") insee = BIG3_COMMUNE[b.label] ?? common;
    else if (b.levelKey === "arr") insee = common;
    const u: GeoUnit = {
      id: b.id,
      depth: b.depth,
      levelKey: b.levelKey,
      label: b.label,
      parentId: b.parentId,
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

/** The extent of a unit's children (what its pins span) — for framing on drill.
 *  Differs from `unit.bounds` only for the country, whose bounds is the whole
 *  nation but whose children currently sit in one corner. */
export function childrenBounds(unit: GeoUnit): Bounds {
  if (!unit.children.length) return unit.bounds;
  return unionBounds(unit.children.map((c) => c.bounds));
}

/** A unit's real geometry-derived centre + extent (from the boundaries endpoint). */
export interface UnitGeo {
  center: [number, number];
  bounds: Bounds;
}

/**
 * Override units' data-derived centre/extent with real boundary geometry where
 * available. Régions/départements match by display name (nom); villes/
 * arrondissements match by INSEE code (`byInsee`). Mutates the units in place.
 */
export function applyBoundaries(
  index: Map<string, GeoUnit>,
  byNom: Partial<Record<LevelKey, Map<string, UnitGeo>>>,
  byInsee?: Map<string, UnitGeo>,
): void {
  for (const u of index.values()) {
    // Places keep their exact point coords — only ville/arrondissement units take
    // boundary geometry (and they share their commune's INSEE with their places).
    const byCode =
      (u.levelKey === "city" || u.levelKey === "arr") && u.insee
        ? byInsee?.get(u.insee)
        : undefined;
    const geo = byNom[u.levelKey]?.get(u.label) ?? byCode;
    if (geo) {
      u.center = geo.center;
      u.bounds = geo.bounds;
    }
  }
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

// ---- Zoom ↔ level mapping (zoom-driven mode) -------------------------------

// Which administrative LEVEL a given map zoom should render. Deliberately a
// plain step function (no hysteresis) so the prototype exposes the flicker that
// the scope-driven model avoids — that's part of what we're comparing.
export function levelKeyForZoom(zoom: number): LevelKey {
  if (zoom < 4.6) return "country";
  if (zoom < 6.6) return "region";
  if (zoom < 8.6) return "dep";
  if (zoom < 11) return "city";
  if (zoom < 13) return "arr";
  return "place";
}

// Max zoom used when framing a unit so revealing its children doesn't punch to
// street level on a single-child (point-bounds) unit.
export function zoomCapForDepth(depth: number): number {
  switch (depth) {
    case 1:
      return 5; // pays
    case 2:
      return 6.5; // région
    case 3:
      return 8.2; // département
    case 4:
      return 11; // ville
    case 5:
      return 13; // arrondissement
    default:
      return 14.5; // lieu
  }
}

// ---- Unified scope derivation (map position + zoom → current scope) ----
// The scope is read off the map, not chosen by click: zoom picks the LEVEL, the
// centre picks WHICH unit at that level. The panel shows the scope's children +
// a breadcrumb to fly back out.
const SCOPE_ORDER: LevelKey[] = ["world", "country", "region", "dep", "city", "arr"];

/** The scope LEVEL a zoom resolves to — its children are what gets displayed.
 *  Each level holds while its OWN area roughly fills the view, so you stay on the
 *  wider zones longer (régions to ~7, départements to ~9) instead of deepening
 *  too early / having to dezoom too far to climb back. */
export function scopeLevelForZoom(zoom: number): LevelKey {
  if (zoom < 4.5) return "world";
  if (zoom < 7.0) return "country"; // régions visible
  if (zoom < 9.0) return "region"; // départements
  if (zoom < 11.0) return "dep"; // villes
  if (zoom < 13.0) return "city"; // arrondissements
  return "arr"; // lieux
}

/** Zoom to fly to when a unit of this level becomes the scope (within its band). */
export function showZoomFor(levelKey: LevelKey): number {
  switch (levelKey) {
    case "world":
      return 4;
    case "country":
      return 5.5;
    case "region":
      return 7.5;
    case "dep":
      return 9.5;
    case "city":
      return 11.5;
    default:
      return 13.2; // arr / place
  }
}

function boundsArea(b: Bounds): number {
  return (b.maxLat - b.minLat) * (b.maxLng - b.minLng);
}
function boundsHas(b: Bounds, lat: number, lng: number): boolean {
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

function dist2(a: [number, number], b: [number, number]): number {
  const dlat = a[0] - b[0];
  const dlng = a[1] - b[1];
  return dlat * dlat + dlng * dlng;
}

/** Walk to the unit at the zoom-derived level for the map centre. At each level
 *  descend into the child whose bounds contain the centre (smallest wins where
 *  they overlap); if none does — the centre sits in a gap between sparse units —
 *  descend into the NEAREST child, so the level always tracks the zoom. */
export function scopeForView(root: GeoUnit, center: [number, number], zoom: number): GeoUnit {
  const targetIdx = SCOPE_ORDER.indexOf(scopeLevelForZoom(zoom));
  const [lat, lng] = center;
  let node = root;
  while (SCOPE_ORDER.indexOf(node.levelKey) < targetIdx) {
    const kids = node.children.filter((c) => c.levelKey !== "place");
    if (!kids.length) break;
    const inside = kids.filter((c) => boundsHas(c.bounds, lat, lng));
    node = inside.length
      ? inside.reduce((a, b) => (boundsArea(a.bounds) <= boundsArea(b.bounds) ? a : b))
      : kids.reduce((a, b) => (dist2(a.center, center) <= dist2(b.center, center) ? a : b));
  }
  return node;
}

export const LEVEL_LABEL: Record<LevelKey, string> = {
  world: "Monde",
  country: "Pays",
  region: "Régions",
  dep: "Départements",
  city: "Villes",
  arr: "Arrondissements",
  place: "Lieux",
};

export function levelLabelForDepth(depth: number): string {
  return LEVEL_LABEL[LEVELS[depth] ?? "place"];
}

/** Abbreviate a count: 1000 → "1K", 1_300_000 → "1.3M". */
export function abbrevCount(n: number): string {
  const fmt = (v: number, suffix: string) => {
    const s = v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v));
    return s + suffix;
  };
  if (n < 1000) return String(n);
  if (n < 1_000_000) return fmt(n / 1000, "K");
  if (n < 1_000_000_000) return fmt(n / 1_000_000, "M");
  return fmt(n / 1_000_000_000, "B");
}

/** Does a unit's centroid fall inside a viewport bounds (zoom-mode filtering)? */
export function centerInBounds(u: GeoUnit, b: Bounds): boolean {
  const [lat, lng] = u.center;
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}
