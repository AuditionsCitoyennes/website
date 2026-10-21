import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../../config";
import {
  DEP_MAX_TOLERANCE_M,
  DEP_MAX_VERTICES,
  enrich,
  mergeTiles,
  simplifyToBudget,
  type BoundaryCollection,
  type BoundaryFeature,
  type Geometry,
} from "./geometry";

// Administrative boundary geometry, sourced from open data and served to the
// map (outlines) + used for real centroids/extents.
//   - métropole contour, régions, départements → france-geojson (IGN-derived,
//     simplified, open).
//   - communes + arrondissements municipaux → the official Géo API (precise).
//   - a département as the map RAISES it → the union of its communes' Géo API
//     contours (getDepartement), so the communes drawn on it lie inside it.
// The endpoint is the single seam: today it reads these sources; later it can be
// swapped to a PostGIS-backed store + vector tiles without the frontend changing.

const FR_GEOJSON = "https://raw.githubusercontent.com/gregoiredavid/france-geojson/master";
const GEO_API = "https://geo.api.gouv.fr";
const UA = { "User-Agent": "AuditionsCitoyennes/1.0" };

// ---- Caching (régions/départements are static — keep on disk across restarts) ----
const CACHE_FILE = join(config.CACHE_DIR, ".boundaries-cache.json");
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

// Every upstream call has a deadline: one that hangs would otherwise hold its
// callers until undici gives up (300 s). A level file is ~600 KB from GitHub;
// a commune's contour a few kB; a département's all of its communes' (megabytes
// for a coast like Finistère's).
const LEVEL_TIMEOUT_MS = 30000;
const COMMUNE_TIMEOUT_MS = 8000;
const DEP_TIMEOUT_MS = 20000;

async function fetchCollection(url: string): Promise<BoundaryCollection> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(LEVEL_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`boundary fetch ${res.status} for ${url}`);
  const fc = (await res.json()) as {
    features: { geometry: Geometry; properties: Record<string, unknown> }[];
  };
  return { type: "FeatureCollection", features: (fc.features ?? []).map(enrich) };
}

// Metropolitan France contour — upstream serves a bare Feature with empty
// properties, so wrap it into a one-feature collection and name it ourselves.
async function fetchMetropole(url: string): Promise<BoundaryCollection> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(LEVEL_TIMEOUT_MS) });
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
const inflight = new Map<string, Promise<unknown>>();

// A failure is remembered a while, so a code that failed (the API down) is not
// asked again on every visit — and a 404 (a dead or merged INSEE code, which
// used to be asked again on every pan) for a day.
const FAILURE_TTL_MS = 5 * 60 * 1000;
const NOT_FOUND_TTL_MS = 24 * 60 * 60 * 1000;
const failures = new Map<string, { until: number; error: unknown }>();

/** Upstream has no such unit (404). */
class UpstreamNotFound extends Error {}

/** `run` for `key`, once however many ask at the same time; its failure is
 *  thrown again to whoever asks before it expires, without a new call. */
async function upstreamOnce<T>(key: string, run: () => Promise<T>): Promise<T> {
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  const now = Date.now();
  for (const [k, f] of failures) if (f.until <= now) failures.delete(k);
  const failed = failures.get(key);
  if (failed) throw failed.error;

  const task = run();
  inflight.set(key, task);
  try {
    return await task;
  } catch (e) {
    const ttl = e instanceof UpstreamNotFound ? NOT_FOUND_TTL_MS : FAILURE_TTL_MS;
    failures.set(key, { until: Date.now() + ttl, error: e });
    throw e;
  } finally {
    inflight.delete(key);
  }
}

/** `run` over `items`, at most `size` at a time, each starting as soon as a slot frees. */
async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
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
    if (res.status === 404) throw new UpstreamNotFound(`commune fetch 404 for ${insee}`);
    if (!res.ok) throw new Error(`commune fetch ${res.status} for ${insee}`);
    const feat = (await res.json()) as { geometry: Geometry; properties: Record<string, unknown> };
    const enriched = enrich(feat);
    memory.set(key, { type: "FeatureCollection", features: [enriched] });
    schedulePersist();
    return enriched;
  });
}

/**
 * Every commune of a département, contours included, in ONE Géo API request
 * (single-flighted per département), each seeded into the cache under its
 * commune:<code> key. The outline getDepartement raises is the union of them;
 * getCommunes calls it when several communes of one département are missing
 * — one request instead of one per commune. (Arrondissements municipaux are
 * not in a département's set: they keep going through getCommune.)
 */
