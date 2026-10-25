// The slabs on the map: each slab's rectangle in its space at its scale, the
// outline of a piece standing on it (its corners rounded), the arcs of a part
// of the themes' ring, and a point of its content box on the map.
import { DEG, lngLatOf, MAX_LAT, type SlabSpace, yOf } from "./constants";
import type { Bbox, SlabBoxPx, SlabScale, SlabScales } from "./slabScales";

export interface SlabRect {
  side: "top" | "bottom";
  /** The content box it was laid out for, CSS px. */
  w: number;
  h: number;
  /** Its box on the map. */
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
  /** Its corners, as its content's: NW, NE, SE, SW ([lng, lat]). */
  corners: [number, number][];
  /** Where it lies in its space (see SlabSpace): the meridian it is centred
   *  on, half its width, its north and south edges. */
  space: SlabSpace;
  mid: number;
  halfX: number;
  yN: number;
  yS: number;
}

/** A box inside a slab's content box, CSS px from its top left corner (north
 *  west): a piece of it, or a box of words laid on one. */
export interface PieceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The point of a slab at fraction (u, v) of its content box, from its NW
 *  corner ([lng, lat]). */
export function slabPointAt(r: SlabRect, u: number, v: number): [number, number] {
  return lngLatOf(r.space, r.mid, -r.halfX + 2 * r.halfX * u, r.yN + (r.yS - r.yN) * v);
}

/** The point of a slab at (x, y) CSS px of its content box ([lng, lat]): the
 *  same map as its words' (affine in its space — on the flat map, exactly
 *  what the words' projective map does on screen). */
export const slabPointPx = (r: SlabRect, x: number, y: number) => slabPointAt(r, x / r.w, y / r.h);

/** The rounding of a piece's corners, as its content box's (CSS px): the
 *  words' boxes are drawn with it (ScopeAnalysisOverlay) — a narrower piece is
 *  rounded at half its width (the themes' bar: a pill). */
export const SLAB_RADIUS_PX = 6;
export const pieceRadius = (b: { w: number; h: number }) =>
  Math.min(SLAB_RADIUS_PX, b.w / 2, b.h / 2);
const ARC_SEGMENTS = 4;
const MAX_EDGE_DEG = 0.25;

function slabRing(
  xW: number,
  xE: number,
  yN: number,
  yS: number,
  rx: number,
  ry: number,
  ll: (x: number, y: number) => [number, number],
): [number, number][] {
  const pts: [number, number][] = [];
  let at: [number, number] = [0, 0];
  const push = (x: number, y: number) => {
    at = [x, y];
    pts.push(ll(x, y));
  };
  // A straight edge in the slab's space from the last point to (x, y), cut to
  // MAX_EDGE_DEG on the map (it follows the globe).
  const lineTo = (x: number, y: number) => {
    const [x0, y0] = at;
    const a = pts[pts.length - 1];
    const b = ll(x, y);
    const n = Math.max(
      1,
      Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / MAX_EDGE_DEG),
    );
    for (let i = 1; i <= n; i++) push(x0 + ((x - x0) * i) / n, y0 + ((y - y0) * i) / n);
  };
  const arc = (cx: number, cy: number, a0: number) => {
    for (let i = 1; i <= ARC_SEGMENTS; i++) {
      const a = (a0 + (90 * i) / ARC_SEGMENTS) * DEG;
      push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
    }
  };
  // Y grows southward: the angles turn clockwise on the map.
  push(xW + rx, yN);
  lineTo(xE - rx, yN);
  arc(xE - rx, yN + ry, -90); // NE
  lineTo(xE, yS - ry);
  arc(xE - rx, yS - ry, 0); // SE
  lineTo(xW + rx, yS);
  arc(xW + rx, yS - ry, 90); // SW
  lineTo(xW, yN + ry);
  arc(xW + rx, yN + ry, 180); // NW, back to the start
  pts[pts.length - 1] = [pts[0][0], pts[0][1]];
  return pts;
}

/** The outline of the piece standing on box `b` of a slab's content box,
 *  its corners rounded (pieceRadius), its edges short enough to follow the
 *  globe; closed (last = first). */
