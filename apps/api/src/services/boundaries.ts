import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Administrative boundary geometry, sourced from open data and served to the
// map (outlines) + used for real centroids/extents.
//   - métropole contour, régions, départements → france-geojson (IGN-derived,
//     simplified, open).
//   - communes + arrondissements municipaux → the official Géo API (precise).
//   - a département as the map RAISES it → the union of its communes' Géo API
//     contours (getDepartement), so the communes drawn on it lie inside it.
// The endpoint is the single seam: today it reads these sources; later it can be
// swapped to a PostGIS-backed store + vector tiles without the frontend changing.

type LngLat = [number, number];
type Ring = LngLat[];
type Polygon = Ring[];
type Geometry =
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

const FR_GEOJSON = "https://raw.githubusercontent.com/gregoiredavid/france-geojson/master";
const GEO_API = "https://geo.api.gouv.fr";
const UA = { "User-Agent": "AuditionsCitoyennes/1.0" };

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

function enrich(feature: {
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

// ---- Caching (régions/départements are static — keep on disk across restarts) ----
const CACHE_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".boundaries-cache.json",
);
const memory = new Map<string, BoundaryCollection>();
let loaded = false;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readFile(CACHE_FILE, "utf8");
    const obj = JSON.parse(raw) as Record<string, BoundaryCollection>;
    for (const [k, v] of Object.entries(obj)) memory.set(k, v);
  } catch {
    /* no cache yet */
  }
}

async function persist(): Promise<void> {
  const obj: Record<string, BoundaryCollection> = {};
  for (const [k, v] of memory) obj[k] = v;
  try {
    await writeFile(CACHE_FILE, JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

// Writing the WHOLE cache on every insert is O(n²): the file is already >1 MB,
// and drilling a dense département inserts dozens of communes in a row, so each
// one re-serialised megabytes on the event loop and stalled every in-flight
// request. Coalesce instead — the cache is a warm-start optimisation, so losing
// the last few seconds on a crash is harmless.
const PERSIST_DEBOUNCE_MS = 3000;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persist();
  }, PERSIST_DEBOUNCE_MS);
  // A pending cache write must never hold the process open.
  persistTimer.unref?.();
}

async function fetchCollection(url: string): Promise<BoundaryCollection> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`boundary fetch ${res.status} for ${url}`);
  const fc = (await res.json()) as {
    features: { geometry: Geometry; properties: Record<string, unknown> }[];
  };
  return { type: "FeatureCollection", features: (fc.features ?? []).map(enrich) };
}

// Metropolitan France contour — upstream serves a bare Feature with empty
// properties, so wrap it into a one-feature collection and name it ourselves.
async function fetchMetropole(url: string): Promise<BoundaryCollection> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`boundary fetch ${res.status} for ${url}`);
  const feat = (await res.json()) as { geometry: Geometry };
  const enriched = enrich({ geometry: feat.geometry, properties: { code: "FR", nom: "France" } });
  return { type: "FeatureCollection", features: [enriched] };
}

const LEVEL_URL: Record<string, string> = {
  metropole: `${FR_GEOJSON}/metropole-version-simplifiee.geojson`,
  regions: `${FR_GEOJSON}/regions-version-simplifiee.geojson`,
  departements: `${FR_GEOJSON}/departements-version-simplifiee.geojson`,
};

/** Métropole / régions / départements as one enriched FeatureCollection (cached). */
export async function getLevel(level: string): Promise<BoundaryCollection> {
  await load();
  const cached = memory.get(level);
  if (cached) return cached;
  const url = LEVEL_URL[level];
  if (!url) throw new Error(`unknown boundary level: ${level}`);
  const fc = level === "metropole" ? await fetchMetropole(url) : await fetchCollection(url);
  memory.set(level, fc);
  schedulePersist();
  return fc;
}

// One in-flight upstream request per cache key (INSEE code, département): a pan
// can ask for the same commune from several overlapping batches at once, and
// without this each would issue its own Géo API call.
const inflight = new Map<string, Promise<BoundaryFeature>>();

// A Géo API request that hangs would hold every request for its key until
// undici gives up (300 s); one that fails (a dead INSEE code, the API down)
// would be made again on every visit. So each has a deadline — a commune's
// contour is a few kB, a département's all of its communes' (megabytes for a
// coast like Finistère's), given longer — and a failure is remembered a while.
const COMMUNE_TIMEOUT_MS = 8000;
const DEP_TIMEOUT_MS = 20000;
const FAILURE_TTL_MS = 5 * 60 * 1000;
const failures = new Map<string, { at: number; error: unknown }>();

/** `run` for `key`, once however many ask at the same time; its failure is
 *  thrown again to whoever asks within FAILURE_TTL_MS, without a new call. */
