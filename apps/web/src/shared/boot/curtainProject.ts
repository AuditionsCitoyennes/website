// The loading curtain's France as the map shows it ("carte", curtainFrame.ts):
// the poster's outline projected as the map's camera draws the globe, flat or
// pitched 45°, its bounding box on the map's France. Apart from
// curtainFrame.ts so that it comes with the poster's file
// (shared/ui/CurtainPoster.vue), not in every page's code.
//
// The camera is mapbox's on its globe (measured against map.project at seven
// screen sizes, 2026-11-23: within a fraction of a px once aimed): a sphere
// `R` px in radius, the camera CAMERA_HEIGHTS box heights from the ground it
// looks at, pitched about that ground, its image centred on the framed part's
// centre. `R` is solved for the aimed width and the ground's latitude for the
// aimed height on screen; the drawing is then moved onto the aim.
//
// Pure, no DOM: loadable under node (curtainFrame.test.ts).
import { POSTER_W, type FranceAim, type Rect } from "./curtainFrame";

/** A ring of the poster's outline in its own units (Web Mercator, y down). */
export type Ring = readonly (readonly [number, number])[];

/** The poster's frame (scripts/map-data/poster/lib.ts buildPoster): Web
 *  Mercator, POSTER_W units wide less PAD on each side from Ouessant's
 *  longitude to Cap Corse's, Bray-Dunes' latitude on the top margin. */
const LON_W = -5.141;
const LON_E = 9.56;
const LAT_N = 51.089;
const PAD = 8;
const RAD = Math.PI / 180;
const UNITS_PER_RAD = (POSTER_W - 2 * PAD) / ((LON_E - LON_W) * RAD);
const Y_N = Math.log(Math.tan(Math.PI / 4 + (LAT_N * RAD) / 2));

/** Measured: the camera's centre is on this meridian in the boot fits. */
const CENTRE_LON = 2.2;
/** Mapbox's camera stands this many box heights from the ground it looks at
 *  (its 36.87° field of view), and that distance is its focal length. */
const CAMERA_HEIGHTS = 1.5;
/** The map's pitch once tilted (features/map useMapCamera's ELEV_PITCH). */
const TILTED_DEG = 45;

/** Each point's latitude and longitude, read as the sphere needs them (the
 *  centre's meridian fixed): sin(lat), cos(lat)·sin(Δlon), cos(lat)·cos(Δlon). */
interface Points {
  /** Every ring's points, flat: 3 numbers each. */
  all: Float64Array;
  /** The ring lengths, to cut `all` back into rings. */
  lengths: number[];
  /** The convex hull's points (in the poster's units), as `all`: the solve
   *  reads only them (the projected outline's extremes are the hull's). */
  hull: Float64Array;
}

const cache = new WeakMap<readonly Ring[], Points>();

function sphereOf(pts: readonly (readonly [number, number])[]): Float64Array {
  const out = new Float64Array(pts.length * 3);
  const l0 = CENTRE_LON * RAD;
  pts.forEach(([u, v], i) => {
    const lon = LON_W * RAD + (u - PAD) / UNITS_PER_RAD;
    const lat = 2 * Math.atan(Math.exp(Y_N - (v - PAD) / UNITS_PER_RAD)) - Math.PI / 2;
    const cl = Math.cos(lat);
    out[3 * i] = Math.sin(lat);
    out[3 * i + 1] = cl * Math.sin(lon - l0);
    out[3 * i + 2] = cl * Math.cos(lon - l0);
  });
  return out;
}

function pointsOf(rings: readonly Ring[]): Points {
  let p = cache.get(rings);
  if (!p) {
    p = {
      all: sphereOf(rings.flat()),
      lengths: rings.map((r) => r.length),
      hull: sphereOf(hullOfPoints(rings)),
    };
    cache.set(rings, p);
  }
  return p;
}

/** The convex hull of the rings' points (monotone chain). */
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

/** The camera: the ground it looks at (its latitude), the globe's radius
 *  (px), its distance (px), its pitch, and where its image is centred. */
