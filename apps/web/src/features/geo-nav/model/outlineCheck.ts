// The lift check of `window.__acOutlineCheck()` (testing tools): do the lines
// the plateau lifts onto its lid lie on the lid's edge? Pure: no Vue, no DOM.
//
// The plateau lifts every focus line whose box meets one of the raised
// polygons' boxes (PlateauWallLayer's buildArrays, features/map: the rule is
// copied here, not imported). A lifted line running along the scope's
// boundary is drawn on the lid's edge only where it goes through the lid's
// own vertices: a vertex a metre beside the edge puts the line off it. Under
// ac:contours=fichiers the focus lines are the entries of the scope's own
// bundle, cut by the same run as its self (outlineRules, rule 3), so every
// such vertex is one of the self's.
//
// A segment two lifted rings carry, one each way, is a cut between two
// children: it has a child on either side, so it is inside the lid, never on
// its edge, and it is left out, and so is a vertex between two such cuts,
// however near the edge. Any other lifted segment runs along the boundary
// when it lies on it (both ends and the middle within NEAR_M), when it runs
// beside it (both ends and the middle within BESIDE_M, in the direction of
// the boundary segment nearest its middle: a line displaced metres off the
// edge), or when it leaves a scope vertex in the direction of one of the
// boundary segments there without lying on it and its far end
// (its middle, when both ends are scope vertices) is still within BESIDE_M of
// the boundary or outside the scope (a line bulging off the edge between two
// lid vertices, or running on past the lid's corner). A cut to a child left
// out of the focus lines, leaving the boundary steeply or heading into the
// lid, does none of these.
//
// - offLid: the vertices of lifted focus rings within NEAR_M of the scope's
//   boundary or at an end of a segment running along it that are not (to 5
//   decimals, the files' precision) a vertex of the scope's rings. The
//   gate: 0.
// - nearMiss: those of them within NEAR_M of a scope vertex: the same point,
//   written differently.
// - liftedShare: of the lifted focus segments running along the boundary,
//   the share by length lying on it with both ends scope vertices; null when
//   none runs along it. The gate: 1.
// Only over the focus lines handed in (the panel's units, not every commune):
// how much of the boundary they cover is not asked. Not seen: a stretch of
// line farther than BESIDE_M off the edge whose ends leave the lid's
// vertices steeply (more than 15° off the edge) or bulge into the lid, and a
// ring with no lid vertex at all (it reads null, which fails the gate). Read
// as off the edge although it is not: a cut running within BESIDE_M of the
// edge, nearly along it, to a child left out of the focus lines (it looks
// like the edge moved inward).

interface Geom {
  type?: string;
  coordinates?: unknown;
}
type Ring = readonly (readonly number[])[];
type Box = { minLat: number; maxLat: number; minLng: number; maxLng: number };

export interface LiftCheck {
  offLid: number;
  nearMiss: number;
  liftedShare: number | null;
  /** Focus features lifted onto the lid. */
  lifted: number;
  /** Metres of lifted focus segments running along the boundary
   *  (liftedShare's denominator): how much the share stands on. */
  boundaryM: number;
}

/** Metres: what counts as on the boundary. */
export const NEAR_M = 1;
/** Metres: what counts as beside it (well under the 3 km chords and
 *  Etalab's 50 m tolerance, well over the 5-dp rounding). */
export const BESIDE_M = 25;
/** The sine and cosine of the widest angle (15°) still in the boundary's
 *  direction. */
const SIN_ALONG = Math.sin((15 * Math.PI) / 180);
const COS_ALONG = Math.cos((15 * Math.PI) / 180);
/** Metres per degree of latitude (and of longitude at the equator). */
const M_PER_DEG = 111_195;
/** The segment index's cell, in degrees (~1 km). */
const CELL = 0.01;

const polysOf = (g: Geom): Ring[][] =>
  (g.type === "Polygon"
    ? [g.coordinates]
    : g.type === "MultiPolygon"
      ? g.coordinates
      : []) as Ring[][];

const keyOf = (p: readonly number[]) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;

