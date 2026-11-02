// Pure helpers of the static outline build (docs/map-outlines.md): the file
// format v1, the 5-decimal rounding every coordinate goes through, a unit's
// centre and extent, and the measures the gates take (segment sets, the
// coincidence of a parent's edge with its children's lines, ring validity).
// No I/O here: build, pack, check and the web's loader share it.

export type Position = [number, number];
export type Ring = Position[];
export type Geometry =
  { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] };
/** The site's level names (apps/web/src/features/geo/types.ts LevelKey). */
export type Level = "country" | "region" | "dep" | "city" | "arr";
export type BBox = [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]

export interface OutlineSelf {
  id: string;
  bbox: BBox;
  center: Position; // [lat, lng]
  n: number;
  g: Geometry;
}
export interface OutlineEntry extends OutlineSelf {
  name: string;
  level: Level;
  k: 0 | 1;
  u: 0 | 1;
}
interface FileHead {
  v: 1;
  build: string;
  id: string;
  tier: string;
  tolM: number;
  self: OutlineSelf;
  wrap?: 1;
}
export type OutlineFileV1 =
  (FileHead & { kind: "k"; units: OutlineEntry[] }) | (FileHead & { kind: "u" | "g" });
export interface RootRow {
  id: string;
  parent: string | null;
  level: Level;
  name: string;
  bbox: BBox;
  center: Position;
  st: string;
  k: 0 | 1;
  u: 0 | 1;
  g: 0 | 1;
  wrap?: 1;
}
export interface RootV1 {
  v: 1;
  build: string;
  tiers: Record<string, { tolM: number; source: "etalab-50m" | "overture" }>;
  units: RootRow[];
}

/** Mercator's latitude limit: Antarctica (TAAF, Adélie Land) is cut there. */
export const MAX_LAT = 85.0511;
export const MAX_SELF_VERTICES = 20_000;
export const MAX_BUNDLE_VERTICES = 120_000;
export const MAX_BUNDLE_BYTES = 1_500_000;
export const MAX_FILE_BYTES = 5_000_000;
export const MAX_FILES = 1_000;

/** A unit id as a file name: `fr:dep:69` → `fr_dep_69` (ids never hold `_`). */
export function keyOf(id: string): string {
  if (id.includes("_"))
    throw new Error(`unit id ${id} contains "_": its file name would be ambiguous`);
  return id.replaceAll(":", "_");
}
export const idOfKey = (key: string): string => key.replaceAll("_", ":");

export const r5 = (v: number): number => Math.round(v * 1e5) / 1e5;

/**
 * Round to 5 decimals (about 1.1 m), clamp latitudes to ±MAX_LAT, drop
 * repeated points, close rings, drop rings that collapse (a polygon whose
 * exterior collapses goes with its holes). Null when nothing is left.
 */
export function clean5(geom: Geometry): Geometry | null {
  const out: Ring[][] = [];
  for (const poly of polygonsOf(geom)) {
    const rings: Ring[] = [];
    for (let i = 0; i < poly.length; i++) {
      const pts: Ring = [];
      for (const [x, y] of poly[i]) {
        const p: Position = [r5(x), r5(Math.max(-MAX_LAT, Math.min(MAX_LAT, y)))];
        const q = pts[pts.length - 1];
        if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p);
      }
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (pts.length > 1 && (a[0] !== b[0] || a[1] !== b[1])) pts.push([a[0], a[1]]);
      if (pts.length >= 4) rings.push(pts);
      else if (i === 0) break;
    }
    if (rings.length) out.push(rings);
  }
  if (!out.length) return null;
  return out.length === 1
    ? { type: "Polygon", coordinates: out[0] }
    : { type: "MultiPolygon", coordinates: out };
}

export function polygonsOf(geom: Geometry): Ring[][] {
  return geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
}
export const ringsOf = (geom: Geometry): Ring[] => polygonsOf(geom).flat();
export const vertexCount = (geom: Geometry): number =>
  ringsOf(geom).reduce((n, r) => n + r.length, 0);

