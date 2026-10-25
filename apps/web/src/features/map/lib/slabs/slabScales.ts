// Sizing: how big a slab is ON THE MAP, decided once per territory framed. At
// the camera the fit lands on (or the camera of the moment, when the territory
// was reached without one), its words must read at TEXT_SCALE of the type
// scale's own sizes — its content box laid out at those sizes, the slab drawn
// that much smaller —, as close to the plateau as the gap says. From then on
// its size is ground, like any other piece of the map: zoomed in, it grows
// with it.
//
// Words painted on a road are drawn long, so that a driver sees them right. A
// slab is drawn long the same way (north–south): seen at the fit's pitch its
// words come out at their normal proportions instead of squashed by the tilt
// ("Redressé"). Its width is set at its far edge, where it is drawn smallest:
// no letter is ever drawn under its size there (TEXT_SCALE of its token's), at
// most some 10 % over it at the near edge. ("À plat", a DEV option: the slab
// as wide as tall in metres as its box is, the words squashed by the tilt as
// any ground is.)
import { C_EARTH, clampLat, DEG, MAX_LAT, mercX, R_EARTH, type SlabSpace, yOf } from "./constants";
import { slabProjector, type SlabCam, type SlabProjector } from "./slabCamera";

/** A slab's content box, CSS px. */
export interface SlabBoxPx {
  w: number;
  h: number;
}

/** How a slab of a territory is sized on the map, in its space's units (see
 *  SlabSpace): across and along per CSS px of its box, and its gap to the
 *  territory's box. Fixed per territory framed: its content changing (a
 *  filter) keeps its scale, so its words keep their size on the map. */
export interface SlabScale {
  space: SlabSpace;
  ux: number;
  uy: number;
  gapU: number;
}

export interface SlabScales {
  top: SlabScale | null;
  bottom: SlabScale;
  /** Each slab's ground size as solved, m (its far edge across, its length):
   *  for the probes. */
  metres: { top: { w: number; h: number } | null; bottom: { w: number; h: number } | null };
  /** A solve fell back on the ground scale at the centre (a camera looking
   *  past the horizon): no stretch, sizes approximate. */
  degraded: boolean;
}

export interface Bbox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export interface SolveOpts {
  /** The raised territory's box. */
  bbox: Bbox;
  /** The lid's height, m (the plateau's, its overshoot included). */
  liftM: number;
  cam: SlabCam;
  top: SlabBoxPx | null;
  bottom: SlabBoxPx;
  /** Between the territory and each slab, on screen at that camera, px: from
   *  its lid's top edge to the themes, from its near wall's foot to the plaque. */
  gapPx: number;
  /** Drawn long ("Redressé"), else as wide as tall in metres as its box ("À plat"). */
  anamorphic: boolean;
  /** On screen per CSS px of a box, right after that camera (see TEXT_SCALE;
   *  1 when absent: the type scale's own sizes). */
  textScale?: number;
  /** Kept over the type scale's sizes, for the models' errors (see SLAB_SAFETY). */
  safety?: number;
}

/**
 * Kept over the type scale's sizes: on the globe and through its morph into
 * mercator, the sphere model stands for mapbox's globe camera (its scale at
 * 45°, its morph — not checked against it pixel for pixel): 5 %. On the flat
 * map the projection is the plateau layer's own, exactly: 2 % (rounding).
 */
export const SLAB_SAFETY = 1.05;
export const SLAB_SAFETY_FLAT = 1.02;

/** The latitude along meridian `lng` whose point at `alt` projects on screen
 *  row `y`, going from `from` toward `dir` (+1 north, −1 south). Null: none
 *  (past the horizon). */
function latForRow(
  P: SlabProjector,
  lng: number,
  alt: number,
  y: number,
  from: number,
  dir: 1 | -1,
): number | null {
  const p = new Float64Array(2);
  const rowAt = (lat: number) => (P.project(lng, lat, alt, p) ? p[1] : NaN);
  // Going north the rows go up the screen (they fall): `want` < 0 below the row.
  const want = (lat: number) => dir * (rowAt(lat) - y);
  let lo = from;
  const w0 = want(lo);
  if (!Number.isFinite(w0)) return null;
  if (w0 <= 0) return lo;
  // A first step from the local slope, doubled until the row is crossed.
  const d = 1e-3;
  const slope = Math.abs(rowAt(lo + dir * d) - rowAt(lo)) / d;
  let step = slope > 0 && Number.isFinite(slope) ? Math.abs(rowAt(lo) - y) / slope : 0.1;
  step = Math.min(Math.max(step, 1e-7), 20);
  let hi = NaN;
  for (let i = 0; i < 40; i++) {
    const at = clampLat(lo + dir * step);
    const v = want(at);
    if (!Number.isFinite(v)) {
      step /= 2; // past the horizon: come back short of it
      if (step < 1e-9) return null;
      continue;
    }
    if (v <= 0) {
      hi = at;
      break;
    }
    lo = at;
    if (Math.abs(at) >= MAX_LAT) return null;
    step *= 2;
  }
  if (!Number.isFinite(hi)) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const v = want(mid);
    if (!Number.isFinite(v)) hi = mid;
    else if (v > 0) lo = mid;
    else hi = mid;
    if (Math.abs(hi - lo) < 1e-10) break;
  }
  return (lo + hi) / 2;
}

