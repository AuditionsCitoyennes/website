// The France poster (apps/web/src/shared/ui/francePoster.ts): metropolitan
// France and its régions as a few kilobytes of SVG path data, drawn from our
// own outline build (Etalab / IGN, Licence Ouverte 2.0), never from Mapbox
// imagery. Shown where the live map is not: the home page's still card on a
// weak device, the map's fallback when it cannot start, and (as an option)
// under the map's loading curtain.
//
// Pure: the projection, the simplification and the path text. build.ts reads
// the outline file and writes the module; lib.test.ts checks each step.

export type Position = [number, number];
export type Ring = Position[];
export interface Geometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: Ring[] | Ring[][];
}

/** The régions of metropolitan France (the poster leaves the overseas ones
 *  out: they would be specks at this scale, and far apart). */
export const METRO_REGIONS: readonly string[] = [
  "fr:reg:11",
  "fr:reg:24",
  "fr:reg:27",
  "fr:reg:28",
  "fr:reg:32",
  "fr:reg:44",
  "fr:reg:52",
  "fr:reg:53",
  "fr:reg:75",
  "fr:reg:76",
  "fr:reg:84",
  "fr:reg:93",
  "fr:reg:94",
];

/** Web Mercator's y for a latitude, in radians of the sphere (north up: larger). */
export function mercatorY(lat: number): number {
  const phi = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + phi / 2));
}

/** The polygons of a geometry, each a list of rings (outer first). */
export function polygonsOf(g: Geometry): Ring[][] {
  return g.type === "Polygon" ? [g.coordinates as Ring[]] : (g.coordinates as Ring[][]);
}

/** Squared distance from p to the segment a–b. */
function segDist2(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0];
  const y = a[1] + t * dy - p[1];
  return x * x + y * y;
}

/** Douglas–Peucker on an open line: the points kept, ends always. */
export function simplifyLine(points: readonly Position[], tolerance: number): Position[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const tol2 = tolerance * tolerance;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segDist2(points[k], points[i], points[j]);
      if (d > worst) {
        worst = d;
        at = k;
      }
    }
    if (at >= 0 && worst > tol2) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return points.filter((_, k) => keep[k]);
}

