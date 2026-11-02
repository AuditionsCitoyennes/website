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
// - offLid: the vertices of lifted focus rings within NEAR_M of the scope's
//   boundary that are not (to 5 decimals, the files' precision) a vertex of
//   the scope's rings. The gate: 0.
// - nearMiss: those of them within NEAR_M of a scope vertex: the same point,
//   written differently.
// - liftedShare: of the lifted focus segments lying on the boundary (both
//   ends and the middle within NEAR_M), the share by length whose both ends
//   are scope vertices; null when none lies on it. The gate: 1.
// Only over the focus lines handed in (the panel's units, not every commune):
// how much of the boundary they cover is not asked.

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
  /** Metres of lifted focus segments lying on the boundary (liftedShare's
   *  denominator): how much the share stands on. */
  boundaryM: number;
}

/** Metres: what counts as on the boundary. */
export const NEAR_M = 1;
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

/** The scope's boundary segments in a grid of CELL degrees. */
class Segments {
  private readonly cells = new Map<string, number[]>();
  private readonly segs: (readonly number[])[][] = [];

  add(a: readonly number[], b: readonly number[]) {
    const i = this.segs.push([a, b]) - 1;
    const pad = NEAR_M / M_PER_DEG / Math.max(Math.cos((a[1] * Math.PI) / 180), 0.01);
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

  /** Metres to the nearest segment and to the nearest segment end, from the
   *  segments in p's cell (Infinity when none: farther than NEAR_M). */
  near(p: readonly number[]): { seg: number; vertex: number } {
    let seg = Infinity;
    let vertex = Infinity;
    for (const i of this.cells.get(`${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`) ?? []) {
      const [a, b] = this.segs[i];
      seg = Math.min(seg, toSegment(p, a, b));
      vertex = Math.min(vertex, metres(p, a), metres(p, b));
    }
    return { seg, vertex };
  }
}

/** The lift check of these focus lines on the lid of `scopeSelf`. */
export function liftCheck(scopeSelf: Geom, focus: readonly Geom[]): LiftCheck {
  const scopePolys = polysOf(scopeSelf);
  const lidBoxes = scopePolys.flatMap((poly) => (poly[0] ? [boxOf(poly[0])] : []));
  const keys = new Set<string>();
  const boundary = new Segments();
  for (const poly of scopePolys)
    for (const ring of poly)
      for (let i = 0; i < ring.length; i++) {
        keys.add(keyOf(ring[i]));
        if (i + 1 < ring.length) boundary.add(ring[i], ring[i + 1]);
      }
  let offLid = 0;
  let nearMiss = 0;
  let lifted = 0;
  let onM = 0;
  let sharedM = 0;
  for (const g of focus) {
    const polys = polysOf(g);
    if (!polys.some((p) => p[0] && lidBoxes.some((l) => meets(boxOf(p[0]), l)))) continue;
    lifted++;
    for (const poly of polys)
      for (const ring of poly) {
        const n = ring.length;
        const closed = n > 1 && keyOf(ring[0]) === keyOf(ring[n - 1]);
        const near = ring.map((p) => boundary.near(p));
        for (let i = 0; i < (closed ? n - 1 : n); i++) {
          if (near[i].seg > NEAR_M || keys.has(keyOf(ring[i]))) continue;
          offLid++;
          if (near[i].vertex <= NEAR_M) nearMiss++;
        }
        for (let i = 0; i + 1 < n; i++) {
          const a = ring[i];
          const b = ring[i + 1];
          if (near[i].seg > NEAR_M || near[i + 1].seg > NEAR_M) continue;
          const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          if (boundary.near(mid).seg > NEAR_M) continue;
          const m = metres(a, b);
          onM += m;
          if (keys.has(keyOf(a)) && keys.has(keyOf(b))) sharedM += m;
        }
      }
  }
  return {
    offLid,
    nearMiss,
    liftedShare: onM > 0 ? sharedM / onM : null,
    lifted,
    boundaryM: Math.round(onM),
  };
}