interface Camera {
  sin0: number;
  cos0: number;
  R: number;
  D: number;
  sinT: number;
  cosT: number;
  cx: number;
  cy: number;
}

/** Projects `pts` (sphereOf's) into `out` ([x, y] pairs) and returns their
 *  bounding box. */
function project(pts: Float64Array, c: Camera, out: Float64Array | null) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  const camY = c.D * c.sinT;
  const camZ = c.D * c.cosT;
  for (let i = 0, n = pts.length / 3; i < n; i++) {
    const sl = pts[3 * i];
    const e = pts[3 * i + 1];
    const b = pts[3 * i + 2];
    // On the sphere, from the ground looked at: east, north, up (px).
    const X = c.R * e;
    const Y = c.R * (c.cos0 * sl - c.sin0 * b);
    const Z = c.R * (c.sin0 * sl + c.cos0 * b - 1);
    // From the camera, which stands south of that ground, pitched to it.
    const ry = Y + camY;
    const rz = Z - camZ;
    const depth = Math.max(1e-6, ry * c.sinT - rz * c.cosT);
    const up = ry * c.cosT + rz * c.sinT;
    const x = c.cx + (c.D * X) / depth;
    const y = c.cy - (c.D * up) / depth;
    if (out) {
      out[2 * i] = x;
      out[2 * i + 1] = y;
    }
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, x1, y0, y1 };
}

/** The poster's outline as the map's camera draws it, `flat` or tilted 45°,
 *  its bounding box as wide as the map's France and on its centre. */
export function projectRings(
  rings: readonly Ring[],
  o: { view: Rect; boxH: number; aim: FranceAim; flat: boolean },
): [number, number][][] {
  if (!rings.length || !(o.aim.width > 0) || !(o.boxH > 0)) return [];
  const pts = pointsOf(rings);
  const pitch = o.flat ? 0 : TILTED_DEG * RAD;
  const cam: Camera = {
    sin0: 0,
    cos0: 1,
    R: 0,
    D: CAMERA_HEIGHTS * o.boxH,
    sinT: Math.sin(pitch),
    cosT: Math.cos(pitch),
    cx: o.view.left + o.view.width / 2,
    cy: o.view.top + o.view.height / 2,
  };
  const at = (lat: number) => {
    cam.sin0 = Math.sin(lat * RAD);
    cam.cos0 = Math.cos(lat * RAD);
  };
  /** The radius giving the aimed width, the ground's latitude set. France is
   *  about a sixth of the globe's radius wide: bracketed widely. */
  const solveR = () => {
    let lo = o.aim.width;
    let hi = 40 * o.aim.width;
    for (let n = 0; n < 36; n++) {
      cam.R = (lo + hi) / 2;
      const b = project(pts.hull, cam, null);
      if (b.x1 - b.x0 > o.aim.width) hi = cam.R;
      else lo = cam.R;
    }
    cam.R = (lo + hi) / 2;
  };
  // The ground looked at further north draws France lower on the screen.
  let lo = 30;
  let hi = 62;
  for (let n = 0; n < 30; n++) {
    const lat = (lo + hi) / 2;
    at(lat);
    solveR();
    const b = project(pts.hull, cam, null);
    if ((b.y0 + b.y1) / 2 > o.aim.y) hi = lat;
    else lo = lat;
  }
  at((lo + hi) / 2);
  solveR();
  const flatOut = new Float64Array((pts.all.length / 3) * 2);
  const b = project(pts.all, cam, flatOut);
  if (!Number.isFinite(b.x0)) return [];
  const dx = o.aim.x - (b.x0 + b.x1) / 2;
  const dy = o.aim.y - (b.y0 + b.y1) / 2;
  const out: [number, number][][] = [];
  let at0 = 0;
  for (const len of pts.lengths) {
    const ring: [number, number][] = [];
    for (let i = at0; i < at0 + len; i++) ring.push([flatOut[2 * i] + dx, flatOut[2 * i + 1] + dy]);
    out.push(ring);
    at0 += len;
  }
  return out;
}
