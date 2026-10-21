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

export type LevelKey = "world" | "country" | "region" | "dep" | "city" | "arr" | "place";

// Depth = index in this list (monde = 0 … lieu = 6).
export const LEVELS: LevelKey[] = ["world", "country", "region", "dep", "city", "arr", "place"];

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

// A small box, not a zero-area point, so a unit with a single location (and no
// fetched boundary polygon) still has a real extent — otherwise fitting it to the
// screen leaves its span at 0 and the viewport-containment scope could never enter
// it. ~0.012° ≈ 1.3 km. Real boundaries override this where available.
const POINT_PAD = 0.012;
function pointBounds([lat, lng]: [number, number]): Bounds {
  return {
    minLat: lat - POINT_PAD,
    maxLat: lat + POINT_PAD,
    minLng: lng - POINT_PAD,
    maxLng: lng + POINT_PAD,
  };
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

interface Builder {
  id: string;
  depth: number;
  levelKey: LevelKey;
  label: string;
  parentId: string | null;
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
}

// The units a group sits in, pays first, lieu last: THE id encoding of the
// hierarchy. A ville's lieux hang right under it unless it is split into
// arrondissements; a group with no département skips that level.
function chainSteps(g: ChainArea): ChainStep[] | null {
  if (!g.region) return null; // admin-less → no place on the map
  const steps: ChainStep[] = [];
  const push = (key: string, levelKey: LevelKey, label: string) => {
    const parent = steps[steps.length - 1];
    steps.push({ key, id: parent ? `${parent.id}/${key}` : key, levelKey, label });
  };
  push("France", "country", "France");
  push(`r:${g.region}`, "region", g.region);
  if (g.departementCode) {
    push(`d:${g.departementCode}`, "dep", g.departementName ?? g.departementCode);
  }
  if (g.city) {
    push(`v:${g.city}`, "city", g.city);
    if (g.arrondissement) push(`a:${g.arrondissement}`, "arr", g.arrondissement);
  }
  push(`p:${g.canonicalName}`, "place", placeLabel(g));
  return steps;
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

/** A département's INSEE code ("94", "2B", "976"), read off its id; undefined
 *  for any other level. */
export function depCodeOf(u: GeoUnit): string | undefined {
  if (u.levelKey !== "dep") return undefined;
  const key = u.id.slice(u.id.lastIndexOf("/") + 1);
  return key.startsWith("d:") ? key.slice(2) : undefined;
}

/**
 * Override units' data-derived centre/extent with real boundary geometry where
 * available. Régions/départements match by display name (nom); villes/
 * arrondissements match by INSEE code (`byInsee`); a département's own outline
 * (`byDep`, by its code) wins over its france-geojson one. Mutates the units in
 * place.
 *
 * A unit left with no geometry (below the country) then spans what its
 * children do, once THEIRS are real: its box was built from its children's
 * before any boundary came in, and an overseas région (france-geojson has the
 * métropole only) kept the 2.6 km box of its one lieu while the commune around
 * it spans 7 km — fitted to the commune, the région was too small a part of the
 * view to hold, and the scope stopped at France.
 */
export function applyBoundaries(
  index: Map<string, GeoUnit>,
  byNom: Partial<Record<LevelKey, Map<string, UnitGeo>>>,
  byInsee?: Map<string, UnitGeo>,
  byDep?: Map<string, UnitGeo>,
): void {
  const placed = new Set<GeoUnit>();
  for (const u of index.values()) {
    // Places keep their exact point coords — only ville/arrondissement units take
    // boundary geometry (and they share their commune's INSEE with their places).
    const byCode =
      (u.levelKey === "city" || u.levelKey === "arr") && u.insee
        ? byInsee?.get(u.insee)
        : undefined;
    const dep = u.levelKey === "dep" ? byDep?.get(depCodeOf(u) ?? "") : undefined;
    const geo = dep ?? byNom[u.levelKey]?.get(u.label) ?? byCode;
    if (geo) {
      u.center = geo.center;
      u.bounds = geo.bounds;
      placed.add(u);
    }
  }
  const span = (u: GeoUnit): void => {
    u.children.forEach(span);
    if (placed.has(u) || !u.children.length) return;
    if (u.levelKey === "world" || u.levelKey === "country" || u.levelKey === "place") return;
    u.bounds = unionBounds(u.children.map((c) => c.bounds));
    u.center = boundsCenter(u.bounds);
  };
  for (const u of index.values()) if (!u.parentId) span(u);
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

// ---- Unified scope derivation (map viewport → current scope) ----
// The scope is read off the map, not chosen by click: we walk the hierarchy from
// the root, descending into the child the viewport sits inside, and the panel
// shows that scope's children + a breadcrumb to climb back out. A child becomes the
// scope once its bbox fills enough of the visible viewport (span ratio), so a click
// (which fits the unit's bounds to the screen) and free pan/zoom resolve to the
// SAME scope — no fixed zoom bands.

// How much of the viewport a unit's bbox spans on its dominant axis (1 = fills it).
function spanRatio(child: Bounds, view: Bounds): number {
  const vLng = view.maxLng - view.minLng;
  const vLat = view.maxLat - view.minLat;
  if (vLng <= 0 || vLat <= 0) return Infinity; // degenerate view → treat as "fills"
  return Math.max((child.maxLng - child.minLng) / vLng, (child.maxLat - child.minLat) / vLat);
}

// Enter a NEW child once it fills 60% of the view; release it below 50%. The small
// gap is hysteresis (no flicker right at the boundary) kept NARROW so zooming back
// out returns to the parent at nearly the same zoom where you entered — a wide band
// read as "it takes more unzoom to leave than zoom to enter". After fitBounds(unit)
// the unit spans ~0.8 of the view, comfortably clearing DESCEND.
export const SPAN_DESCEND = 0.6;
const SPAN_ASCEND = 0.5;
// A sibling taking over the branch (a pan across a border) only has to be a
// fair part of the view: the depth does not change. Since the view's height
// counts the ground the tilt shows, a smaller neighbour (Centre-Val de Loire
// from Nouvelle-Aquitaine) measures under 0.5 there, and at ASCEND's 0.5 the
// walk surfaced all of France instead.
const SPAN_LATERAL = 0.35;

function boundsHas(b: Bounds, lat: number, lng: number): boolean {
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

function dist2(a: [number, number], b: [number, number]): number {
  const dlat = a[0] - b[0];
  const dlng = a[1] - b[1];
  return dlat * dlat + dlng * dlng;
}

/** The unit the viewport is currently "inside", walked from the root. At each level
 *  pick the child the view centre sits in and descend while it fills the view past
 *  the threshold. `prefer` (the previous scope's ancestor chain, self included)
 *  provides HYSTERESIS in both axes: vertically, preferred units hold with the
 *  lower ASCEND threshold; horizontally, the incumbent branch is KEPT while it
 *  still contains the centre — without this, mid-gesture derivations flap between
 *  overlapping siblings (bbox overlaps, or commune polygons not yet loaded) and
 *  each flap sinks/resurrects the plateau ("down, up again, down"). Only a
 *  candidate that provably (polygon) contains the centre while the incumbent does
 *  NOT can take the branch over. `contains` tests real polygon containment. */
export function scopeForView(
  root: GeoUnit,
  view: Bounds,
  prefer?: Set<string>,
  contains?: (unit: GeoUnit, lat: number, lng: number) => boolean,
): GeoUnit {
  const lat = (view.minLat + view.maxLat) / 2;
  const lng = (view.minLng + view.maxLng) / 2;
  let node = root;
  for (;;) {
    const kids = node.children.filter((c) => c.levelKey !== "place");
    if (!kids.length) break;
    // Children whose POLYGON provably contains the centre (when geometry is
    // available), and those whose bbox covers it — the polygon's holders
    // included: a unit can hold a point past its own box (a département holds
    // its communes, whose contours can run past its france-geojson box).
    const insidePoly = contains ? kids.filter((c) => contains(c, lat, lng)) : [];
    const insideBox = kids.filter((c) => boundsHas(c.bounds, lat, lng) || insidePoly.includes(c));
    const incumbent = insideBox.find((c) => prefer?.has(c.id));
    let cand: GeoUnit;
    if (incumbent && (!insidePoly.length || insidePoly.some((c) => c.id === incumbent.id))) {
      cand = incumbent; // sticky: the current branch still holds the centre
    } else {
      const pool = insidePoly.length ? insidePoly : insideBox.length ? insideBox : kids;
      cand = pool.reduce((a, b) =>
        dist2(a.center, [lat, lng]) <= dist2(b.center, [lat, lng]) ? a : b,
      );
    }
    // Hysteresis resists changing DEPTH, not changing SIBLING. If the incumbent
    // branch already runs through this level, adopting a different child here is
    // a LATERAL move (panning from one région to its neighbour), so it keeps the
    // lenient ASCEND threshold. Charging it the stricter DESCEND toll made the
    // walk break as soon as the centre left the current unit — surfacing the
    // PARENT (all of France) instead of the neighbouring région under the centre.
    const lateral = kids.some((c) => prefer?.has(c.id));
    const threshold = prefer?.has(cand.id) ? SPAN_ASCEND : lateral ? SPAN_LATERAL : SPAN_DESCEND;
    if (spanRatio(cand.bounds, view) < threshold) break;
    node = cand;
  }
  return node;
}

/** Ray-cast point-in-polygon for a GeoJSON Polygon/MultiPolygon (coords [lng,lat]).
 *  Used to disambiguate which unit a map point actually falls in. */
export function geometryContains(geom: unknown, lat: number, lng: number): boolean {
  const g = geom as { type?: string; coordinates?: unknown } | undefined;
  if (!g?.type) return false;
  const polys = (
    g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []
  ) as number[][][][];
  let inside = false;
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
    }
  }
  return inside;
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
