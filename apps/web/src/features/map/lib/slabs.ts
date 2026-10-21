// The analyses as SLABS: two small pieces of ground beside the territory, one
// above its top edge (the themes), one under its bottom edge (the plaque),
// each the box its content is laid out in, and the raised pieces standing on
// it at the plateau's height (GeoDrillMap draws them): the plaque one piece,
// the whole box; the themes three in a row — the ring, each of its parts a
// piece of its own, a bar of the theme's colour, the label's box — with the
// ground between them. Their words lie on their lids, glued to the map
// (ScopeAnalysisOverlay): they move, grow, shrink, tilt and turn with it.
//
// Pure — no mapbox, no DOM — so that the sizes can be checked offline.
//
// How big a slab is ON THE MAP is decided once per territory framed: at the
// camera the fit lands on (or the camera of the moment, when the territory was
// reached without one), its words must read at TEXT_SCALE of the type scale's
// own sizes — its content box laid out at those sizes, the slab drawn that
// much smaller —, as close to the plateau as the gap says. From then on its
// size is ground, like any other piece of the map: zoomed in, it grows with it.
//
// Words painted on a road are drawn long, so that a driver sees them right. A
// slab is drawn long the same way (north–south): seen at the fit's pitch its
// words come out at their normal proportions instead of squashed by the tilt
// ("Redressé"). Its width is set at its far edge, where it is drawn smallest:
// no letter is ever drawn under its size there (TEXT_SCALE of its token's), at
// most some 10 % over it at the near edge. ("À plat", a DEV option: the slab
// as wide as tall in metres as its box is, the words squashed by the tilt as
// any ground is.)

/** The pitch the camera frames a raised territory at (GeoDrillMap's ELEV_PITCH). */
export const FIT_PITCH_DEG = 45;

/** How much of the rectangle a territory's fit gives its silhouette, on the
 *  axis that limits it — the rest is map around it, the silhouette still
 *  centred (fitSilhouette's `fill`). GeoNav's, in production; its DEV switch
 *  ("Cadrage", analyses/devSwitch) compares others. */
export const FRAME_FILL = 0.8;

/** The analyses' words right after a fit: this much of the type scale's sizes
 *  on screen (solveSlabScales' `textScale`). Their content boxes are laid out
 *  at the type scale's sizes (the CSS keeps its tokens); the slabs are drawn
 *  that much smaller on the map, padding and gaps with them. In production;
 *  the DEV switch ("Taille", analyses/devSwitch) compares others. */
export const TEXT_SCALE = 0.8;

const DEG = Math.PI / 180;
const R_EARTH = 6378137;
const C_EARTH = 2 * Math.PI * R_EARTH;
/** mapbox's globe is drawn at mercator's scale at this latitude at low zoom
 *  (GLOBE_SCALE_MATCH_LATITUDE), turning to the centre's own through z 3–5 —
 *  its Globe.range, moved down by log2(the map's larger side / 1024) on a map
 *  under 1024 px (getProjectionInterpolationT, pixelSpaceConversion): at the
 *  centre's from z 5 on, before the morph into mercator (z 5–6) begins. */
const GLOBE_MATCH_LAT = 45;
const GLOBE_RANGE: [number, number] = [3, 5];
/** Latitude kept within: mercator stops at ±85. */
const MAX_LAT = 84;

