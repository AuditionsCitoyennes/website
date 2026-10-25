// The per-geometry projection caches the plateau is built from — every
// boundary vertex projected ONCE (mercator and ECEF, both linear in altitude,
// see PBase) —, the rim packed for the frame bus (STRIDE: its only home), the
// lid and hover-fill meshes, and the hull a fit frames.

import mapboxgl from "mapbox-gl";
import earcut, { flatten } from "earcut";
import type { OutlineFC } from "../types";
import { polysOf } from "./polygon";

// ---- Per-geometry projection caches ----------------------------------------
// setGeometry used to re-project every boundary vertex (2× Mercator + 2× ECEF
// each) and re-run earcut + subdivision + the O(verts × edges) distance field
// on EVERY rebuild — profiled at ~28% of total scripting while panning, plus
// ~7% GC for the discarded intermediates. Both projections are LINEAR in
// altitude (merc z = alt·zPerM; ecef(alt) = ecef(0) + alt·d), so everything
// per-vertex — and every derived mesh — is cacheable per GEOMETRY OBJECT
// (boundary FCs and markRaw'd commune entries are identity-stable) with the
// height applied as a multiply-add at assembly time.
export interface PBase {
  lng: number;
  lat: number;
  x: number; // mercator at ground
  y: number;
  zPerM: number; // mercator z per metre of altitude
  lo: [number, number, number]; // ecef at ground
  d: [number, number, number]; // ecef delta per metre of altitude
}

export function baseOf(lng: number, lat: number): PBase {
  const m0 = mapboxgl.MercatorCoordinate.fromLngLat({ lng, lat }, 0);
  const m1 = mapboxgl.MercatorCoordinate.fromLngLat({ lng, lat }, 1);
  const ll = new mapboxgl.LngLat(lng, lat) as mapboxgl.LngLat & {
    toEcef(altM: number): [number, number, number];
  };
  const lo = ll.toEcef(0);
  const e1 = ll.toEcef(1);
  return {
    lng,
    lat,
    x: m0.x,
    y: m0.y,
    zPerM: m1.z,
    lo,
    d: [e1[0] - lo[0], e1[1] - lo[1], e1[2] - lo[2]],
  };
}

/** Ring vertices, projected once per geometry (walls, lines, halo, fill rings). */
const ringBaseCache = new WeakMap<object, PBase[][][]>();
export function ringBasesOf(g: { type?: string; coordinates?: unknown }): PBase[][][] {
  let c = ringBaseCache.get(g as object);
  if (!c) {
    c = polysOf(g).map((poly) => poly.map((ring) => ring.map(([lng, lat]) => baseOf(lng, lat))));
    ringBaseCache.set(g as object, c);
  }
  return c;
}

// ---- Points followed on screen every frame (the plateau's rim) ---------------
// Packed flat, STRIDE floats per point, so following them is a pass over one
// typed array: mercator x, y, z per metre, ECEF at ground, ECEF per metre —
// everything the two projections need — then lng, lat for diagnostics.
export const STRIDE = 11;
export function packBase(out: Float64Array, i: number, b: PBase) {
  const o = i * STRIDE;
  out[o] = b.x;
  out[o + 1] = b.y;
  out[o + 2] = b.zPerM;
  out[o + 3] = b.lo[0];
  out[o + 4] = b.lo[1];
  out[o + 5] = b.lo[2];
  out[o + 6] = b.d[0];
  out[o + 7] = b.d[1];
  out[o + 8] = b.d[2];
  out[o + 9] = b.lng;
  out[o + 10] = b.lat;
}

// The rim is sampled, not followed vertex by vertex: ~96 points place a box and
// a leader line as well as 1700 would. Rings much smaller than the outline
// (an islet off a coast) are left out — a leader line should never land on one
// — but every ring kept gets a few points, so Corsica is never a single dot.
const RIM_SAMPLES = 96;
const RIM_MIN_PER_RING = 4;
const RIM_MIN_RING_SHARE = 0.03; // of the whole outline's bbox diagonal

/**
 * The raised unit's rim, packed (see STRIDE): the OUTER ring of each of its
 * polygons, from the per-geometry cache, so this costs no projection. Samples
 * are spaced by arc length along each ring and always include the ring's
 * extreme vertices, where a silhouette's box is decided. Each sample is a real
 * boundary vertex: exactly where the wall stands.
 */