async function upstreamOnce(
  key: string,
  run: () => Promise<BoundaryFeature>,
): Promise<BoundaryFeature> {
  const pending = inflight.get(key);
  if (pending) return pending;
  const now = Date.now();
  // Oldest first: the expired ones go, so a code asked once never piles up.
  for (const [k, f] of failures) {
    if (now - f.at < FAILURE_TTL_MS) break;
    failures.delete(k);
  }
  const failed = failures.get(key);
  if (failed) throw failed.error;

  const task = run();
  inflight.set(key, task);
  try {
    return await task;
  } catch (e) {
    failures.set(key, { at: Date.now(), error: e });
    throw e;
  } finally {
    inflight.delete(key);
  }
}

/** A single commune / arrondissement municipal by INSEE code (Géo API, precise). */
export async function getCommune(insee: string): Promise<BoundaryFeature> {
  await load();
  const key = `commune:${insee}`;
  const cached = memory.get(key);
  if (cached?.features[0]) return cached.features[0];

  return upstreamOnce(key, async () => {
    const url = `${GEO_API}/communes/${encodeURIComponent(insee)}?fields=nom,code,contour&format=geojson&geometry=contour`;
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(COMMUNE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`commune fetch ${res.status} for ${insee}`);
    const feat = (await res.json()) as { geometry: Geometry; properties: Record<string, unknown> };
    const enriched = enrich(feat);
    memory.set(key, { type: "FeatureCollection", features: [enriched] });
    schedulePersist();
    return enriched;
  });
}

/**
 * Many communes in ONE call. The map needs every commune currently in view, and
 * fetching them one HTTP request at a time cost ~80 ms each, serially — the
 * dominant source of pan lag. Cached codes resolve instantly; only the misses go
 * upstream, a few at a time so we never hammer the Géo API.
 */
export async function getCommunes(codes: string[]): Promise<BoundaryCollection> {
  await load();
  const unique = [...new Set(codes.filter(Boolean))];
  const features: BoundaryFeature[] = [];
  const CONCURRENCY = 6;

  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const slice = unique.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(slice.map((c) => getCommune(c)));
    for (const r of settled) {
      // A dead/merged INSEE code 404s — skip it rather than failing the batch.
      if (r.status === "fulfilled") features.push(r.value);
    }
  }
  return { type: "FeatureCollection", features };
}

// ---- A département as the map raises it ------------------------------------------
// The france-geojson départements are simplified to ~3 km segments, and a chord
// of one can cut a commune off its own département: Saint-Mandé lay 99% outside
// the Val-de-Marne, a third of Vincennes too, both inside Paris's outline. So the
// outline a département is RAISED with is built from the same source as the
// communes drawn on it: the union of their Géo API contours.

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
const DEP_MAX_VERTICES = 20000;
const DEP_MAX_TOLERANCE_M = 15;

/** The geometry as is when it fits `max` vertices; else Douglas–Peucker'd at the
 *  least tolerance (metres, to ~5%) that fits, but never coarser than `capM`:
 *  past it the cap holds and the budget gives (rings never vanish, only thin
 *  out). */
function simplifyToBudget(geom: Geometry, max: number, capM: number): Geometry {
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

// INSEE département codes: métropole, the two Corsican, the overseas.
const DEP_CODE = /^(\d{2}|2[AB]|97\d)$/;

/**
 * A département's outline as the map raises it: the union of its communes' Géo
 * API contours (one upstream request for all of them), within the vertex budget
 * and the tolerance cap, cached like a commune. Also the only outline the
 * overseas départements have — france-geojson covers the métropole alone.
 */
export async function getDepartement(code: string): Promise<BoundaryFeature> {
  if (!DEP_CODE.test(code)) throw new Error(`unknown département: ${code}`);
  await load();
  // The recipe in the key: an outline cached under other limits is made again.
  const key = `departement:${code}:${DEP_MAX_VERTICES}/${DEP_MAX_TOLERANCE_M}m`;
  const cached = memory.get(key);
  if (cached?.features[0]) return cached.features[0];

  return upstreamOnce(key, async () => {
    const url = `${GEO_API}/communes?codeDepartement=${code}&fields=code&format=geojson&geometry=contour`;
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(DEP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`département fetch ${res.status} for ${code}`);
    const fc = (await res.json()) as { features?: { geometry?: Geometry }[] };
    const contours = (fc.features ?? [])
      .map((f) => f.geometry)
      .filter((g): g is Geometry => g?.type === "Polygon" || g?.type === "MultiPolygon");
    const merged = contours.length ? mergeTiles(contours) : null;
    if (!merged) throw new Error(`no commune contours for département ${code}`);
    const nom = memory.get("departements")?.features.find((f) => f.properties.code === code);
    const enriched = enrich({
      geometry: simplifyToBudget(merged, DEP_MAX_VERTICES, DEP_MAX_TOLERANCE_M),
      properties: { code, nom: nom?.properties.nom ?? "" },
    });
    memory.set(key, { type: "FeatureCollection", features: [enriched] });
    schedulePersist();
    return enriched;
  });
}
