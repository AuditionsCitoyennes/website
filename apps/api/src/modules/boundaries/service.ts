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