function boxOf(ring: Ring): Box {
  const b = { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 };
  for (const [lng, lat] of ring) {
    if (lat < b.minLat) b.minLat = lat;
    if (lat > b.maxLat) b.maxLat = lat;
    if (lng < b.minLng) b.minLng = lng;
    if (lng > b.maxLng) b.maxLng = lng;
  }
  return b;
}

// PlateauWallLayer's boundsIntersect (lib/polygon.ts): edges touching count.
const meets = (a: Box, b: Box) =>
  a.minLat <= b.maxLat && a.maxLat >= b.minLat && a.minLng <= b.maxLng && a.maxLng >= b.minLng;

/** Metres from p to the segment a–b, in a plane local to p. */
function toSegment(p: readonly number[], a: readonly number[], b: readonly number[]): number {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const ax = (a[0] - p[0]) * k;
  const ay = a[1] - p[1];
  const dx = (b[0] - a[0]) * k;
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy) * M_PER_DEG;
}

const metres = (a: readonly number[], b: readonly number[]) => toSegment(a, b, b);

/** The vector a→b in a plane local to a (degrees of latitude). */
function vec(a: readonly number[], b: readonly number[]): [number, number] {
  return [(b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]];
}

/** a→b runs in the direction of the line c–d (either way). */
function parallel(
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
  d: readonly number[],
) {
  const [ux, uy] = vec(a, b);
  const [vx, vy] = vec(a, [a[0] + d[0] - c[0], a[1] + d[1] - c[1]]);
  const n = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  return n > 0 && Math.abs(ux * vy - uy * vx) <= SIN_ALONG * n;
}

/** a→b leaves a in the direction a→c. */
function sameWay(a: readonly number[], b: readonly number[], c: readonly number[]) {
  const [ux, uy] = vec(a, b);
  const [vx, vy] = vec(a, c);
  const n = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  return n > 0 && ux * vx + uy * vy >= COS_ALONG * n;
}

/** Ray-cast point-in-polygon (boundaries.ts' geometryContains, copied: this
 *  module imports nothing). */
function holds(polys: readonly Ring[][], p: readonly number[]): boolean {
  let inside = false;
  for (const poly of polys)
    for (const ring of poly)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)
          inside = !inside;
      }
  return inside;
}

/** The scope's boundary segments in a grid of CELL degrees. */
class Segments {
  private readonly cells = new Map<string, number[]>();
  private readonly segs: (readonly number[])[][] = [];

  add(a: readonly number[], b: readonly number[]) {
    const i = this.segs.push([a, b]) - 1;
    const pad = BESIDE_M / M_PER_DEG / Math.max(Math.cos((a[1] * Math.PI) / 180), 0.01);
    const x0 = Math.floor((Math.min(a[0], b[0]) - pad) / CELL);
    const x1 = Math.floor((Math.max(a[0], b[0]) + pad) / CELL);
    const y0 = Math.floor((Math.min(a[1], b[1]) - pad) / CELL);
    const y1 = Math.floor((Math.max(a[1], b[1]) + pad) / CELL);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const c = `${x},${y}`;
        const list = this.cells.get(c);
        if (list) list.push(i);
        else this.cells.set(c, [i]);
      }
  }

  /** Metres to the nearest segment (and that segment) and to the nearest
   *  segment end, from the segments in p's cell (Infinity when none: farther
   *  than BESIDE_M). */
  near(p: readonly number[]): { seg: number; vertex: number; at: (readonly number[])[] | null } {
    let seg = Infinity;
    let vertex = Infinity;
    let at: (readonly number[])[] | null = null;
    for (const i of this.cells.get(`${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`) ?? []) {
      const [a, b] = this.segs[i];
      const d = toSegment(p, a, b);
      if (d < seg) [seg, at] = [d, this.segs[i]];
      vertex = Math.min(vertex, metres(p, a), metres(p, b));
    }
    return { seg, vertex, at };
  }
}