export function sampleRim(features: OutlineFC["features"]): { pack: Float64Array; count: number } {
  const rings: PBase[][] = [];
  for (const f of features) {
    const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
    if (!g?.type) continue;
    for (const poly of ringBasesOf(g)) {
      if (poly[0] && poly[0].length >= 4) rings.push(poly[0]);
    }
  }
  if (!rings.length) return { pack: new Float64Array(0), count: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const diags = rings.map((ring) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of ring) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    if (y0 < minY) minY = y0;
    if (y1 > maxY) maxY = y1;
    return Math.hypot(x1 - x0, y1 - y0);
  });
  const whole = Math.hypot(maxX - minX, maxY - minY);
  const biggest = diags.indexOf(Math.max(...diags));
  const kept = rings.filter((_, i) => i === biggest || diags[i] >= RIM_MIN_RING_SHARE * whole);
  // Arc length per ring, in mercator units (proportions are all that matter).
  const lens = kept.map((ring) => {
    let s = 0;
    for (let i = 1; i < ring.length; i++) {
      s += Math.hypot(ring[i].x - ring[i - 1].x, ring[i].y - ring[i - 1].y);
    }
    return s;
  });
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const picked: PBase[] = [];
  kept.forEach((ring, ri) => {
    // A closed ring repeats its first vertex last: never sample it twice.
    const a = ring[0];
    const z = ring[ring.length - 1];
    const m = a.lng === z.lng && a.lat === z.lat ? ring.length - 1 : ring.length;
    const k = Math.min(m, Math.max(RIM_MIN_PER_RING, Math.round((RIM_SAMPLES * lens[ri]) / total)));
    const idx = new Set<number>();
    let ex0 = 0;
    let ex1 = 0;
    let ey0 = 0;
    let ey1 = 0;
    for (let i = 1; i < m; i++) {
      if (ring[i].x < ring[ex0].x) ex0 = i;
      if (ring[i].x > ring[ex1].x) ex1 = i;
      if (ring[i].y < ring[ey0].y) ey0 = i;
      if (ring[i].y > ring[ey1].y) ey1 = i;
    }
    idx.add(ex0).add(ex1).add(ey0).add(ey1);
    // The vertex nearest each of k evenly spaced arc positions.
    const step = lens[ri] / k;
    let v = 0;
    let at = 0; // arc length at vertex v
    for (let j = 0; j < k; j++) {
      const target = j * step;
      while (v + 1 < m) {
        const next = at + Math.hypot(ring[v + 1].x - ring[v].x, ring[v + 1].y - ring[v].y);
        // Past the target: keep whichever end of this edge is nearer to it.
        const stop = next > target;
        if (stop && target - at <= next - target) break;
        v++;
        at = next;
        if (stop) break;
      }
      idx.add(v);
    }
    for (const i of [...idx].sort((p, q) => p - q)) picked.push(ring[i]);
  });
  const pack = new Float64Array(picked.length * STRIDE);
  picked.forEach((b, i) => packBase(pack, i, b));
  return { pack, count: picked.length };
}

/** Lid triangles per polygon (earcut + curvature subdivision), every 3 = a tri. */
const LID_MAX_EDGE_DEG = 0.3;
const lidBaseCache = new WeakMap<object, PBase[][]>();
export function lidBasesOf(g: { type?: string; coordinates?: unknown }): PBase[][] {
  let cached = lidBaseCache.get(g as object);
  if (cached) return cached;
  const ringBases = ringBasesOf(g);
  cached = ringBases.map((rings) => {
    const out: PBase[] = [];
    const data = flatten(rings.map((ring) => ring.map((p) => [p.x, p.y])));
    const idx = earcut(data.vertices, data.holes, data.dimensions);
    const flat = rings.flat();
    const edgeDeg = (a: PBase, b: PBase) => {
      const cos = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
      const dLng = (a.lng - b.lng) * cos;
      const dLat = a.lat - b.lat;
      return Math.sqrt(dLng * dLng + dLat * dLat);
    };
    const stack: [PBase, PBase, PBase][] = [];
    for (let k = 0; k < idx.length; k += 3) {
      stack.push([flat[idx[k]], flat[idx[k + 1]], flat[idx[k + 2]]]);
    }
    while (stack.length) {
      const [a, b, c] = stack.pop()!;
      const ab = edgeDeg(a, b);
      const bc = edgeDeg(b, c);
      const ca = edgeDeg(c, a);
      const longest = Math.max(ab, bc, ca);
      if (longest <= LID_MAX_EDGE_DEG) {
        out.push(a, b, c);
        continue;
      }
      if (longest === ab) {
        const m = baseOf((a.lng + b.lng) / 2, (a.lat + b.lat) / 2);
        stack.push([a, m, c], [m, b, c]);
      } else if (longest === bc) {
        const m = baseOf((b.lng + c.lng) / 2, (b.lat + c.lat) / 2);
        stack.push([b, m, a], [m, c, a]);
      } else {
        const m = baseOf((c.lng + a.lng) / 2, (c.lat + a.lat) / 2);
        stack.push([c, m, b], [m, a, b]);
      }
    }
    return out;
  });
  lidBaseCache.set(g as object, cached);
  return cached;
}

