// Pure geometry for administrative boundaries: the shared types, a unit's
// derived centre and extent, the exact union of polygons that tile a territory
// and the Douglas–Peucker budget a raised outline is thinned to. No I/O here.

type LngLat = [number, number];
type Ring = LngLat[];
type Polygon = Ring[];
export type Geometry =
  { type: "Polygon"; coordinates: Polygon } | { type: "MultiPolygon"; coordinates: Polygon[] };

export interface Bounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** One administrative unit's outline + derived centre/extent (centre = [lat,lng]). */
export interface BoundaryFeature {
  type: "Feature";
  geometry: Geometry;
  properties: { code: string; nom: string; center: LngLat; bounds: Bounds };
}

export interface BoundaryCollection {
  type: "FeatureCollection";
  features: BoundaryFeature[];
}

function polygonsOf(geom: Geometry): Polygon[] {
  return geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
}

function computeBounds(geom: Geometry): Bounds {
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
  return { minLat, maxLat, minLng, maxLng };
}

function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

// Area-weighted centroid of the unit's largest polygon ring — a representative
// interior point for the pin (good enough for admin shapes; not pole-of-
// inaccessibility, which we can add later if a concave unit misplaces a pin).
function computeCenter(geom: Geometry): LngLat {
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
    const b = computeBounds(geom);
    return [(b.minLat + b.maxLat) / 2, (b.minLng + b.maxLng) / 2];
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

export function enrich(feature: {
  geometry: Geometry;
  properties: Record<string, unknown>;
}): BoundaryFeature {
  const p = feature.properties;
  return {
    type: "Feature",
    geometry: feature.geometry,
    properties: {
      code: String(p.code ?? ""),
      nom: String(p.nom ?? ""),
      center: computeCenter(feature.geometry),
      bounds: computeBounds(feature.geometry),
    },
  };
}

function ringHas(ring: Ring, lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// A ring whose mean width (2·area / perimeter) is under this many metres is a
// sliver — two neighbours drawing their shared border with different vertices
// — not a piece of the territory.
const SLIVER_M = 2;

/**
 * The union of polygons that tile a territory edge to edge — a département's
 * communes. Two neighbours draw their shared border with the SAME vertices (the
 * Géo API contours do), and once every ring is oriented (exterior counter-
 * clockwise, holes clockwise) one runs it forwards and the other backwards:
 * those edges cancel, and the edges left are the territory's own outline. Rings
 * are walked back out of them (turning as far left as possible where two rings
 * touch, so each closes on itself), holes nested into the smallest exterior
 * around them. Exact: no vertex is moved, so the union holds every tile.
 */
export function mergeTiles(geoms: Geometry[]): Geometry | null {
  const ids = new Map<string, number>();
  const coords: LngLat[] = [];
  const idOf = (p: LngLat): number => {
    const k = `${p[0]},${p[1]}`;
    let id = ids.get(k);
    if (id === undefined) {
      id = coords.length;
      ids.set(k, id);
      coords.push([p[0], p[1]]);
    }
    return id;
  };
  // Directed edges a→b still standing, keyed a·2^26 + b, with their multiplicity.
  const SHIFT = 2 ** 26;
  const edges = new Map<number, number>();
  for (const geom of geoms) {
    for (const poly of polygonsOf(geom)) {
      poly.forEach((raw, r) => {
        const ring: number[] = [];
        for (const p of raw) {
          const id = idOf(p);
          if (ring[ring.length - 1] !== id) ring.push(id);
        }
        if (ring.length > 1 && ring[0] === ring[ring.length - 1]) ring.pop();
        if (ring.length < 3) return;
        const area = ringArea(ring.map((i) => coords[i]));
        if (area === 0) return;
        if (area > 0 !== (r === 0)) ring.reverse();
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          const back = b * SHIFT + a;
          const n = edges.get(back);
          if (n) {
            if (n === 1) edges.delete(back);
            else edges.set(back, n - 1);
          } else {
            const fwd = a * SHIFT + b;
            edges.set(fwd, (edges.get(fwd) ?? 0) + 1);
          }
        }
      });
    }
  }
  if (!edges.size) return null;

  const out = new Map<number, number[]>();
  for (const [k, n] of edges) {
    const a = Math.floor(k / SHIFT);
    const b = k - a * SHIFT;
    let list = out.get(a);
    if (!list) out.set(a, (list = []));
    for (let i = 0; i < n; i++) list.push(b);
  }
  // The edge out of `cur` turning furthest left from the way in (prev → cur).
  const take = (prev: number, cur: number): number | undefined => {
    const list = out.get(cur);
    if (!list?.length) return undefined;
    let best = 0;
    if (list.length > 1) {
      const [px, py] = coords[prev];
      const [cx, cy] = coords[cur];
      const ix = cx - px;
      const iy = cy - py;
      let bestTurn = -Infinity;
      list.forEach((w, i) => {
        const ox = coords[w][0] - cx;
        const oy = coords[w][1] - cy;
        const turn = w === prev ? -Math.PI : Math.atan2(ix * oy - iy * ox, ix * ox + iy * oy);
        if (turn > bestTurn) {
          bestTurn = turn;
          best = i;
        }
      });
    }
    return list.splice(best, 1)[0];
  };

  const exteriors: { ring: Ring; area: number }[] = [];
  const holes: { ring: Ring; area: number }[] = [];
  for (const start of out.keys()) {
    for (;;) {
      const first = out.get(start)!.pop();
      if (first === undefined) break;
      const walk = [start, first];
      let prev = start;
      let cur = first;
      while (cur !== start) {
        // Every vertex has as many edges in as out, so a walk always closes.
        const next = take(prev, cur);
        if (next === undefined) return null;
        walk.push(next);
        prev = cur;
        cur = next;
      }
      const ring = walk.map((i) => coords[i]);
      const area = ringArea(ring);
      const kx = 111320 * Math.cos((ring[0][1] * Math.PI) / 180);
      const ky = 110574;
      let perim = 0;
      for (let i = 1; i < ring.length; i++) {
        perim += Math.hypot((ring[i][0] - ring[i - 1][0]) * kx, (ring[i][1] - ring[i - 1][1]) * ky);
      }
      if (!(perim > 0) || (2 * Math.abs(area) * kx * ky) / perim < SLIVER_M) continue;
      (area > 0 ? exteriors : holes).push({ ring, area: Math.abs(area) });
    }
  }
  if (!exteriors.length) return null;
  exteriors.sort((p, q) => q.area - p.area);
  const polys: Polygon[] = exteriors.map((e) => [e.ring]);
  for (const h of holes) {
    // An edge's midpoint: a hole only ever TOUCHES its exterior at a vertex.
    const [a, b] = h.ring;
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    let at = -1; // the smallest exterior around it (they run largest first)
    for (let i = 0; i < exteriors.length; i++) {
      if (exteriors[i].area > h.area && ringHas(exteriors[i].ring, mx, my)) at = i;
    }
    if (at >= 0) polys[at].push(h.ring);
  }
  return polys.length === 1
    ? { type: "Polygon", coordinates: polys[0] }
    : { type: "MultiPolygon", coordinates: polys };
}

/** Douglas–Peucker on one closed ring, tolerance in metres. Each half of the
 *  ring keeps its farthest vertex whatever the tolerance, so an islet stays a
 *  shape (four corners), never collapsing to a line. */
function simplifyRing(ring: Ring, tolM: number): Ring {
  const n = ring.length - 1; // closed: ring[n] is ring[0]
  if (n <= 4) return ring;
  const kx = 111320 * Math.cos((ring[0][1] * Math.PI) / 180);
  const ky = 110574;
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[n] = 1;
  let far = 1;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot((ring[i][0] - ring[0][0]) * kx, (ring[i][1] - ring[0][1]) * ky);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  keep[far] = 1;
  const stack: [number, number, boolean][] = [
    [0, far, true],
    [far, n, true],
  ];
  while (stack.length) {
    const [a, b, force] = stack.pop()!;
    const ax = ring[a][0] * kx;
    const ay = ring[a][1] * ky;
    const dx = ring[b][0] * kx - ax;
    const dy = ring[b][1] * ky - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = ring[i][0] * kx - ax;
      const py = ring[i][1] * ky - ay;
      const t = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const d = Math.hypot(px - t * dx, py - t * dy);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at > 0 && (force || worst > tolM)) {
      keep[at] = 1;
      stack.push([a, at, false], [at, b, false]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

function vertexCount(geom: Geometry): number {
  let n = 0;
  for (const poly of polygonsOf(geom)) for (const ring of poly) n += ring.length;
  return n;
}

// What a raised outline may weigh, and how far it may be thinned. The plateau
// ships it to the DEM endpoint, some 22 bytes a vertex (the budget: ~430 KiB of
// the POST's 1 MiB, Fastify's limit), and meshes its walls, a quad an edge
// (~13 ms for 16 000 vertices, little beside the commune lines the same rebuild
// draws on its lid). A département inland stays exact under it (the Rhône,
// ~9 000 vertices); a coast full of inlets and islets is thinned to the least
// tolerance that fits — Finistère, among the heaviest, to some 12 m — and never
// past DEP_MAX_TOLERANCE_M, whatever it then weighs: no commune pokes out of its
// raised département by more, about a pixel at zoom 12.
export const DEP_MAX_VERTICES = 20000;
export const DEP_MAX_TOLERANCE_M = 15;

/** The geometry as is when it fits `max` vertices; else Douglas–Peucker'd at the
 *  least tolerance (metres, to ~5%) that fits, but never coarser than `capM`:
 *  past it the cap holds and the budget gives (rings never vanish, only thin
 *  out). */
export function simplifyToBudget(geom: Geometry, max: number, capM: number): Geometry {
  if (vertexCount(geom) <= max) return geom;
  const at = (tolM: number): Geometry => {
    const polys = polygonsOf(geom).map((poly) => poly.map((ring) => simplifyRing(ring, tolM)));
    return polys.length === 1
      ? { type: "Polygon", coordinates: polys[0] }
      : { type: "MultiPolygon", coordinates: polys };
  };
  let lo = 0.25; // metres: too fine (over budget)
  let hi = capM; // metres
  let best = at(hi);
  if (vertexCount(best) > max) return best;
  while (hi / lo > 1.05) {
    const mid = Math.sqrt(lo * hi);
    const g = at(mid);
    if (vertexCount(g) <= max) {
      hi = mid;
      best = g;
    } else lo = mid;
  }
  return best;
}