export const mercX = (lng: number) => (lng + 180) / 360;
export const mercY = (lat: number) => {
  const s = Math.sin(lat * DEG);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
export const lngOf = (x: number) => x * 360 - 180;
export const latOf = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / DEG;
export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
const clampLat = (lat: number) => Math.min(MAX_LAT, Math.max(-MAX_LAT, lat));

// ---- The camera -----------------------------------------------------------------

/**
 * A camera, as mapbox has one: the target `lng`, `lat` stands at the padded
 * centre moved by `ox`, `oy` px (a command's aim offset; 0 for the camera of
 * the moment, whose centre is the padded centre's ground). `w`, `h`: the
 * map's size, px (the camera stands 1.5 × its height from the centre:
 * mapbox's 36.87° field of view; its larger side moves the globe's scale
 * along, see GLOBE_MATCH_LAT). `globe`: the style draws a globe below zoom 6.
 * `restM`: the terrain's height under its centre, m (0 when absent) — over
 * terrain mapbox aims the camera at the ground's surface there, rising with
 * it while its centre on the ground stays put: drawn from that camera, every
 * point stands as if `restM` lower.
 */
export interface SlabCam {
  lng: number;
  lat: number;
  ox: number;
  oy: number;
  zoom: number;
  pitch: number;
  w: number;
  h: number;
  globe: boolean;
  restM?: number;
}

/** mapbox's transform runs the globe below this zoom, mercator from it up
 *  (GLOBE_ZOOM_THRESHOLD_MAX) — the morph into mercator ends there too. */
const GLOBE_MAX_ZOOM = 6;

export interface SlabProjector {
  /** Screen px relative to the padded centre, into out[0], out[1]; false
   *  behind the camera or past the horizon. */
  project(lng: number, lat: number, altM: number, out: Float64Array): boolean;
  /** The ground under the padded centre (mapbox's getCenter). */
  lng0: number;
  lat0: number;
  /** The globe → mercator morph (1: flat). */
  t: number;
  /** Screen px per metre at the centre. */
  pxPerM: number;
}

/**
 * The camera's projection, the twin of what GeoDrillMap's plateau layer draws
 * with: on flat ground (z ≥ 6, or a style with no globe) mercator, exactly;
 * on the globe a sphere of the earth's radius at mapbox's globe scale (see
 * GLOBE_MATCH_LAT) — the curvature counted, which tilts a slab off the
 * tangent plane by its distance from the centre (France's top slab some 4.5°,
 * its words some 13 % shorter than a flat model has them) —; through z 5–6
 * the two mixed on screen by smoothstep(5, 6, zoom), as the layer mixes them.
 * The pitch is held within 0–60° (past that a slab drawn long would stretch
 * without end). Checked against mapbox 3.25's own transform and the plateau
 * layer's projection (the frame bus's): within 0.01 px on the globe, through
 * its morph and on the flat map, aim offset and restM included.
 */
export function slabProjector(cam: SlabCam): SlabProjector {
  const phi = Math.min(60, Math.max(0, cam.pitch)) * DEG;
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const D = 1.5 * Math.max(1, cam.h);
  const Wpx = 512 * Math.pow(2, cam.zoom);
  const t = cam.globe ? smoothstep(5, 6, cam.zoom) : 1;
  // The globe's scale: 45°'s turning to the centre's over its own range, not
  // the morph's (flat ground: the centre's).
  const adj = Math.log2(Math.min(1024, Math.max(1, cam.w, cam.h)) / 1024);
  const tS = cam.globe ? smoothstep(GLOBE_RANGE[0] + adj, GLOBE_RANGE[1] + adj, cam.zoom) : 1;
  let lng0 = cam.lng;
  let lat0 = cam.lat;
  let S = 0; // px per metre at the centre
  let Wm = 0; // mercator px per mercator unit (the mercator twin's)
  let mx0 = 0;
  let my0 = 0;
  let sinL0 = 0;
  let cosL0 = 1;
  const setCentre = (lng: number, lat: number) => {
    lng0 = lng;
    lat0 = clampLat(lat);
    cosL0 = Math.cos(lat0 * DEG);
    sinL0 = Math.sin(lat0 * DEG);
    const inv45 = 1 / Math.cos(GLOBE_MATCH_LAT * DEG);
    S = (Wpx / C_EARTH) * (inv45 + (1 / cosL0 - inv45) * tS);
    Wm = S * C_EARTH * cosL0;
    mx0 = mercX(lng0);
    my0 = mercY(lat0);
  };
  // Ground px (a east, f north, tz up) → screen, relative to the padded centre.
  const flat = (a: number, f: number, tz: number, out: Float64Array, o: number): boolean => {
    const den = D + f * s - tz * c;
    if (!(den > 0.05 * D)) return false;
    out[o] = (D * a) / den;
    out[o + 1] = (-D * (f * c + tz * s)) / den;
    return true;
  };
  const tmp = new Float64Array(4);
  // The terrain under the centre (see SlabCam.restM), m: the camera raised
  // by as much along the centre's up, at its scale. Left out while the centre
  // is placed — mapbox places it on the ground the camera then flies over,
  // and the plateau it lands on rises after.
  let rest = 0;
  const project = (lng: number, lat: number, altM: number, out: Float64Array): boolean => {
    let ok = true;
    if (t < 1) {
      // The sphere, in the east-north-up frame of the centre.
      const la = lat * DEG;
      const dl = (lng - lng0) * DEG;
      const r = R_EARTH + altM;
      const cl = Math.cos(la);
      const sl = Math.sin(la);
      const e = r * cl * Math.sin(dl);
      const n = r * (sl * cosL0 - cl * sinL0 * Math.cos(dl));
      const u = r * (sl * sinL0 + cl * cosL0 * Math.cos(dl)) - R_EARTH - rest;
      ok = flat(e * S, n * S, u * S, tmp, 0) && ok;
    }
    if (t > 0) {
      const a = (mercX(lng) - mx0) * Wm;
      const f = (my0 - mercY(lat)) * Wm;
      const tz = (altM * Wm) / (C_EARTH * Math.cos(lat * DEG)) - rest * S;
      ok = flat(a, f, tz, tmp, 2) && ok;
    }
    if (!ok) return false;
    if (t <= 0) {
      out[0] = tmp[0];
      out[1] = tmp[1];
    } else if (t >= 1) {
      out[0] = tmp[2];
      out[1] = tmp[3];
    } else {
      out[0] = tmp[0] + (tmp[2] - tmp[0]) * t;
      out[1] = tmp[1] + (tmp[3] - tmp[1]) * t;
    }
    return true;
  };
  // Flat ground under a screen point (tz 0), relative to the centre.
  const fInv = (y: number) => (-y * D) / (D * c + y * s);
  const aInv = (x: number, y: number) => (x * (D + fInv(y) * s)) / D;
  // The centre's ground: the target moved back by its offset. On the globe,
  // as mapbox's transform does it there (setLocationAtPoint): by the offset's
  // px in mercator at the zoom's scale, as if looking straight down — under a
  // pitch the target then lands off the offset's point, and the camera with
  // it. On the flat map, exactly: first as on flat ground, then put right a
  // few times against the projection itself.
  setCentre(cam.lng, cam.lat);
  if ((cam.ox || cam.oy) && cam.globe && cam.zoom < GLOBE_MAX_ZOOM) {
    setCentre(lngOf(mercX(cam.lng) - cam.ox / Wpx), latOf(mercY(cam.lat) - cam.oy / Wpx));
  } else if (cam.ox || cam.oy) {
    const p = new Float64Array(2);
    let px = 0;
    let py = 0;
    for (let i = 0; i < 4; i++) {
      const da = aInv(cam.ox, cam.oy) - aInv(px, py);
      const df = fInv(cam.oy) - fInv(py);
      const lat = lat0 - df / S / R_EARTH / DEG;
      const lng = lng0 - da / S / (R_EARTH * Math.cos(lat0 * DEG)) / DEG;
      setCentre(lng, lat);
      if (!project(cam.lng, cam.lat, 0, p)) break;
      px = p[0];
      py = p[1];
      if (Math.abs(px - cam.ox) < 1e-3 && Math.abs(py - cam.oy) < 1e-3) break;
    }
  }
  rest = cam.restM ?? 0;
  return {
    project,
    get lng0() {
      return lng0;
    },
    get lat0() {
      return lat0;
    },
    t,
    get pxPerM() {
      return S;
    },
  };
}

// ---- Framing a territory ----------------------------------------------------------

/** What a camera command frames (GeoDrillMap's fit): the territory's
 *  silhouette — its whole outline, islets included, at the ground and at its
 *  lid's height —, or with no outline its box's edges on the ground. */
export interface FitShape {
  /** Points around the outline (each outer ring's hull), [lng, lat] pair
   *  after pair. */
  pts: ArrayLike<number>;
  /** The lid's height, m (0: nothing raised). */
  liftM: number;
  /** The plateau's own height, m: the terrain the camera comes to rest on
   *  (SlabCam.restM) wherever its centre's ground is the territory's
   *  (`holds`) — the plateau rises under it once the flight is over. */
  restM: number;
  /** Whether a ground point is the territory's. Null: no outline (a box). */
  holds: ((lng: number, lat: number) => boolean) | null;
  /** Whether the view's centre may land on a ground point: the scope read
   *  from there must be the territory (GeoNav). Null: anywhere. */
  lands: ((lng: number, lat: number) => boolean) | null;
}

export interface FitOpts {
  shape: FitShape;
  /** Where to start from: mapbox's own fit of the territory's box. */
  seed: { lng: number; lat: number; zoom: number };
  /** The rectangle to fill, px from the padded centre: the target is aimed at
   *  its centre (the camera's offset). */
  rect: { left: number; top: number; right: number; bottom: number };
  /** How much of it the silhouette fills, on the axis that limits it (0–1;
   *  1 when absent: edge to edge). See FRAME_FILL. */
  fill?: number;
  pitch: number;
  w: number;
  h: number;
  globe: boolean;
  maxZoom: number;
}

/** At most this many passes per fit (three to eight do it). */
const FIT_PASSES = 16;
/** Settled once the box's centre is this close to the rectangle's, px, and
 *  the zoom this close to the size that fits, levels (0.05 %). */
const FIT_CENTRE_PX = 0.05;
const FIT_ZOOM_EPS = 0.0007;
/** The view's centre may land on a point with room to spare when it may land
 *  on the points this far from it too (of the territory's box's span, on
 *  each side). */
const DEEP_RING = 0.02;

/**
 * The camera that frames a territory in a rectangle at a pitch: its
 * silhouette's box (lid ∪ ground, at the camera it lands on, resting on its
 * plateau: the whole outline's, islets included) centred in the
 * rectangle and `fill` of it on the axis that limits it (1: as large as fits,
 * touching the rectangle's edges), the zoom capped at `maxZoom` (only centred
 * there).
 * mapbox's cameraForBounds cannot: it frames a box's corners as if the camera
 * looked straight at it, and under a pitch the near half of a territory is
 * drawn larger than the far half, its lid higher than its ground — the fit
 * came out low on the screen and small. Here the silhouette is measured at a
 * camera, the camera moved by what is off — the target onto the ground under
 * the box's centre, the zoom by the ratio of the sizes — and measured again,
 * until nothing is.
 *
 * The view's centre — the target — must land where the scope read from there
 * is the territory (`lands`). A concave territory can have the middle of its
 * silhouette in a neighbour (Meurthe-et-Moselle's, by Metz): framed there,
 * the scope went to the neighbour, which rose instead. Then it is framed
 * around the point nearest that middle where it may land with room to spare,
 * as large as fits around that point (times `fill`). Null: nothing to frame in
 * front of the camera.
 */
export function fitSilhouette(o: FitOpts): SlabCam | null {
  const centred = fitPasses(o, null);
  const lands = o.shape.lands;
  if (!centred || !lands || lands(centred.lng, centred.lat)) return centred;
  const at = deepPointNear(o.shape.pts, lands, centred.lng, centred.lat);
  if (!at) return centred; // a sliver: centred as it is
  return fitPasses({ ...o, seed: { ...at, zoom: centred.zoom } }, at);
}

/** How a fit's passes take the plateau the camera comes to rest on: as its
 *  centre finds it ("follow"), as if `restM` m high wherever it is (a
 *  number), or both ways at once ("either"). */
type RestMode = "follow" | "either" | number;
/** What passes that follow the rest say when their centre keeps crossing the
 *  plateau's edge. */
const ON_EDGE = "on edge";

/** fitSilhouette's passes: centred, or around `aim` (the target held there). */
function fitPasses(o: FitOpts, aim: { lng: number; lat: number } | null): SlabCam | null {
  const followed = settle(o, aim, "follow");
  if (followed !== ON_EDGE) return followed;
  // Its centre on the plateau's edge, the rest changes its mind as the camera
  // moves — the picture a few px with it: solved resting on the plateau, then
  // off it, the camera that comes to rest as it was solved for is kept; with
  // neither, the box as it comes out resting either way, so that it fits
  // whichever it does.
  for (const restM of [o.shape.restM, 0]) {
    const cam = settle(o, aim, restM);
    if (cam !== ON_EDGE && cam?.restM === restM) return cam;
  }
  const either = settle(o, aim, "either");
  return either === ON_EDGE ? null : either;
}

/** fitPasses' passes, the rest taken as `mode` says; the camera carries the
 *  rest it comes to. */
function settle(
  o: FitOpts,
  aim: { lng: number; lat: number } | null,
  mode: RestMode,
): SlabCam | null | typeof ON_EDGE {
  const { pts, liftM } = o.shape;
  const n = Math.floor(pts.length / 2);
  const { left, top, right, bottom } = o.rect;
  if (!n || !(right > left) || !(bottom > top)) return null;
  const fill = o.fill !== undefined && o.fill > 0 ? Math.min(1, o.fill) : 1;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  let lng = o.seed.lng;
  let lat = o.seed.lat;
  let zoom = Math.min(o.seed.zoom, o.maxZoom);
  const camAt = (restM: number): SlabCam => ({
    lng,
    lat,
    ox: cx,
    oy: cy,
    zoom,
    pitch: o.pitch,
    w: o.w,
    h: o.h,
    globe: o.globe,
    restM,
  });
  // Where the camera comes to rest: on the plateau when its centre is over it
  // (where the centre is does not depend on it).
  const restAt = (P: SlabProjector) => (o.shape.holds?.(P.lng0, P.lat0) ? o.shape.restM : 0);
  const p = new Float64Array(2);
  const q = new Float64Array(2);
  let last: SlabCam | null = null;
  let restM = typeof mode === "number" ? mode : 0; // the rest the camera is moved for
  let flips = 0;
  for (let pass = 1; pass <= FIT_PASSES; pass++) {
    let P = slabProjector(camAt(restM));
    const rest = restAt(P);
    if (typeof mode !== "number" && rest !== restM) {
      if (mode === "follow" && pass > 1 && ++flips >= 2) return ON_EDGE;
      restM = rest;
      P = slabProjector(camAt(restM));
    }
    const views = mode === "either" ? [P, slabProjector(camAt(restM ? 0 : o.shape.restM))] : [P];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const V of views) {
      for (let i = 0; i < n; i++) {
        for (let k = liftM > 0 ? 0 : 1; k < 2; k++) {
          if (!V.project(pts[2 * i], pts[2 * i + 1], k === 0 ? liftM : 0, p)) continue;
          if (p[0] < minX) minX = p[0];
          if (p[0] > maxX) maxX = p[0];
          if (p[1] < minY) minY = p[1];
          if (p[1] > maxY) maxY = p[1];
        }
      }
    }
    if (!(maxX > minX) || !(maxY > minY)) return last;
    last = camAt(rest);
    // The size that fits: the box's on the axis that limits it — around the
    // aimed point, its farthest side from it on each axis —, `fill` of it.
    let s = Infinity;
    if (aim) {
      if (minX < cx) s = Math.min(s, (cx - left) / (cx - minX));
      if (maxX > cx) s = Math.min(s, (right - cx) / (maxX - cx));
      if (minY < cy) s = Math.min(s, (cy - top) / (cy - minY));
      if (maxY > cy) s = Math.min(s, (bottom - cy) / (maxY - cy));
    } else {
      s = Math.min((right - left) / (maxX - minX), (bottom - top) / (maxY - minY));
    }
    s *= fill;
    if (!(s > 0) || !Number.isFinite(s)) return last;
    const next = Math.min(o.maxZoom, zoom + Math.log2(s));
    const ex = aim ? 0 : (minX + maxX) / 2 - cx;
    const ey = aim ? 0 : (minY + maxY) / 2 - cy;
    if (
      Math.abs(ex) < FIT_CENTRE_PX &&
      Math.abs(ey) < FIT_CENTRE_PX &&
      Math.abs(next - zoom) < FIT_ZOOM_EPS
    ) {
      return last;
    }
    if (ex || ey) {
      // The target onto the ground under the box's centre: how far the map
      // moves on screen per degree there (a step of about a px), inverted.
      const d = 360 / (512 * Math.pow(2, zoom));
      if (!P.project(lng, lat, restM, p)) return last;
      if (!P.project(lng + d, lat, restM, q)) return last;
      const a = (q[0] - p[0]) / d;
      const c = (q[1] - p[1]) / d;
      if (!P.project(lng, lat + d, restM, q)) return last;
      const b = (q[0] - p[0]) / d;
      const e = (q[1] - p[1]) / d;
      const det = a * e - b * c;
      if (!(Math.abs(det) > 0)) return last;
      lng += (e * ex - b * ey) / det;
      lat = clampLat(lat + (a * ey - c * ex) / det);
    }
    zoom = next;
  }
  return last;
}

