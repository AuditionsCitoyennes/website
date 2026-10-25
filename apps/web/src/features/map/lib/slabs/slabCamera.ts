// The camera, as mapbox has one, and its projection: the twin of what
// GeoDrillMap's plateau layer draws with — mercator on flat ground, a sphere at
// mapbox's globe scale below zoom 6, the two mixed through the morph.
import {
  C_EARTH,
  clampLat,
  DEG,
  latOf,
  lngOf,
  mercX,
  mercY,
  R_EARTH,
  smoothstep,
} from "./constants";

/** mapbox's globe is drawn at mercator's scale at this latitude at low zoom
 *  (GLOBE_SCALE_MATCH_LATITUDE), turning to the centre's own through z 3–5 —
 *  its Globe.range, moved down by log2(the map's larger side / 1024) on a map
 *  under 1024 px (getProjectionInterpolationT, pixelSpaceConversion): at the
 *  centre's from z 5 on, before the morph into mercator (z 5–6) begins. */
const GLOBE_MATCH_LAT = 45;
const GLOBE_RANGE: [number, number] = [3, 5];

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