/** Half the longitude span, centred on `lng`, that projects `width` px wide
 *  along latitude `lat` at `alt`. Null: none. */
function halfLngForWidth(
  P: SlabProjector,
  lng: number,
  lat: number,
  alt: number,
  width: number,
): number | null {
  const a = new Float64Array(2);
  const b = new Float64Array(2);
  const widthAt = (d: number) =>
    P.project(lng - d, lat, alt, a) && P.project(lng + d, lat, alt, b)
      ? Math.hypot(b[0] - a[0], b[1] - a[1])
      : NaN;
  const d0 = 1e-3;
  const w0 = widthAt(d0);
  if (!(w0 > 0)) return null;
  let lo = 0;
  let hi = Math.min(60, (d0 * width) / w0);
  for (let i = 0; i < 40 && !(widthAt(hi) >= width); i++) {
    lo = hi;
    hi = Math.min(90, hi * 2);
    if (hi >= 90) return null;
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const v = widthAt(mid);
    if (Number.isFinite(v) && v < width) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-11) break;
  }
  return (lo + hi) / 2;
}

/**
 * The slabs' scales for a territory framed by `cam` (see SlabScale): right
 * after that camera stands, each slab's near edge is `gapPx` from the
 * territory on screen — over the middle of its box's top edge (its lid's), or
 * under the middle of its bottom edge (its near wall's foot) —, its far edge
 * `h` × textScale × safety beyond it ("Redressé"), and its far edge `w` ×
 * textScale × safety wide: the words at textScale of their sizes, never under.
 */
export function solveSlabScales(o: SolveOpts): SlabScales {
  const P = slabProjector(o.cam);
  const ts = o.textScale !== undefined && o.textScale > 0 ? o.textScale : 1;
  const k = (o.safety ?? (P.t >= 1 ? SLAB_SAFETY_FLAT : SLAB_SAFETY)) * ts;
  const space: SlabSpace = P.t < 0.5 ? "ground" : "mercator";
  const { bbox, liftM, gapPx } = o;
  const mid = (bbox.minLng + bbox.maxLng) / 2;
  const p = new Float64Array(2);
  let degraded = false;

  /** One slab: its scale, and its ground size. */
  const solve = (side: "top" | "bottom", box: SlabBoxPx) => {
    const edgeLat = side === "top" ? bbox.maxLat : bbox.minLat;
    const dir: 1 | -1 = side === "top" ? 1 : -1;
    // The territory's edge as seen: the lid's top edge above it; below, its
    // near wall's foot, which hangs under the lid's edge.
    if (!P.project(mid, edgeLat, side === "top" ? liftM : 0, p)) return null;
    const yE = p[1];
    // Up the screen (−) for the top slab, down (+) for the bottom one.
    const near = latForRow(P, mid, liftM, yE - dir * gapPx, edgeLat, dir);
    if (near === null) return null;
    let far: number | null;
    let half: number | null;
    if (o.anamorphic) {
      far = latForRow(P, mid, liftM, yE - dir * (gapPx + box.h * k), near, dir);
      if (far === null) return null;
      // The far edge from the camera is the north one, either way.
      half = halfLngForWidth(P, mid, Math.max(near, far), liftM, box.w * k);
    } else {
      // As wide as tall in metres as the box is: the north edge sizes the width.
      far = near;
      half = null;
      for (let i = 0; i < 5; i++) {
        const north = Math.max(near, far);
        half = halfLngForWidth(P, mid, north, liftM, box.w * k);
        if (half === null) return null;
        const wM = 2 * half * DEG * R_EARTH * Math.cos(north * DEG);
        const hM = (wM * box.h) / box.w;
        far = clampLat(near + (dir * hM) / R_EARTH / DEG);
      }
    }
    if (half === null || far === null) return null;
    const north = Math.max(near, far);
    const south = Math.min(near, far);
    const wM = 2 * half * DEG * R_EARTH * Math.cos(north * DEG);
    const across = space === "mercator" ? mercX(mid + half) - mercX(mid - half) : wM;
    const scale: SlabScale = {
      space,
      ux: across / box.w,
      uy: (yOf(space, south) - yOf(space, north)) / box.h,
      gapU: Math.abs(yOf(space, edgeLat) - yOf(space, near)),
    };
    return { scale, metres: { w: wM, h: (north - south) * DEG * R_EARTH } };
  };

  /** No camera to size from (the box past the horizon): the ground's scale
   *  at the centre, as wide as tall, no stretch. */
  const fallback = (): SlabScale => {
    degraded = true;
    const mPerPx = 1 / P.pxPerM;
    const toU = space === "mercator" ? 1 / (C_EARTH * Math.cos(P.lat0 * DEG)) : 1;
    return { space, ux: mPerPx * toU * k, uy: mPerPx * toU * k, gapU: gapPx * mPerPx * toU };
  };
  const good = (s: ReturnType<typeof solve>) => {
    const c = s?.scale;
    return c && c.ux > 0 && c.uy > 0 && Number.isFinite(c.ux + c.uy + c.gapU) ? s : null;
  };

  const t = o.top ? good(solve("top", o.top)) : null;
  const b = good(solve("bottom", o.bottom));
  const top = o.top ? (t ? t.scale : fallback()) : null;
  const bottom = b ? b.scale : fallback();
  return { top, bottom, degraded, metres: { top: t?.metres ?? null, bottom: b?.metres ?? null } };
}
