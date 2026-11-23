// The loading curtain's France tilted like the map's ("carte",
// curtainFrame.ts): the poster's outline projected as the pitched camera draws
// it, its bounding box on the map's France. Apart from curtainFrame.ts so that
// it comes with the poster's file (shared/ui/CurtainPoster.vue), not in every
// page's code.
//
// Pure, no DOM: loadable under node (curtainFrame.test.ts).
import { readTable, type FranceAim, type Rect } from "./curtainFrame";

/** Measured: the map's France height over its width, by the same ratio as
 *  FRANCE_WIDTH_SHARE (pitched 45°, on the globe: flatter on a phone, where
 *  France is drawn smaller and the globe's curve shows more). */
export const FRANCE_ASPECT: readonly (readonly [number, number])[] = [
  [0.3716, 0.663],
  [0.3892, 0.6618],
  [0.6339, 0.6521],
  [1.0318, 0.6361],
  [1.0711, 0.6345],
  [1.3221, 0.6275],
];

export const franceAspect = (r: number) => readTable(FRANCE_ASPECT, r);

const PITCH = (45 * Math.PI) / 180;

/** A ring of the poster's outline in its own units (Web Mercator, y down). */
export type Ring = readonly (readonly [number, number])[];

/** The convex hull of the rings' points (monotone chain): the bounding box of
 *  a projected drawing is the projected hull's, while all of it lies before
 *  the camera. */
const hulls = new WeakMap<readonly Ring[], (readonly [number, number])[]>();
function hullOf(rings: readonly Ring[]): (readonly [number, number])[] {
  let hull = hulls.get(rings);
  if (!hull) hulls.set(rings, (hull = hullOfPoints(rings)));
  return hull;
}
function hullOfPoints(rings: readonly Ring[]): (readonly [number, number])[] {
  const pts = rings
    .flat()
    .slice()
    .sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts.length < 3) return pts;
  const cross = (o: readonly number[], a: readonly number[], b: readonly number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: (readonly [number, number])[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: (readonly [number, number])[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** The poster's outline as the pitched camera draws it: a flat ground seen
 *  from a camera pitched 45° at the framed part's centre, its bounding box as
 *  wide as the map's France, as high (FRANCE_ASPECT) and on its centre. The
 *  globe's curve is stood for by the camera's distance, solved to give that
 *  height (within a few px of the map at the measured sizes; no relief). */
export function projectRings(
  rings: readonly Ring[],
  o: { view: Rect; boxH: number; aim: FranceAim },
): [number, number][][] {
  const hull = hullOf(rings);
  if (hull.length < 3 || !(o.aim.width > 0) || !(o.boxH > 0)) return [];
  let vMin = Infinity;
  let vMax = -Infinity;
  let uMin = Infinity;
  let uMax = -Infinity;
  for (const [u, v] of hull) {
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
  }
  const sin = Math.sin(PITCH);
  const cos = Math.cos(PITCH);
  const cy = o.view.top + o.view.height / 2;
  const u0 = (uMin + uMax) / 2;
  const wantH = o.aim.width * franceAspect(o.boxH > 0 ? o.view.width / o.boxH : 0);

  /** For a camera `D` px away: the scale (px per poster unit) and the poster's
   *  row at the camera's centre giving the aimed width and middle. */
  const fit = (D: number) => {
    // dy (px on the ground, + towards the camera) → its offset on screen,
    // and the scale an offset gets there.
    const k = (dy: number) => D / (D - dy * sin);
    const yOf = (dy: number) => dy * cos * k(dy);
    const rowFor = (s: number) => {
      const want = 2 * (o.aim.y - cy);
      // Never so far up that the south passes the camera's plane.
      let lo = vMax - (0.99 * D) / (s * sin);
      let hi = vMax + (10 * D) / s;
      for (let n = 0; n < 40; n++) {
        const v0 = (lo + hi) / 2;
        // A row further down moves the drawing up.
        if (yOf((vMin - v0) * s) + yOf((vMax - v0) * s) > want) lo = v0;
        else hi = v0;
      }
      return (lo + hi) / 2;
    };
    const widthAt = (s: number, v0: number) => {
      let a = Infinity;
      let b = -Infinity;
      for (const [u, v] of hull) {
        const x = (u - u0) * s * k((v - v0) * s);
        if (x < a) a = x;
        if (x > b) b = x;
      }
      return b - a;
    };
    let lo = 0;
    let hi = (4 * o.aim.width) / (uMax - uMin);
    for (let n = 0; n < 32; n++) {
      const s = (lo + hi) / 2;
      if (widthAt(s, rowFor(s)) > o.aim.width) hi = s;
      else lo = s;
    }
    const s = (lo + hi) / 2;
    const v0 = rowFor(s);
    return { s, v0, k, yOf, height: yOf((vMax - v0) * s) - yOf((vMin - v0) * s) };
  };

  // A nearer camera foreshortens more: the height falls with the distance.
  let lo = 0.2 * o.boxH;
  let hi = 8 * o.boxH;
  for (let n = 0; n < 32; n++) {
    const D = (lo + hi) / 2;
    if (fit(D).height > wantH) hi = D;
    else lo = D;
  }
  const { s, v0, k, yOf } = fit((lo + hi) / 2);
  const out = rings.map((ring) =>
    ring.map(([u, v]): [number, number] => {
      const dy = (v - v0) * s;
      return [(u - u0) * s * k(dy), yOf(dy) + cy];
    }),
  );
  let a = Infinity;
  let b = -Infinity;
  for (const ring of out)
    for (const [x] of ring) {
      if (x < a) a = x;
      if (x > b) b = x;
    }
  const shift = o.aim.x - (a + b) / 2;
  for (const ring of out) for (const q of ring) q[0] += shift;
  return out;
}
