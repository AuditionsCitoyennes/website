// What the analyses' slabs hide on screen: tests of a screen point against the
// pieces' faces and the ring's planes, and of the ground a lieu dot stands on
// against the boxes they are seen in — read off the pieces as the layer drew
// them in the last frame, with the frame bus's own projection.

import mapboxgl from "mapbox-gl";
import type { Bounds } from "@/features/geo";
import { homography, latOf, lngOf, unapplyHomography } from "../lib";
import type { PlateauWallLayer, SlabQuad } from "../gl/PlateauWallLayer";
import { WALL_OVERSHOOT } from "../gl/mesh";
import { STRIDE } from "../lib/projection";
import type { usePlateauFrames } from "./usePlateauFrames";

export interface SlabOcclusionInputs {
  getMap: () => mapboxgl.Map | null;
  wall: PlateauWallLayer;
  /** The frame bus: the frame size and whether the camera is the layer's. */
  frames: Pick<
    ReturnType<typeof usePlateauFrames>,
    "readFrameSize" | "frameW" | "frameH" | "camFresh"
  >;
}

export function useSlabOcclusion({ getMap, wall: plateauWall, frames }: SlabOcclusionInputs) {
  const { readFrameSize, frameW, frameH, camFresh } = frames;

  // ---- What the slabs hide on screen ------------------------------------------
  // A raised piece hides what is behind it: the map's pins, HTML over the canvas,
  // are hidden there (hidePinsUnderSlabs) and nothing is picked there (unitAt) —
  // under a glass lid too, which shows the map only blurred. Read off the pieces
  // as the layer drew them in the last frame, with the frame bus's own
  // projection (projectInto: exactly). A box (the label's, the plaque, the bar):
  // its lid, its foot and the walls between — the near one shows under the
  // lid's edge, the taller the closer. The ring: its box's plane at RING_LEVELS
  // heights from the ground to the lid, a point on it wherever one of them has
  // it between the ring's hole and its picked part's outer edge (its walls stand
  // between those planes, a pixel or so apart; the gaps between its parts, a
  // pixel, count as ring).
  /** Per box: its lid's corners (NW, NE, SE, SW), then its foot's; px. */
  const slabShapes = [new Float32Array(16), new Float32Array(16), new Float32Array(16)];
  const slabShapeLids = slabShapes.map((s) => s.subarray(0, 8));
  const slabShapeFeet = slabShapes.map((s) => s.subarray(8, 16));
  const slabShapeOk = new Uint8Array(4);
  /** A box's faces, by corner (0–3 its lid's, 4–7 its foot's): lid, foot, walls. */
  const SLAB_FACES = [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ] as const;
  const RING_LEVELS = 5;
  /** The ring's box's plane at each level, ground to lid: its projective map
   *  (see homography), and those levels' corners' box on screen, px. */
  const ringPlanes = Array.from({ length: RING_LEVELS }, () => new Float64Array(8));
  const ringQuad = new Float32Array(8);
  const ringScreen = { x0: 0, y0: 0, x1: 0, y1: 0 };
  const ringPt = [0, 0];
  /** What slabsOnScreen found: how many boxes, whether the ring. */
  let shapesOn = 0;
  let ringOn = false;

  /** The pieces on screen (into slabShapes, ringPlanes): how many (0: none). As
   *  they stand, from the moment they are built to the moment they go — their
   *  rise and sink are a few hundred milliseconds, and nothing would come back
   *  to look once over. */
  function slabsOnScreen(): number {
    const layer = plateauWall;
    shapesOn = 0;
    ringOn = false;
    if (!layer.slabQuads.length || !(layer.cam.seq > 0) || !camFresh()) return 0;
    readFrameSize();
    const lift = layer.slabHeightM * WALL_OVERSHOOT;
    const ok = slabShapeOk;
    const all = () => (ok[0] & ok[1] & ok[2] & ok[3]) === 1;
    for (const q of layer.slabQuads) {
      if (q.name === "ring") {
        ringOn = ringOnScreen(q, lift);
        continue;
      }
      if (shapesOn >= slabShapes.length) continue;
      layer.projectInto(
        layer.slabCorners,
        4,
        lift,
        frameW(),
        frameH(),
        slabShapeLids[shapesOn],
        ok,
        q.at,
      );
      if (!all()) continue;
      layer.projectInto(
        layer.slabCorners,
        4,
        0,
        frameW(),
        frameH(),
        slabShapeFeet[shapesOn],
        ok,
        q.at,
      );
      if (!all()) continue;
      shapesOn++;
    }
    return shapesOn + (ringOn ? 1 : 0);
  }

  /** The ring's box `q` at each level (see ringPlanes): false if any is off. */
  function ringOnScreen(q: SlabQuad, lift: number): boolean {
    const layer = plateauWall;
    if (!layer.slabRingCover) return false;
    const ok = slabShapeOk;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < RING_LEVELS; k++) {
      const alt = (lift * k) / (RING_LEVELS - 1);
      layer.projectInto(layer.slabCorners, 4, alt, frameW(), frameH(), ringQuad, ok, q.at);
      if (!(ok[0] & ok[1] & ok[2] & ok[3])) return false;
      if (!homography(ringQuad, q.w, q.h, ringPlanes[k])) return false;
      for (let i = 0; i < 8; i += 2) {
        x0 = Math.min(x0, ringQuad[i]);
        x1 = Math.max(x1, ringQuad[i]);
        y0 = Math.min(y0, ringQuad[i + 1]);
        y1 = Math.max(y1, ringQuad[i + 1]);
      }
    }
    ringScreen.x0 = x0;
    ringScreen.y0 = y0;
    ringScreen.x1 = x1;
    ringScreen.y1 = y1;
    return true;
  }

  /** Whether screen point (x, y) is on a piece slabsOnScreen found: on a face
   *  of a box (each convex on screen, turning either way), or on the ring. */
  function onSlab(x: number, y: number): boolean {
    for (let i = 0; i < shapesOn; i++) {
      const p = slabShapes[i];
      for (const f of SLAB_FACES) {
        let sign = 0;
        let inside = true;
        for (let k = 0; k < 4 && inside; k++) {
          const a = 2 * f[k];
          const b = 2 * f[(k + 1) % 4];
          const cross = (p[b] - p[a]) * (y - p[a + 1]) - (p[b + 1] - p[a + 1]) * (x - p[a]);
          if (cross === 0) continue;
          const s = cross > 0 ? 1 : -1;
          if (sign && s !== sign) inside = false;
          sign = s;
        }
        if (inside) return true;
      }
    }
    const ring = plateauWall.slabRingCover;
    if (ringOn && ring) {
      for (const m of ringPlanes) {
        if (!unapplyHomography(m, x, y, ringPt)) continue;
        const d = Math.hypot(ringPt[0] - ring.c, ringPt[1] - ring.c);
        if (d >= ring.rIn && d <= ring.rOut) return true;
      }
    }
    return false;
  }

  /**
   * Per piece slabsOnScreen found: the lng/lat box of the ground a lieu dot can
   * stand on and still be drawn on it — what is seen within its box on screen,
   * out by a dot's radius (`dotRadiusPx`), from the flat ground up to the plateau's lid (a dot
   * stands on the one, or under the other). That takes in the slab's lift and
   * the tilt (its lid is seen over ground farther off), at any bearing, and a
   * dot on the plateau in front of the slab as well as behind it. Null
   * (anywhere) where groundSeenIn has no box.
   */
  function slabDotBoxes(dotRadiusPx: number): (Bounds | null)[] {
    const layer = plateauWall;
    const map = getMap();
    // The lid's height in mercator, where it is greatest: z per metre grows
    // toward the pole, so at the rim's poleward-most sample. A dot, though,
    // stands on mapbox's terrain, raised (as a marker is) by the z per metre at
    // the camera centre's latitude, not its own — beyond the rim's once the map
    // is panned poleward of the plateau: the greater of the two.
    let zPerM = map ? mapboxgl.MercatorCoordinate.fromLngLat(map.getCenter(), 1).z : 0;
    for (let i = 0; i < layer.rimCount; i++) zPerM = Math.max(zPerM, layer.rim[i * STRIDE + 2]);
    const top = layer.heightM * WALL_OVERSHOOT * zPerM;
    const r = dotRadiusPx;
    const boxes: (Bounds | null)[] = [];
    for (let i = 0; i < shapesOn; i++) {
      const p = slabShapes[i];
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let k = 0; k < p.length; k += 2) {
        x0 = Math.min(x0, p[k]);
        x1 = Math.max(x1, p[k]);
        y0 = Math.min(y0, p[k + 1]);
        y1 = Math.max(y1, p[k + 1]);
      }
      boxes.push(groundSeenIn(x0 - r, y0 - r, x1 + r, y1 + r, top));
    }
    if (ringOn) {
      const b = ringScreen;
      boxes.push(groundSeenIn(b.x0 - r, b.y0 - r, b.x1 + r, b.y1 + r, top));
    }
    return boxes;
  }

  /** Whether a dot at (lng, lat) may be drawn on a slab: within one of `boxes`
   *  (slabDotBoxes). */
  function mayBeUnderSlab(boxes: (Bounds | null)[], lng: number, lat: number): boolean {
    for (const b of boxes) {
      if (!b || (lng >= b.minLng && lng <= b.maxLng && lat >= b.minLat && lat <= b.maxLat)) {
        return true;
      }
    }
    return false;
  }

  /**
   * The lng/lat box of what is seen within the screen box [x0, x1] × [y0, y1],
   * from the flat ground (z = 0) up to mercator height `top`, with the camera of
   * the last frame drawn: projectInto's mercator matrix, solved on both planes
   * for each corner. A box on screen sees a convex quad of a plane, which its
   * corners bound, and a corner's point runs straight along its ray from one
   * plane to the other: the 8 bound every height between. Null on the globe (no
   * such plane: every dot is looked at there, and few show — the open lieu's,
   * the results'), or for a box reaching past the horizon.
   */
  function groundSeenIn(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    top: number,
  ): Bounds | null {
    const { m, globe } = plateauWall.cam;
    if (globe) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const sx of [x0, x1]) {
      for (const sy of [y0, y1]) {
        const nx = (2 * sx) / frameW() - 1;
        const ny = 1 - (2 * sy) / frameH();
        const a = m[0] - nx * m[3];
        const b = m[4] - nx * m[7];
        const d = m[1] - ny * m[3];
        const e = m[5] - ny * m[7];
        const det = a * e - b * d;
        for (const z of [0, top]) {
          // M·[x, y, z, 1] lands on (nx, ny): two linear equations in x, y.
          const wz = m[11] * z + m[15];
          const c = nx * wz - (m[8] * z + m[12]);
          const f = ny * wz - (m[9] * z + m[13]);
          const x = (c * e - b * f) / det;
          const y = (a * f - c * d) / det;
          // Behind the camera (w ≤ 0): the corner is above the horizon.
          if (!Number.isFinite(x) || !Number.isFinite(y) || !(m[3] * x + m[7] * y + wz > 0)) {
            return null;
          }
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    return { minLng: lngOf(minX), maxLng: lngOf(maxX), minLat: latOf(maxY), maxLat: latOf(minY) };
  }

  return { slabsOnScreen, onSlab, slabDotBoxes, mayBeUnderSlab };
}