/** Signed area of a ring (shoelace), in its own units. */
export function ringArea(ring: readonly Position[]): number {
  let a = 0;
  for (let k = 0, n = ring.length; k < n; k++) {
    const p = ring[k];
    const q = ring[(k + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * A closed ring simplified: split at its point farthest from the first (so
 * that both halves keep their ends), each half simplified, then rounded to
 * whole units with repeats dropped. Null when what is left is not a ring of
 * at least `minArea` square units.
 */
export function simplifyRing(ring: readonly Position[], tolerance: number, minArea: number) {
  const open =
    ring.length > 1 && samePoint(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring.slice();
  if (open.length < 3) return null;
  let far = 0;
  let best = -1;
  for (let k = 1; k < open.length; k++) {
    const d = (open[k][0] - open[0][0]) ** 2 + (open[k][1] - open[0][1]) ** 2;
    if (d > best) {
      best = d;
      far = k;
    }
  }
  const first = simplifyLine(open.slice(0, far + 1), tolerance);
  const second = simplifyLine([...open.slice(far), open[0]], tolerance);
  const joined = [...first, ...second.slice(1, -1)];
  const rounded: Position[] = [];
  for (const p of joined) {
    const r: Position = [Math.round(p[0]), Math.round(p[1])];
    if (!rounded.length || !samePoint(rounded[rounded.length - 1], r)) rounded.push(r);
  }
  while (rounded.length > 1 && samePoint(rounded[0], rounded[rounded.length - 1])) rounded.pop();
  if (rounded.length < 3 || Math.abs(ringArea(rounded)) < minArea) return null;
  return rounded;
}

const samePoint = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];

/** A ring as SVG path text: absolute move, then relative lines, closed. */
export function ringPath(ring: readonly Position[]): string {
  let d = `M${ring[0][0]} ${ring[0][1]}`;
  for (let k = 1; k < ring.length; k++) {
    const dx = ring[k][0] - ring[k - 1][0];
    const dy = ring[k][1] - ring[k - 1][1];
    d += `l${dx}${dy < 0 ? "" : " "}${dy}`;
  }
  return d + "z";
}

export interface PosterUnit {
  id: string;
  name: string;
  g: Geometry;
}

export interface Poster {
  /** The SVG viewBox: "0 0 <width> <height>". */
  viewBox: string;
  width: number;
  height: number;
  /** One entry per région kept, in the order given. */
  regions: { id: string; name: string; d: string }[];
}

/**
 * The poster of `units` (the régions of k/FR.json, METRO_REGIONS kept): Web
 * Mercator, scaled so that the whole is `width` units wide, a `pad` margin
 * around, each ring simplified at `tolerance` units and dropped under
 * `minArea` square units.
 */
export function buildPoster(
  units: readonly PosterUnit[],
  opts: { width?: number; pad?: number; tolerance?: number; minArea?: number } = {},
): Poster {
  const width = opts.width ?? 600;
  const pad = opts.pad ?? 8;
  const tolerance = opts.tolerance ?? 1.2;
  const minArea = opts.minArea ?? 6;
  const kept = units.filter((u) => METRO_REGIONS.includes(u.id));
  const projected = kept.map((u) => ({
    ...u,
    polys: polygonsOf(u.g).map((rings) =>
      rings.map((r) => r.map(([lon, lat]): Position => [lon, mercatorY(lat)])),
    ),
  }));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const u of projected)
    for (const rings of u.polys)
      for (const [x, y] of rings[0]) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
  // Longitude in degrees, y in radians: one scale for both once x is in radians.
  const xRad = (x: number) => (x * Math.PI) / 180;
  const scale = (width - 2 * pad) / (xRad(maxX) - xRad(minX));
  const height = Math.ceil((maxY - minY) * scale + 2 * pad);
  const toView = ([x, y]: Position): Position => [
    (xRad(x) - xRad(minX)) * scale + pad,
    (maxY - y) * scale + pad,
  ];
  const regions = projected.map((u) => {
    const parts: string[] = [];
    for (const rings of u.polys)
      for (const r of rings) {
        const s = simplifyRing(r.map(toView), tolerance, minArea);
        if (s) parts.push(ringPath(s));
      }
    return { id: u.id, name: u.name, d: parts.join("") };
  });
  return { viewBox: `0 0 ${width} ${height}`, width, height, regions: regions.filter((r) => r.d) };
}

/** The TypeScript module the site imports (shared/ui/francePoster.ts). */
export function posterModule(poster: Poster, build: string): string {
  const lines = [
    "// GENERATED by scripts/map-data/poster/build.ts — do not edit by hand.",
    `// Outline build ${build}: Etalab / IGN contours-administratifs 2026, under the`,
    "// Licence Ouverte / Open Licence 2.0 (derived: Web Mercator, simplified).",
    "// Metropolitan France's régions as SVG path data, for FrancePoster.vue.",
    "",
    `export const POSTER_VIEWBOX = ${JSON.stringify(poster.viewBox)};`,
    `export const POSTER_WIDTH = ${poster.width};`,
    `export const POSTER_HEIGHT = ${poster.height};`,
    "",
    "/** One path per région: its id, its name, its outline. */",
    "export const POSTER_REGIONS: readonly { id: string; name: string; d: string }[] = [",
    ...poster.regions.map(
      (r) =>
        `  { id: ${JSON.stringify(r.id)}, name: ${JSON.stringify(r.name)}, d: ${JSON.stringify(r.d)} },`,
    ),
    "];",
    "",
  ];
  return lines.join("\n");
}
