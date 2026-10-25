// The map's polygon maths, pure: the hit rings the hover and the click test
// against, containment, the scanline interior a macro pin is anchored at,
// boxes, and the plateau's height rule — the one place the raised unit's
// height is decided (ensurePlateau raises it, the fit frames it).

import type { Bounds } from "@/features/geo";
import type { OutlineFC } from "../types";

export function polysOf(g: { type?: string; coordinates?: unknown }): number[][][][] {
  return (
    g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []
  ) as number[][][][];
}

// Polygon rings precompiled to flat typed arrays (plus a bbox each): hover
// hit-testing runs per mouse move, and traversing nested GeoJSON arrays over
// commune-precision contours is too slow for that.
export interface HitRing {
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
  xs: Float64Array;
  ys: Float64Array;
}

// Flatten a (multi)polygon's rings into typed arrays with per-ring bboxes, for
// fast per-mousemove hit testing. Skipping a ring whose bbox misses the point is
// parity-safe (such a ring contributes an even crossing count).
export function buildHitRings(geometry: unknown): HitRing[] {
  const out: HitRing[] = [];
  for (const poly of polysOf(geometry as { type?: string })) {
    for (const ring of poly) {
      const n = ring.length;
      const xs = new Float64Array(n);
      const ys = new Float64Array(n);
      let minLng = 180;
      let maxLng = -180;
      let minLat = 90;
      let maxLat = -90;
      for (let i = 0; i < n; i++) {
        const x = ring[i][0];
        const y = ring[i][1];
        xs[i] = x;
        ys[i] = y;
        if (x < minLng) minLng = x;
        if (x > maxLng) maxLng = x;
        if (y < minLat) minLat = y;
        if (y > maxLat) maxLat = y;
      }
      out.push({ minLng, maxLng, minLat, maxLat, xs, ys });
    }
  }
  return out;
}

export function hitTest(rings: HitRing[], lng: number, lat: number): boolean {
  let inside = false;
  for (const r of rings) {
    if (lng < r.minLng || lng > r.maxLng || lat < r.minLat || lat > r.maxLat) continue;
    const xs = r.xs;
    const ys = r.ys;
    for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
      const yi = ys[i];
      const yj = ys[j];
      if (yi > lat !== yj > lat) {
        const xi = xs[i];
        const xj = xs[j];
        if (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
  }
  return inside;
}

// Even-odd ray cast: is [lng, lat] strictly inside the (multi)polygon? Holes and
// disjoint parts handled by toggling across every ring.
export function pointInPolygon(lng: number, lat: number, polys: number[][][][]): boolean {
  let inside = false;
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
    }
  }
  return inside;
}

// Area-weighted centroid of the unit's VISIBLE strips (its "centre of the visible
// zone"), plus the midpoint of the widest strip as a guaranteed-interior fallback.
function scanlineCentroid(
  polys: number[][][][],
  latLo: number,
  latHi: number,
  lngLo: number,
  lngHi: number,
): {
  centroid: [number, number];
  bestMid: [number, number];
  bestW: number; // widest visible strip (° lng) — horizontal room for the pill
  latSpan: number; // lat extent (°) of rows with any interior — vertical room
} | null {
  const K = 15;
  let sumX = 0;
  let sumY = 0;
  let sumW = 0;
  let bestW = 0;
  let rows = 0;
  let bestMid: [number, number] | null = null;
  for (let k = 0; k < K; k++) {
    const lat = latLo + ((k + 0.5) / K) * (latHi - latLo);
    const xs: number[] = [];
    for (const poly of polys) {
      for (const ring of poly) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const y1 = ring[j][1];
          const y2 = ring[i][1];
          if (y1 <= lat !== y2 <= lat) {
            xs.push(ring[j][0] + ((lat - y1) / (y2 - y1)) * (ring[i][0] - ring[j][0]));
          }
        }
      }
    }
    xs.sort((p, q) => p - q);
    let rowHit = false;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const lo = Math.max(xs[i], lngLo);
      const hi = Math.min(xs[i + 1], lngHi);
      const w = hi - lo;
      if (w > 0) {
        rowHit = true;
        const mx = (lo + hi) / 2;
        sumX += mx * w;
        sumY += lat * w;
        sumW += w;
        if (w > bestW) {
          bestW = w;
          bestMid = [mx, lat];
        }
      }
    }
    if (rowHit) rows++;
  }
  if (!sumW || !bestMid) return null;
  return {
    centroid: [sumX / sumW, sumY / sumW],
    bestMid,
    bestW,
    latSpan: (rows / K) * (latHi - latLo),
  };
}