async function fetchDepartementCommunes(dep: string): Promise<BoundaryFeature[]> {
  return upstreamOnce(`departement-communes:${dep}`, async () => {
    const url = `${GEO_API}/communes?codeDepartement=${dep}&fields=nom,code&format=geojson&geometry=contour`;
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(DEP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`département fetch ${res.status} for ${dep}`);
    const fc = (await res.json()) as {
      features?: { geometry?: Geometry; properties?: Record<string, unknown> }[];
    };
    const features: BoundaryFeature[] = [];
    for (const f of fc.features ?? []) {
      const g = f.geometry;
      if (!(g?.type === "Polygon" || g?.type === "MultiPolygon")) continue;
      const enriched = enrich({ geometry: g, properties: f.properties ?? {} });
      features.push(enriched);
      const key = `commune:${enriched.properties.code}`;
      if (enriched.properties.code && !memory.has(key)) {
        memory.set(key, { type: "FeatureCollection", features: [enriched] });
      }
    }
    if (features.length) schedulePersist();
    return features;
  });
}

/** The département an INSEE code belongs to: 2A/2B for Corsica, 97x overseas,
 *  the first two digits elsewhere (an arrondissement municipal's too). */
function departementOf(insee: string): string | null {
  if (/^97\d{3}$/.test(insee)) return insee.slice(0, 3);
  if (/^2[AB]\d{3}$/i.test(insee)) return insee.slice(0, 2).toUpperCase();
  if (/^\d{5}$/.test(insee)) return insee.slice(0, 2);
  return null;
}

const CONCURRENCY = 6;
const BULK_CONCURRENCY = 2;

/**
 * Many communes in ONE call. The map needs every commune currently in view, and
 * fetching them one HTTP request at a time cost ~80 ms each, serially — the
 * dominant source of pan lag. Cached codes resolve instantly; the misses go
 * upstream by whole département when several of one are missing, one by one
 * through a pool otherwise, so we never hammer the Géo API.
 */
export async function getCommunes(codes: string[]): Promise<BoundaryCollection> {
  await load();
  const unique = [...new Set(codes.filter(Boolean))];
  const cachedOf = (c: string) => memory.get(`commune:${c}`)?.features[0];
  const found = new Map<string, BoundaryFeature>();
  const missing: string[] = [];
  for (const c of unique) {
    const hit = cachedOf(c);
    if (hit) found.set(c, hit);
    else missing.push(c);
  }

  // Several misses in one département: its whole set in the one request
  // getDepartement already makes, which seeds every commune of it.
  const byDep = new Map<string, number>();
  for (const c of missing) {
    const dep = departementOf(c);
    if (dep) byDep.set(dep, (byDep.get(dep) ?? 0) + 1);
  }
  const bulk = [...byDep].filter(([, n]) => n >= 2).map(([dep]) => dep);
  await pool(bulk, BULK_CONCURRENCY, (dep) =>
    fetchDepartementCommunes(dep).then(
      () => undefined,
      () => undefined,
    ),
  );

  // Still missing — an arrondissement municipal, a lone miss, a bulk that
  // failed — one by one through a pool: one slow commune no longer holds its
  // five neighbours. A dead or merged INSEE code 404s: skipped rather than
  // failing the batch, and not asked again for a day.
  const rest = missing.filter((c) => {
    const hit = cachedOf(c);
    if (hit) found.set(c, hit);
    return !hit;
  });
  await pool(rest, CONCURRENCY, async (c) => {
    try {
      found.set(c, await getCommune(c));
    } catch {
      /* skipped */
    }
  });

  const features: BoundaryFeature[] = [];
  for (const c of unique) {
    const f = found.get(c);
    if (f) features.push(f);
  }
  return { type: "FeatureCollection", features };
}

// ---- A département as the map raises it ------------------------------------------
// The france-geojson départements are simplified to ~3 km segments, and a chord
// of one can cut a commune off its own département: Saint-Mandé lay 99% outside
// the Val-de-Marne, a third of Vincennes too, both inside Paris's outline. So the
// outline a département is RAISED with is built from the same source as the
// communes drawn on it: the union of their Géo API contours.

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
    const contours = (await fetchDepartementCommunes(code)).map((f) => f.geometry);
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