// ---- centre and extent: a copy of the API's enrich() -------------------------
// apps/api/src/modules/boundaries/geometry.ts computeBounds / computeCenter,
// copied (that module goes away with /api/boundaries); lib.test.ts holds them
// equal. Its bounds {minLat, maxLat, minLng, maxLng} are our bbox.

function computeBounds(geom: Geometry): BBox {
  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const poly of polygonsOf(geom)) {
    for (const ring of poly) {
      for (const [lng, lat] of ring) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }
    }
  }
  return [minLng, minLat, maxLng, maxLat];
}
export const bboxOf = computeBounds;

export function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

function computeCenter(geom: Geometry): Position {
  let best: Ring | null = null;
  let bestArea = -1;
  for (const poly of polygonsOf(geom)) {
    const area = Math.abs(ringArea(poly[0]));
    if (area > bestArea) {
      bestArea = area;
      best = poly[0];
    }
  }
  if (!best || best.length < 3) {
    const [minLng, minLat, maxLng, maxLat] = computeBounds(geom);
    return [(minLat + maxLat) / 2, (minLng + maxLng) / 2];
  }
  let x = 0;
  let y = 0;
  let a = 0;
  for (let i = 0, j = best.length - 1; i < best.length; j = i++) {
    const f = best[j][0] * best[i][1] - best[i][0] * best[j][1];
    x += (best[j][0] + best[i][0]) * f;
    y += (best[j][1] + best[i][1]) * f;
    a += f;
  }
  a *= 0.5;
  if (!a) return [best[0][1], best[0][0]];
  return [y / (6 * a), x / (6 * a)]; // [lat, lng]
}

/** A unit's extent and pin centre ([lat, lng], the largest ring's centroid). */
export function enrich(geom: Geometry): { bbox: BBox; center: Position } {
  return { bbox: computeBounds(geom), center: computeCenter(geom) };
}

// ---- segment sets ---------------------------------------------------------------
// Two outlines coincide when they hold the same boundary segments, compared
// as exact 5-decimal keys (no tolerance): the test 05b-raw-union-all ran on
// Etalab, where every département is the union of its communes.

const pointKey = (p: Position): string => `${p[0]},${p[1]}`;
const segKey = (a: Position, b: Position): string => {
  const ka = pointKey(a);
  const kb = pointKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};
function eachSegment(geom: Geometry, fn: (a: Position, b: Position) => void): void {
  for (const r of ringsOf(geom)) for (let i = 0; i + 1 < r.length; i++) fn(r[i], r[i + 1]);
}
export function segmentKeys(geom: Geometry): Set<string> {
  const s = new Set<string>();
  eachSegment(geom, (a, b) => s.add(segKey(a, b)));
  return s;
}
/** The union's boundary of polygons that tile a territory: the segments drawn once. */
export function unionBoundary(geoms: Geometry[]): Set<string> {
  const n = new Map<string, number>();
  for (const g of geoms) for (const k of segmentKeys(g)) n.set(k, (n.get(k) ?? 0) + 1);
  return new Set([...n].filter(([, c]) => c === 1).map(([k]) => k));
}
export function setDiff(a: Set<string>, b: Set<string>): { onlyA: number; onlyB: number } {
  let onlyA = 0;
  let onlyB = 0;
  for (const k of a) if (!b.has(k)) onlyA++;
  for (const k of b) if (!a.has(k)) onlyB++;
  return { onlyA, onlyB };
}
export const isSubset = (a: Set<string>, b: Set<string>): boolean => setDiff(a, b).onlyA === 0;

// ---- distances in local metres (spike geomdist.mjs) --------------------------------