// Anchor a macro pin at the CENTRE of the unit's visible part: the area-weighted
// centroid of its on-screen strips (or the widest strip's midpoint if the centroid
// itself falls in a concavity). Cheap (one scanline pass) so it can run live on
// every move. Also reports the visible interior's rough extent (° lng of the
// widest strip, ° lat of covered rows) so updateSticky can decide whether the
// pill has clear ROOM to sit inside its own boundary.
// Returns null only when no part of the unit is in view.
export interface InteriorHit {
  pt: [number, number];
  bestW: number; // widest visible strip (° lng) — horizontal room for the pill
  latSpan: number; // lat extent (°) of rows with any interior — vertical room
}

export function interiorInView(geom: unknown, b: Bounds, v: Bounds): InteriorHit | null {
  const g = geom as { type?: string; coordinates?: unknown } | undefined;
  if (!g?.type) return null;
  const polys = polysOf(g);
  if (!polys.length) return null;
  const latLo = Math.max(b.minLat, v.minLat);
  const latHi = Math.min(b.maxLat, v.maxLat);
  const lngLo = Math.max(b.minLng, v.minLng);
  const lngHi = Math.min(b.maxLng, v.maxLng);
  if (latLo >= latHi || lngLo >= lngHi) return null;
  const c = scanlineCentroid(polys, latLo, latHi, lngLo, lngHi);
  if (!c) return null;
  const pt = pointInPolygon(c.centroid[0], c.centroid[1], polys) ? c.centroid : c.bestMid;
  return { pt, bestW: c.bestW, latSpan: c.latSpan };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return (
    a.minLat <= b.maxLat && a.maxLat >= b.minLat && a.minLng <= b.maxLng && a.maxLng >= b.minLng
  );
}

/** A ring's box, once per ring (boundary geometries are identity-stable, see
 *  the per-geometry caches in ./projection). */
const ringBoundsCache = new WeakMap<object, Bounds>();
export function ringBounds(ring: number[][]): Bounds {
  let b = ringBoundsCache.get(ring);
  if (!b) {
    b = { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 };
    for (const [lng, lat] of ring) {
      if (lat < b.minLat) b.minLat = lat;
      if (lat > b.maxLat) b.maxLat = lat;
      if (lng < b.minLng) b.minLng = lng;
      if (lng > b.maxLng) b.maxLng = lng;
    }
    ringBoundsCache.set(ring, b);
  }
  return b;
}

export function boundsOfFeatures(features: OutlineFC["features"]): Bounds | null {
  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const f of features) {
    const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
    if (!g?.type) continue;
    for (const poly of polysOf(g)) {
      for (const ring of poly) {
        for (const [lng, lat] of ring) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
        }
      }
    }
  }
  if (minLat > maxLat) return null;
  return { minLat, maxLat, minLng, maxLng };
}

export const unionBounds = (a: Bounds, b: Bounds): Bounds => ({
  minLat: Math.min(a.minLat, b.minLat),
  maxLat: Math.max(a.maxLat, b.maxLat),
  minLng: Math.min(a.minLng, b.minLng),
  maxLng: Math.max(a.maxLng, b.maxLng),
});
export const boundsContain = (a: Bounds, b: Bounds) =>
  b.minLat >= a.minLat && b.maxLat <= a.maxLat && b.minLng >= a.minLng && b.maxLng <= a.maxLng;

// Plateau height for a selection: ~1.25% of the unit's own max bbox span, clamped.
// Derived from the GEOMETRY, not the viewport, so the height is deterministic per
// unit no matter what view it was selected from.
function heightForSelection(features: OutlineFC["features"]): number {
  const b = boundsOfFeatures(features);
  if (!b) return 500;
  const cos = Math.cos((((b.minLat + b.maxLat) / 2) * Math.PI) / 180) || 1e-6;
  const span = Math.max((b.maxLat - b.minLat) * 110574, (b.maxLng - b.minLng) * 111320 * cos);
  return Math.min(3500, Math.max(75, span * 0.0125));
}

/**
 * The plateau's height for the unit `scopeId` (its outline: `features`), m —
 * the lid stands WALL_OVERSHOOT over it. Height scales with the SELECTION's own
 * size (max bbox span), NOT the current viewport — selecting a small commune
 * from a zoomed-out view must not produce a kilometres-tall tower. A small
 * fraction of the unit's span reads as a consistent lift once the camera fits
 * it. Département/ville/arrondissement get HALF that: their fit views sit much
 * closer to the ground, where the full proportional lift reads too tall.
 * (Scope ids are path-encoded — the last segment's prefix is the level:
 * d:/v:/a:.) The fit reads it too (fitCamera): the lid is part of what it frames.
 */
export function plateauHeightM(scopeId: string, features: OutlineFC["features"]): number {
  const lastSeg = scopeId.split("/").pop() ?? "";
  const halfHeight = /^(d|v|a):/.test(lastSeg);
  return heightForSelection(features) * (halfHeight ? 0.5 : 1);
}