/** Hover-fill mesh (earcut + refine + boundary-distance field), per geometry. */
const fillBaseCache = new WeakMap<object, { pts: PBase[]; dNorm: number[] }>();
export function fillBasesOf(g: { type?: string; coordinates?: unknown }): {
  pts: PBase[];
  dNorm: number[];
} {
  let cached = fillBaseCache.get(g as object);
  if (cached) return cached;
  const polys = polysOf(g);
  // Unit bbox → subdivision threshold + lng scale for distances.
  let mnLa = 90;
  let mxLa = -90;
  let mnLo = 180;
  let mxLo = -180;
  for (const poly of polys) {
    for (const ring of poly) {
      for (const [lng, lat] of ring) {
        if (lat < mnLa) mnLa = lat;
        if (lat > mxLa) mxLa = lat;
        if (lng < mnLo) mnLo = lng;
        if (lng > mxLo) mxLo = lng;
      }
    }
  }
  const cosU = Math.cos((((mnLa + mxLa) / 2) * Math.PI) / 180) || 1e-6;
  const span = Math.max(mxLa - mnLa, (mxLo - mnLo) * cosU);
  const maxEdge = Math.max(span / 9, 0.015);
  // Sampled boundary edges (cos-scaled) for the distance field.
  const ex0: number[] = [];
  const ey0: number[] = [];
  const ex1: number[] = [];
  const ey1: number[] = [];
  for (const poly of polys) {
    for (const ring of poly) {
      const step = Math.max(1, Math.floor(ring.length / 600));
      for (let i = 0; i < ring.length; i += step) {
        const a = ring[i];
        const b = ring[Math.min(i + step, ring.length - 1)];
        ex0.push(a[0] * cosU);
        ey0.push(a[1]);
        ex1.push(b[0] * cosU);
        ey1.push(b[1]);
      }
    }
  }
  const segDist2 = (i: number, px: number, py: number): number => {
    const ax = ex0[i];
    const ay = ey0[i];
    const dx = ex1[i] - ax;
    const dy = ey1[i] - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = px - (ax + dx * t);
    const qy = py - (ay + dy * t);
    return qx * qx + qy * qy;
  };
  // Uniform grid over the boundary edges. The naive nearest-edge scan is O(V×E)
  // — measured at ~159M operations for one drill's fills. Each edge is filed in
  // every cell its bbox touches, so a query tests only nearby edges and stops
  // as soon as the next ring cannot beat the best hit found so far.
  let gMinX = Infinity;
  let gMinY = Infinity;
  let gMaxX = -Infinity;
  let gMaxY = -Infinity;
  for (let i = 0; i < ex0.length; i++) {
    if (Math.min(ex0[i], ex1[i]) < gMinX) gMinX = Math.min(ex0[i], ex1[i]);
    if (Math.min(ey0[i], ey1[i]) < gMinY) gMinY = Math.min(ey0[i], ey1[i]);
    if (Math.max(ex0[i], ex1[i]) > gMaxX) gMaxX = Math.max(ex0[i], ex1[i]);
    if (Math.max(ey0[i], ey1[i]) > gMaxY) gMaxY = Math.max(ey0[i], ey1[i]);
  }
  const GN = 48;
  const cell = Math.max((gMaxX - gMinX) / GN, (gMaxY - gMinY) / GN, 1e-9);
  const gw = Math.max(1, Math.min(GN, Math.floor((gMaxX - gMinX) / cell) + 1));
  const gh = Math.max(1, Math.min(GN, Math.floor((gMaxY - gMinY) / cell) + 1));
  const buckets: (number[] | undefined)[] = new Array(gw * gh);
  const cxOf = (x: number) => Math.max(0, Math.min(gw - 1, Math.floor((x - gMinX) / cell)));
  const cyOf = (y: number) => Math.max(0, Math.min(gh - 1, Math.floor((y - gMinY) / cell)));
  for (let i = 0; i < ex0.length; i++) {
    const ix0 = cxOf(Math.min(ex0[i], ex1[i]));
    const ix1 = cxOf(Math.max(ex0[i], ex1[i]));
    const iy0 = cyOf(Math.min(ey0[i], ey1[i]));
    const iy1 = cyOf(Math.max(ey0[i], ey1[i]));
    for (let y = iy0; y <= iy1; y++) {
      for (let x = ix0; x <= ix1; x++) {
        const k = y * gw + x;
        (buckets[k] ??= []).push(i);
      }
    }
  }
  const distOf = (lng: number, lat: number): number => {
    const px = lng * cosU;
    const py = lat;
    const ix = cxOf(px);
    const iy = cyOf(py);
    let best = Infinity;
    const maxR = Math.max(gw, gh);
    for (let r = 0; r <= maxR; r++) {
      // Unvisited cells sit at least (r-1) cells away — once that exceeds the
      // best hit, nothing farther out can win.
      if (best < Infinity && (r - 1) * cell > Math.sqrt(best)) break;
      const xa = Math.max(0, ix - r);
      const xb = Math.min(gw - 1, ix + r);
      const ya = Math.max(0, iy - r);
      const yb = Math.min(gh - 1, iy + r);
      for (let y = ya; y <= yb; y++) {
        const onEdgeRow = y === iy - r || y === iy + r;
        for (let x = xa; x <= xb; x++) {
          if (!onEdgeRow && x !== ix - r && x !== ix + r) continue; // ring only
          const b = buckets[y * gw + x];
          if (!b) continue;
          for (let j = 0; j < b.length; j++) {
            const d2 = segDist2(b[j], px, py);
            if (d2 < best) best = d2;
          }
        }
      }
    }
    if (best === Infinity) {
      for (let i = 0; i < ex0.length; i++) {
        const d2 = segDist2(i, px, py);
        if (d2 < best) best = d2;
      }
    }
    return Math.sqrt(best);
  };
  const edgeDeg2 = (a: PBase, b: PBase) => {
    const dLng = (a.lng - b.lng) * cosU;
    const dLat = a.lat - b.lat;
    return Math.sqrt(dLng * dLng + dLat * dLat);
  };
  const tris: PBase[] = [];
  const ringBases = ringBasesOf(g);
  for (const rings of ringBases) {
    const data = flatten(rings.map((ring) => ring.map((p) => [p.x, p.y])));
    const idx = earcut(data.vertices, data.holes, data.dimensions);
    const flat = rings.flat();
    const stack: [PBase, PBase, PBase][] = [];
    for (let k = 0; k < idx.length; k += 3) {
      stack.push([flat[idx[k]], flat[idx[k + 1]], flat[idx[k + 2]]]);
    }
    while (stack.length) {
      const [a, b, c] = stack.pop()!;
      const ab = edgeDeg2(a, b);
      const bc = edgeDeg2(b, c);
      const ca = edgeDeg2(c, a);
      const longest = Math.max(ab, bc, ca);
      if (longest <= maxEdge) {
        tris.push(a, b, c);
        continue;
      }
      if (longest === ab) {
        const m = baseOf((a.lng + b.lng) / 2, (a.lat + b.lat) / 2);
        stack.push([a, m, c], [m, b, c]);
      } else if (longest === bc) {
        const m = baseOf((b.lng + c.lng) / 2, (b.lat + c.lat) / 2);
        stack.push([b, m, a], [m, c, a]);
      } else {
        const m = baseOf((c.lng + a.lng) / 2, (c.lat + a.lat) / 2);
        stack.push([c, m, b], [m, a, b]);
      }
    }
  }
  const dNorm = new Array<number>(tris.length);
  let maxD = 1e-9;
  for (let i = 0; i < tris.length; i++) {
    dNorm[i] = distOf(tris[i].lng, tris[i].lat);
    if (dNorm[i] > maxD) maxD = dNorm[i];
  }
  for (let i = 0; i < dNorm.length; i++) dNorm[i] /= maxD;
  cached = { pts: tris, dNorm };
  fillBaseCache.set(g as object, cached);
  return cached;
}