type Seg = [number, number, number, number];
const CELL_M = 200;
class SegmentGrid {
  private cells = new Map<number, number[]>();
  constructor(private segs: Seg[]) {
    segs.forEach((s, i) => {
      const [x0, x1] = [Math.min(s[0], s[2]), Math.max(s[0], s[2])].map((v) =>
        Math.floor(v / CELL_M),
      );
      const [y0, y1] = [Math.min(s[1], s[3]), Math.max(s[1], s[3])].map((v) =>
        Math.floor(v / CELL_M),
      );
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          const k = x * 1e6 + y;
          const a = this.cells.get(k);
          if (a) a.push(i);
          else this.cells.set(k, [i]);
        }
    });
  }
  /** Distance from (px, py) to the nearest segment, searching rings of cells outwards. */
  dist(px: number, py: number): number {
    if (!this.cells.size) return Infinity;
    const cx = Math.floor(px / CELL_M);
    const cy = Math.floor(py / CELL_M);
    let best = Infinity;
    const scan = (x: number, y: number) => {
      for (const i of this.cells.get(x * 1e6 + y) ?? []) {
        const [ax, ay, bx, by] = this.segs[i];
        const dx = bx - ax;
        const dy = by - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
      }
    };
    for (let r = 0; r < 20_000 && !(r > 0 && (r - 1) * CELL_M > best); r++) {
      if (r === 0) scan(cx, cy);
      for (let x = cx - r; r && x <= cx + r; x++) {
        scan(x, cy - r);
        scan(x, cy + r);
      }
      for (let y = cy - r + 1; r && y <= cy + r - 1; y++) {
        scan(cx - r, y);
        scan(cx + r, y);
      }
    }
    return best;
  }
}
function localMetres(geom: Geometry): (p: Position) => [number, number] {
  const [w, s, e, n] = bboxOf(geom);
  const lat0 = (s + n) / 2;
  const lng0 = (w + e) / 2;
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return ([x, y]) => [(x - lng0) * kx, (y - lat0) * 110_574];
}

export interface Coincidence {
  /** Farthest vertex of the children's outer edges from the parent's ring, metres. */
  childToSelfM: number;
  /** Farthest vertex of the parent's ring from any child line, metres. */
  selfToChildM: number;
  /** Share of the parent ring's length made of segments some child also draws. */
  sharedPct: number;
}

/**
 * How well a parent's edge lies on its children's lines: a vertex lies on
 * them when it is one of their vertices (exact key); a stray is measured to
 * the nearest line in local metres. 0 m / 0 m / 100 % is exact coincidence.
 */
export function coincidence(self: Geometry, children: Geometry[]): Coincidence {
  const P = localMetres(self);
  const childSegs = new Set<string>();
  const childPts = new Set<string>();
  const childLines: Seg[] = [];
  for (const c of children)
    eachSegment(c, (a, b) => {
      childSegs.add(segKey(a, b));
      childPts.add(pointKey(a));
      childLines.push([...P(a), ...P(b)]);
    });
  const selfPts = new Set<string>();
  const selfLines: Seg[] = [];
  let len = 0;
  let alone = 0;
  eachSegment(self, (a, b) => {
    selfPts.add(pointKey(a));
    const s: Seg = [...P(a), ...P(b)];
    selfLines.push(s);
    const l = Math.hypot(s[2] - s[0], s[3] - s[1]);
    len += l;
    if (!childSegs.has(segKey(a, b))) alone += l;
  });
  const far = (pts: Iterable<string>, known: Set<string>, lines: Seg[]): number => {
    let grid: SegmentGrid | null = null;
    let max = 0;
    for (const k of pts) {
      if (known.has(k)) continue;
      grid ??= new SegmentGrid(lines);
      const [x, y] = k.split(",").map(Number);
      max = Math.max(max, grid.dist(...P([x, y])));
    }
    return max;
  };
  const outerPts = new Set<string>();
  for (const k of unionBoundary(children)) for (const p of k.split("|")) outerPts.add(p);
  return {
    childToSelfM: far(outerPts, selfPts, selfLines),
    selfToChildM: far(selfPts, childPts, childLines),
    sharedPct: alone ? 100 * (1 - alone / len) : 100,
  };
}

// ---- validity (the part that needs no GEOS; check.ts adds DuckDB's ST_IsValid) ----

/** What is wrong with a geometry's rings, as short messages (empty when fine). */
export function ringProblems(geom: Geometry, wrap = false): string[] {
  const out: string[] = [];
  polygonsOf(geom).forEach((poly, pi) =>
    poly.forEach((r, ri) => {
      const at = `polygon ${pi} ring ${ri}`;
      if (r.length < 4) out.push(`${at}: ${r.length} positions`);
      const a = r[0];
      const b = r[r.length - 1];
      if (!a || a[0] !== b[0] || a[1] !== b[1]) out.push(`${at}: not closed`);
      for (let i = 0; i < r.length; i++) {
        const [x, y] = r[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) out.push(`${at}: non-finite position ${i}`);
        else if (Math.abs(y) > MAX_LAT) out.push(`${at}: latitude ${y}`);
        else if (!wrap && Math.abs(x) > 180) out.push(`${at}: longitude ${x}`);
        if (i && x === r[i - 1][0] && y === r[i - 1][1]) out.push(`${at}: repeated point ${i}`);
      }
    }),
  );
  return out;
}