export function pieceOutline(r: SlabRect, b: PieceBox): [number, number][] {
  const kx = (2 * r.halfX) / r.w;
  const ky = (r.yS - r.yN) / r.h;
  const rad = pieceRadius(b);
  return slabRing(
    -r.halfX + b.x * kx,
    -r.halfX + (b.x + b.w) * kx,
    r.yN + b.y * ky,
    r.yN + (b.y + b.h) * ky,
    rad * kx,
    rad * ky,
    (x, y) => lngLatOf(r.space, r.mid, x, y),
  );
}

/** Along a ring's arcs, at most this angle between two points (radians):
 *  some 0.25 px off the true circle for a ring (88 px across) zoomed to four
 *  times its size. */
const ARC_STEP = (6 * Math.PI) / 180;

/**
 * A part of the themes' ring as a piece of its slab: the annular sector from
 * angle `a0` to `a1` (radians, clockwise from 3 o'clock, the box's y growing
 * down — the ring's own SVG geometry, analyses/content/ring), radii `rIn` to
 * `rOut` around (`cx`, `cy`) CSS px of the slab's content box. Its outer and
 * inner arcs, point for point ([lng, lat], a0 to a1 each), mapped onto the
 * map as its words are (slabPointPx): drawn long ("Redressé"), the ring is
 * an ellipse on the ground that reads round from the camera.
 */
export function ringSectorArcs(
  r: SlabRect,
  cx: number,
  cy: number,
  rIn: number,
  rOut: number,
  a0: number,
  a1: number,
): { outer: [number, number][]; inner: [number, number][] } {
  const n = Math.max(1, Math.ceil((a1 - a0) / ARC_STEP));
  const outer: [number, number][] = [];
  const inner: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    const c = Math.cos(a);
    const s = Math.sin(a);
    outer.push(slabPointPx(r, cx + rOut * c, cy + rOut * s));
    inner.push(slabPointPx(r, cx + rIn * c, cy + rIn * s));
  }
  return { outer, inner };
}

/** The slabs of a territory (its box `bbox`) at its scales, for content boxes
 *  `sizes` — the same scale whatever the content, so its words keep their size
 *  on the map. */
export function slabRects(
  bbox: Bbox,
  scales: SlabScales,
  sizes: { top: SlabBoxPx | null; bottom: SlabBoxPx },
): SlabRect[] {
  const mid = (bbox.minLng + bbox.maxLng) / 2;
  const out: SlabRect[] = [];
  const make = (side: "top" | "bottom", sc: SlabScale, box: SlabBoxPx) => {
    const sp = sc.space;
    const yEdge = yOf(sp, side === "top" ? bbox.maxLat : bbox.minLat);
    const yNear = side === "top" ? yEdge - sc.gapU : yEdge + sc.gapU;
    const yFar = side === "top" ? yNear - sc.uy * box.h : yNear + sc.uy * box.h;
    const yN = Math.max(yOf(sp, MAX_LAT), Math.min(yNear, yFar));
    const yS = Math.min(yOf(sp, -MAX_LAT), Math.max(yNear, yFar));
    const halfX = (sc.ux * box.w) / 2;
    if (!(yS > yN) || !(halfX > 0)) return;
    const ll = (x: number, y: number) => lngLatOf(sp, mid, x, y);
    const corners = [ll(-halfX, yN), ll(halfX, yN), ll(halfX, yS), ll(-halfX, yS)];
    // Its corners bound it: a slab in metres is widest in longitude at its
    // poleward edge, and its pieces' rounding only takes from its box.
    const lngs = corners.map((c) => c[0]);
    const lats = corners.map((c) => c[1]);
    out.push({
      side,
      w: box.w,
      h: box.h,
      minLng: Math.min(...lngs),
      maxLng: Math.max(...lngs),
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      corners,
      space: sp,
      mid,
      halfX,
      yN,
      yS,
    });
  };
  if (scales.top && sizes.top) make("top", scales.top, sizes.top);
  make("bottom", scales.bottom, sizes.bottom);
  return out;
}