/** The point nearest (`lng`, `lat`) where the view's centre may land
 *  (`lands`) with room to spare (DEEP_RING): the nearest such point of a
 *  16 × 16 grid over the territory's box (`pts`'), then the nearest along the
 *  way back from there. Null: none. */
function deepPointNear(
  pts: ArrayLike<number>,
  lands: (lng: number, lat: number) => boolean,
  lng: number,
  lat: number,
): { lng: number; lat: number } | null {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    minLng = Math.min(minLng, pts[i]);
    maxLng = Math.max(maxLng, pts[i]);
    minLat = Math.min(minLat, pts[i + 1]);
    maxLat = Math.max(maxLat, pts[i + 1]);
  }
  const lngSpan = maxLng - minLng;
  const latSpan = maxLat - minLat;
  if (!(lngSpan > 0) || !(latSpan > 0)) return null;
  const dx = DEEP_RING * lngSpan;
  const dy = DEEP_RING * latSpan;
  const deep = (x: number, y: number) =>
    lands(x, y) && lands(x, y + dy) && lands(x, y - dy) && lands(x + dx, y) && lands(x - dx, y);
  const N = 16;
  const grid: { lng: number; lat: number; d: number }[] = [];
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const y = minLat + (latSpan * i) / N;
      const x = minLng + (lngSpan * j) / N;
      grid.push({ lng: x, lat: y, d: ((y - lat) / latSpan) ** 2 + ((x - lng) / lngSpan) ** 2 });
    }
  }
  grid.sort((p, q) => p.d - q.d);
  const at = grid.find((p) => deep(p.lng, p.lat));
  if (!at) return null;
  // Back toward (lng, lat) as far as it stays so: the grid's step is a
  // sixteenth of the box, which would leave the territory that much off-centre.
  let lo = 0; // (lng, lat): not
  let hi = 1; // `at`: so
  for (let i = 0; i < 16; i++) {
    const t = (lo + hi) / 2;
    if (deep(lng + (at.lng - lng) * t, lat + (at.lat - lat) * t)) hi = t;
    else lo = t;
  }
  return { lng: lng + (at.lng - lng) * hi, lat: lat + (at.lat - lat) * hi };
}