/** The rings oriented as RFC 7946 says: exteriors counter-clockwise, holes clockwise. */
export function rewind(geom: Geometry): Geometry {
  const polys = polygonsOf(geom).map((poly) =>
    poly.map((r, i) => (ringArea(r) < 0 === (i === 0) ? [...r].reverse() : r)),
  );
  return geom.type === "Polygon"
    ? { type: "Polygon", coordinates: polys[0] }
    : { type: "MultiPolygon", coordinates: polys };
}

/** Winding signs of a geometry's exteriors and holes (+1 counter-clockwise). */
export function windings(geom: Geometry): { ext: Set<number>; hole: Set<number> } {
  const ext = new Set<number>();
  const hole = new Set<number>();
  for (const poly of polygonsOf(geom))
    poly.forEach((r, i) => (i ? hole : ext).add(Math.sign(ringArea(r))));
  return { ext, hole };
}

// ---- format v1 ------------------------------------------------------------------

const LEVELS = new Set(["country", "region", "dep", "city", "arr"]);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isTuple = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every(isNum);
function selfProblem(s: unknown, at: string): string | null {
  if (!s || typeof s !== "object") return `${at}: not an object`;
  const o = s as Record<string, unknown>;
  for (const k of ["id", "bbox", "center", "n", "g"])
    if (!(k in o)) return `${at}: missing key ${k}`;
  if (typeof o.id !== "string") return `${at}.id: not a string`;
  if (!isTuple(o.bbox, 4)) return `${at}.bbox: not [w, s, e, n]`;
  if (!isTuple(o.center, 2)) return `${at}.center: not [lat, lng]`;
  if (!isNum(o.n)) return `${at}.n: not a number`;
  const g = o.g as { type?: unknown; coordinates?: unknown } | null;
  if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon") || !Array.isArray(g.coordinates))
    return `${at}.g: not a Polygon or MultiPolygon`;
  return null;
}

/** Shape check of a k/u/g file of format v1 (the web's loader runs it on every file). */
export function validateFileV1(
  body: unknown,
): { ok: true; file: OutlineFileV1 } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("not an object");
  const o = body as Record<string, unknown>;
  for (const k of ["v", "build", "kind", "id", "tier", "tolM", "self"])
    if (!(k in o)) return fail(`missing key ${k}`);
  if (o.v !== 1) return fail(`v is ${JSON.stringify(o.v)}, not 1`);
  if (o.kind !== "k" && o.kind !== "u" && o.kind !== "g")
    return fail(`kind ${JSON.stringify(o.kind)}`);
  if (typeof o.build !== "string" || typeof o.id !== "string" || typeof o.tier !== "string")
    return fail("build, id and tier must be strings");
  if (!isNum(o.tolM)) return fail("tolM: not a number");
  const p = selfProblem(o.self, "self");
  if (p) return fail(p);
  if ((o.self as OutlineSelf).id !== o.id) return fail("self.id differs from id");
  if (o.kind === "k") {
    if (!Array.isArray(o.units)) return fail("missing key units");
    for (const [i, u] of o.units.entries()) {
      const q = selfProblem(u, `units[${i}]`);
      if (q) return fail(q);
      const e = u as Record<string, unknown>;
      if (typeof e.name !== "string") return fail(`units[${i}].name: not a string`);
      if (!LEVELS.has(e.level as string))
        return fail(`units[${i}].level ${JSON.stringify(e.level)}`);
      if ((e.k !== 0 && e.k !== 1) || (e.u !== 0 && e.u !== 1))
        return fail(`units[${i}]: k/u not 0|1`);
    }
  }
  return { ok: true, file: body as OutlineFileV1 };
}
