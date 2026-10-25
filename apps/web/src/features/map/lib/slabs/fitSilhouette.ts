// Framing a territory: the camera that fits its silhouette in a rectangle at a
// pitch, its target landing where the scope read from there is the territory.
import { clampLat } from "./constants";
import { slabProjector, type SlabCam, type SlabProjector } from "./slabCamera";

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
