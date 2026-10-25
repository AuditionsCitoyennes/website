// Words on a lid: the content box mapped onto its quad on screen — the
// projective map of a plane seen in perspective, and its CSS matrix3d.

/** Whether four screen points (NW, NE, SE, SW: x0, y0 … x3, y3) make a convex
 *  quad, turning one way, of some size. */
export function isConvexQuad(q: ArrayLike<number>): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const ax = q[2 * i];
    const ay = q[2 * i + 1];
    const bx = q[(2 * i + 2) % 8];
    const by = q[(2 * i + 3) % 8];
    const cx = q[(2 * i + 4) % 8];
    const cy = q[(2 * i + 5) % 8];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (!Number.isFinite(cross) || Math.abs(cross) < 1e-6) return false;
    const s = cross > 0 ? 1 : -1;
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

/**
 * The projective map of the box (0, 0)–(W, H) onto the quad (NW, NE, SE, SW):
 * [a, b, c, d, e, f, g, h] with x' = (a·x + b·y + c) / (g·x + h·y + 1), y'
 * likewise with d, e, f. Exact at the corners; exact everywhere for a plane
 * seen in perspective (the lid on flat ground). Null: no such map (a quad
 * folded, crossed or behind the camera). Written into `out`: nothing is
 * allocated per frame.
 */
export function homography(
  q: ArrayLike<number>,
  W: number,
  H: number,
  out: Float64Array = new Float64Array(8),
): Float64Array | null {
  if (!(W > 0) || !(H > 0) || !isConvexQuad(q)) return null;
  const [x0, y0, x1, y1, x2, y2, x3, y3] = [q[0], q[1], q[2], q[3], q[4], q[5], q[6], q[7]];
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-9) return null;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  // The homogeneous w at the corners (1, 1 + g, 1 + g + h, 1 + h): positive,
  // or the box would be drawn through infinity.
  if (!(1 + g > 0 && 1 + h > 0 && 1 + g + h > 0)) return null;
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  out[0] = a / W;
  out[1] = b / H;
  out[2] = x0;
  out[3] = d / W;
  out[4] = e / H;
  out[5] = y0;
  out[6] = g / W;
  out[7] = h / H;
  return out;
}

/** A point of the box mapped by `m` (see homography), into out. */
export function applyHomography(m: ArrayLike<number>, x: number, y: number, out: number[]): void {
  const w = m[6] * x + m[7] * y + 1;
  out[0] = (m[0] * x + m[1] * y + m[2]) / w;
  out[1] = (m[3] * x + m[4] * y + m[5]) / w;
}

/** The point of the box that `m` maps onto screen point (X, Y), into out —
 *  the two linear equations it makes in x, y. False: none (a degenerate map). */
export function unapplyHomography(
  m: ArrayLike<number>,
  X: number,
  Y: number,
  out: number[],
): boolean {
  const a = m[0] - X * m[6];
  const b = m[1] - X * m[7];
  const d = m[3] - Y * m[6];
  const e = m[4] - Y * m[7];
  const det = a * e - b * d;
  if (!(Math.abs(det) > 1e-12)) return false;
  const c = X - m[2];
  const f = Y - m[5];
  out[0] = (c * e - b * f) / det;
  out[1] = (a * f - c * d) / det;
  return true;
}

// Nine significant digits: the perspective terms are tiny (some 1e-4 per px)
// and rounding them to a fixed number of decimals would bend the words.
const sig = (v: number) => +v.toPrecision(9);

/** The CSS transform for `m` (transform-origin 0 0; CSS matrices are column-major). */
export function matrix3dOf(m: ArrayLike<number>): string {
  return (
    `matrix3d(${sig(m[0])},${sig(m[3])},0,${sig(m[6])},` +
    `${sig(m[1])},${sig(m[4])},0,${sig(m[7])},` +
    `0,0,1,0,${sig(m[2])},${sig(m[5])},0,1)`
  );
}
