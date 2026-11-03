// The plateau mesh's geometries and mesh as they cross to the mesh worker and
// back (ac:mesh=worker, gl/meshClient.ts): a (multi)polygon flattened into
// one Float64Array of lng, lat pairs and two offset tables, so a postMessage
// moves three buffers instead of structured-cloning thousands of nested
// arrays, and the list of a mesh's buffers for the transfer list of its
// reply. Loaded on both sides of the worker: pure, no DOM (lib/corePurity.test.ts).

import { polysOf } from "../lib/polygon";
import type { MeshOut } from "./meshBuild";

/** A GeoJSON geometry, as the mesh builder reads it. */
export type Geom = { type?: string; coordinates?: unknown };

/** A geometry flattened. Polygon p's rings are ringOffsets[polyOffsets[p]] up
 *  to ringOffsets[polyOffsets[p + 1]]; ring r's vertices are
 *  coords[2 × ringOffsets[r]] up to coords[2 × ringOffsets[r + 1]]. A type
 *  other than Polygon and MultiPolygon keeps its name and has no polygon (the
 *  builder draws none: polysOf). */
export interface FlatGeom {
  type: string;
  coords: Float64Array<ArrayBuffer>;
  /** Polygons + 1 entries, indices into ringOffsets. */
  polyOffsets: Uint32Array<ArrayBuffer>;
  /** Rings + 1 entries, vertex indices into coords. */
  ringOffsets: Uint32Array<ArrayBuffer>;
}

/** `g` flattened; null for a geometry the builder skips (none, or no type). */
export function flatten(g: Geom | null | undefined): FlatGeom | null {
  if (!g?.type) return null;
  const polys = polysOf(g);
  let rings = 0;
  let vertices = 0;
  for (const poly of polys) {
    rings += poly.length;
    for (const ring of poly) vertices += ring.length;
  }
  const coords = new Float64Array(vertices * 2);
  const polyOffsets = new Uint32Array(polys.length + 1);
  const ringOffsets = new Uint32Array(rings + 1);
  let r = 0;
  let v = 0;
  for (let p = 0; p < polys.length; p++) {
    polyOffsets[p] = r;
    for (const ring of polys[p]) {
      ringOffsets[r++] = v;
      for (const [lng, lat] of ring) {
        coords[2 * v] = lng;
        coords[2 * v + 1] = lat;
        v++;
      }
    }
  }
  polyOffsets[polys.length] = r;
  ringOffsets[rings] = v;
  return { type: g.type, coords, polyOffsets, ringOffsets };
}

/** The vertices a flattened geometry holds. */
export function flatVertices(flat: FlatGeom): number {
  return flat.coords.length / 2;
}

/** `flat` as a GeoJSON geometry again: the same rings, the same numbers (a
 *  Float64Array keeps −0 and NaN), [lng, lat] per vertex. */
export function unflatten(flat: FlatGeom): Geom {
  const { coords, polyOffsets, ringOffsets } = flat;
  const polys: number[][][][] = [];
  for (let p = 0; p + 1 < polyOffsets.length; p++) {
    const poly: number[][][] = [];
    for (let r = polyOffsets[p]; r < polyOffsets[p + 1]; r++) {
      const ring: number[][] = [];
      for (let v = ringOffsets[r]; v < ringOffsets[r + 1]; v++) {
        ring.push([coords[2 * v], coords[2 * v + 1]]);
      }
      poly.push(ring);
    }
    polys.push(poly);
  }
  if (flat.type === "Polygon") return { type: "Polygon", coordinates: polys[0] ?? [] };
  if (flat.type === "MultiPolygon") return { type: "MultiPolygon", coordinates: polys };
  return { type: flat.type, coordinates: [] };
}

/** A flattened geometry's buffers, for a transfer list. */
export function flatBuffers(flat: FlatGeom): ArrayBuffer[] {
  return distinct([flat.coords, flat.polyOffsets, flat.ringOffsets]);
}

/** Every buffer a mesh's arrays stand on, each once (a transfer list naming
 *  one twice throws), the null arrays left out. */
export function meshBuffers(m: Partial<MeshOut>): ArrayBuffer[] {
  return distinct([
    m.rim,
    m.positions,
    m.lidPositions,
    m.linePositions,
    m.haloPositions,
    m.gWallPositions,
    m.gLidPositions,
    m.gLinePositions,
    m.gHaloPositions,
  ]);
}

function distinct(views: readonly (ArrayBufferView | null | undefined)[]): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const a of views) if (a && a.buffer instanceof ArrayBuffer) out.add(a.buffer);
  return [...out];
}