/** The lift check of these focus lines on the lid of `scopeSelf`. */
export function liftCheck(scopeSelf: Geom, focus: readonly Geom[]): LiftCheck {
  const scopePolys = polysOf(scopeSelf);
  const lidBoxes = scopePolys.flatMap((poly) => (poly[0] ? [boxOf(poly[0])] : []));
  /** Each scope vertex's key, to the vertices next to it on its rings. */
  const next = new Map<string, (readonly number[])[]>();
  const boundary = new Segments();
  for (const poly of scopePolys)
    for (const ring of poly)
      for (let i = 0; i < ring.length; i++) {
        const k = keyOf(ring[i]);
        const list = next.get(k) ?? [];
        if (i > 0) list.push(ring[i - 1]);
        if (i + 1 < ring.length) {
          list.push(ring[i + 1]);
          boundary.add(ring[i], ring[i + 1]);
        }
        next.set(k, list);
      }
  // a→b leaves the scope vertex a in the direction of the boundary there.
  const leavesAlong = (a: readonly number[], b: readonly number[]) =>
    (next.get(keyOf(a)) ?? []).some((c) => sameWay(a, b, c));
  const liftedPolys = focus
    .map(polysOf)
    .filter((polys) => polys.some((p) => p[0] && lidBoxes.some((l) => meets(boxOf(p[0]), l))));
  const rings = liftedPolys.flat(2).map((ring) => ({
    ring,
    keys: ring.map(keyOf),
    near: ring.map((p) => boundary.near(p)),
  }));
  /** The lifted segments with an end within BESIDE_M of the boundary (the
   *  only ones that can run along it), as "from>to" keys. */
  const carried = new Set<string>();
  for (const { keys, near } of rings)
    for (let i = 0; i + 1 < keys.length; i++)
      if (Math.min(near[i].seg, near[i + 1].seg) <= BESIDE_M)
        carried.add(`${keys[i]}>${keys[i + 1]}`);
  let offLid = 0;
  let nearMiss = 0;
  let alongM = 0;
  let sharedM = 0;
  for (const { ring, keys, near } of rings) {
    const n = ring.length;
    const closed = n > 1 && keys[0] === keys[n - 1];
    const isKey = keys.map((k) => next.has(k));
    /** Segment i (from vertex i) is a cut between two children. */
    const cut = keys.map(
      (k, i) =>
        i + 1 < n &&
        Math.min(near[i].seg, near[i + 1].seg) <= BESIDE_M &&
        carried.has(`${keys[i + 1]}>${k}`),
    );
    const cutBefore = (i: number) => (i > 0 ? cut[i - 1] : closed && cut[n - 2]);
    const cutAfter = (i: number) => (i + 1 < n ? cut[i] : closed && cut[0]);
    // A vertex between two cuts has children all round: inside the lid, however near its edge.
    const along = ring.map((_, i) => near[i].seg <= NEAR_M && !(cutBefore(i) && cutAfter(i)));
    for (let i = 0; i + 1 < n; i++) {
      if (cut[i]) continue;
      const a = ring[i];
      const b = ring[i + 1];
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const mid = boundary.near(m);
      const on = along[i] && along[i + 1] && mid.seg <= NEAR_M;
      const beside =
        near[i].seg <= BESIDE_M &&
        near[i + 1].seg <= BESIDE_M &&
        mid.at !== null &&
        mid.seg <= BESIDE_M &&
        parallel(a, b, mid.at[0], mid.at[1]);
      // The far end, or the middle of a chord between two scope vertices.
      const [far, farAt] = !isKey[i + 1] ? [b, near[i + 1]] : !isKey[i] ? [a, near[i]] : [m, mid];
      const leaves =
        !on &&
        ((isKey[i] && leavesAlong(a, b)) || (isKey[i + 1] && leavesAlong(b, a))) &&
        (farAt.seg <= BESIDE_M || !holds(scopePolys, far));
      if (!on && !beside && !leaves) continue;
      along[i] = along[i + 1] = true;
      const len = metres(a, b);
      alongM += len;
      if (on && isKey[i] && isKey[i + 1]) sharedM += len;
    }
    if (closed) along[0] ||= along[n - 1];
    for (let i = 0; i < (closed ? n - 1 : n); i++) {
      if (!along[i] || isKey[i]) continue;
      offLid++;
      if (near[i].vertex <= NEAR_M) nearMiss++;
    }
  }
  return {
    offLid,
    nearMiss,
    liftedShare: alongM > 0 ? sharedM / alongM : null,
    lifted: liftedPolys.length,
    boundaryM: Math.round(alongM),
  };
}