// ---- Sizing -----------------------------------------------------------------------

/** A slab's content box, CSS px. */
export interface SlabBoxPx {
  w: number;
  h: number;
}

/**
 * The space a slab is laid out in: across (X, from the territory's middle
 * meridian) and along (Y, growing southward).
 * - "mercator": mercator units, as the flat map is drawn (z ≥ 6): a slab is a
 *   lat/lng rectangle there, a rectangle on the map.
 * - "ground": metres, east and south, as the globe is drawn (France's slabs,
 *   sized below z 5.5): a lat/lng rectangle several degrees tall would come
 *   out a trapezoid there — the meridians closing in northward, 10–15 % over
 *   France's top slab —, so its width is kept in metres instead, the same at
 *   every latitude: a rectangle on the ground.
 */
export type SlabSpace = "mercator" | "ground";

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

const yOf = (space: SlabSpace, lat: number) =>
  space === "mercator" ? mercY(lat) : -lat * DEG * R_EARTH;
const latOfY = (space: SlabSpace, y: number) =>
  space === "mercator" ? latOf(y) : -y / R_EARTH / DEG;
/** [lng, lat] of a point X across from meridian `mid` at Y along. */
function lngLatOf(space: SlabSpace, mid: number, x: number, y: number): [number, number] {
  const lat = clampLat(latOfY(space, y));
  if (space === "mercator") return [lngOf(mercX(mid) + x), lat];
  return [mid + x / (R_EARTH * Math.cos(lat * DEG)) / DEG, lat];
}

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

// ---- The slabs on the map -----------------------------------------------------------

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
 * down — the ring's own SVG geometry, analyses/content/analysisPlates), radii `rIn` to
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

// ---- Words on a lid: the content box mapped onto its quad on screen -----------------

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