/** Each outer ring's convex hull, [lng, lat] pair after pair, per geometry:
 *  what a fit frames with an outline. Every vertex lies within it, an islet's
 *  too, and a camera draws what lies within a hull within the hull it draws:
 *  a silhouette's box is decided at its hull's corners, where the frame bus's
 *  rim, sampled, misses the vertices between its samples. Monotone chain, in
 *  mercator. */
const fitHullCache = new WeakMap<object, Float64Array>();
export function fitHullOf(g: { type?: string; coordinates?: unknown }): Float64Array {
  let cached = fitHullCache.get(g as object);
  if (cached) return cached;
  const turn = (o: PBase, a: PBase, b: PBase) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const out: number[] = [];
  for (const poly of ringBasesOf(g)) {
    if (!poly[0]?.length) continue;
    const byX = [...poly[0]].sort((p, q) => p.x - q.x || p.y - q.y);
    // One chain west to east, the other back, each dropping its last point
    // while the next one does not turn the hull's way.
    const hull: PBase[] = [];
    for (const chain of [byX, [...byX].reverse()]) {
      const from = hull.length;
      for (const p of chain) {
        while (
          hull.length - from >= 2 &&
          turn(hull[hull.length - 2], hull[hull.length - 1], p) <= 0
        ) {
          hull.pop();
        }
        hull.push(p);
      }
      hull.pop(); // the other chain's first point
    }
    for (const p of hull) out.push(p.lng, p.lat);
  }
  cached = new Float64Array(out);
  fitHullCache.set(g as object, cached);
  return cached;
}
