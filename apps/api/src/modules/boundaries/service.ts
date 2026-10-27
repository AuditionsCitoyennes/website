import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../../config";
import { ByteLru } from "../../lib/byteLru";
import { readJson, writeAtomic } from "../../lib/diskCache";
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
//     simplified, open), vendored in apps/api/data: a cold boot never contacts
//     GitHub for them.
//   - communes + arrondissements municipaux → the official Géo API (precise).
//   - a département as the map RAISES it → the union of its communes' Géo API
//     contours (getDepartement), so the communes drawn on it lie inside it.
// The endpoint is the single seam: today it reads these sources; later it can be
// swapped to a PostGIS-backed store + vector tiles without the frontend changing.

const GEO_API = "https://geo.api.gouv.fr";
const UA = { "User-Agent": "AuditionsCitoyennes/1.0" };

// ---- Caching (on disk across restarts: a commune is fetched once) ---------------
// One file per key under CACHE_DIR/.boundaries-cache/, the key URL-encoded in
// the name (a département's holds its recipe, "…:20000/15m"). Keys are
// immutable once set, so adding a commune writes ITS few kilobytes, atomically
// (tmp + rename), and never re-serialises the whole map — which was 11.7 MB,
// rewritten every 3 s while someone drilled, and in place, so a crash
// mid-write left a truncated file the next boot read as empty.
const CACHE_ROOT = join(config.CACHE_DIR, ".boundaries-cache");
// What the cache was before: the whole map in one file, split into the
// directory once, at boot, without fetching anything (migrateLegacyFile).
const LEGACY_FILE = join(config.CACHE_DIR, ".boundaries-cache.json");
// In memory, within the process budget (design A19): the most recently used
// 32 MB of the heap; the rest is read back from its file when asked again
// (`recall`), never fetched again. The values are parsed GeoJSON, on the
// heap, weighed at HEAP_PER_JSON_BYTE times their JSON: measured 1.9 for the
// levels' large features, 3.4 for a cache of communes' small ones.
const HEAP_PER_JSON_BYTE = 3.5;
const memory = new ByteLru<BoundaryCollection>("boundaries", 32 * 1024 * 1024, "heap");
const weigh = (json: string) => Math.ceil(json.length * HEAP_PER_JSON_BYTE);
// The keys that have a file, written or found at boot.
const onDisk = new Set<string>();

function fileOf(key: string): string {
  return join(CACHE_ROOT, `${encodeURIComponent(key)}.json`);
}

export interface BoundariesLoadReport {
  /** Keys read from the directory. */
  keys: number;
  /** Keys split out of the one-file cache this boot (0 when there was none). */
  migrated: number;
}

// The read, memoised as a promise: every caller before it lands waits on the
// SAME read. A flag set before the await let the three level requests GeoNav
// fires on mount see an empty map on every cold start.
let loading: Promise<BoundariesLoadReport> | undefined;

function load(): Promise<BoundariesLoadReport> {
  return (loading ??= readCache());
}

async function readCache(): Promise<BoundariesLoadReport> {
  await mkdir(CACHE_ROOT, { recursive: true });
  const migrated = await migrateLegacyFile();
  const names = await readdir(CACHE_ROOT);
  // What a write that never completed left behind.
  await Promise.all(
    names.filter((n) => n.endsWith(".tmp")).map((n) => rm(join(CACHE_ROOT, n), { force: true })),
  );
  const files = names.filter((n) => n.endsWith(".json"));
  for (const name of files) onDisk.add(decodeURIComponent(name.slice(0, -".json".length)));
  // Into memory while it has room; the others are read when first asked.
  await pool(files, 16, async (name) => {
    if (memory.bytes >= memory.maxBytes * 0.9) return;
    await readKey(decodeURIComponent(name.slice(0, -".json".length)));
  });
  return { keys: onDisk.size, migrated };
}

/**
 * Split the one-file cache of earlier versions into the directory, one file
 * per key, and remove it once every key has its file. Pure disk work: nothing
 * is fetched, nothing is recomputed. A file that is not JSON (one the old
 * in-place write left by halves) is left alone, and the cache starts cold.
 */
async function migrateLegacyFile(): Promise<number> {
  const legacy = await readJson<Record<string, BoundaryCollection>>(LEGACY_FILE).catch(
    () => undefined,
  );
  if (!legacy) return 0;
  const entries = Object.entries(legacy);
  await pool(entries, WRITE_CONCURRENCY, ([key, value]) =>
    writeAtomic(fileOf(key), JSON.stringify(value)),
  );
  await rm(LEGACY_FILE, { force: true });
  return entries.length;
}

// Persisting a key: its own file, written as soon as it is set. A few at a
// time (a bulk seeds a whole département's communes at once), each tracked
// until it lands so that flushBoundariesCache() can wait for them.
const WRITE_CONCURRENCY = 8;
let activeWrites = 0;
const waitingWrites: (() => void)[] = [];
const pendingWrites = new Set<Promise<void>>();

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (activeWrites >= WRITE_CONCURRENCY) await new Promise<void>((r) => waitingWrites.push(r));
  activeWrites++;
  try {
    return await fn();
  } finally {
    activeWrites--;
    waitingWrites.shift()?.();
  }
}

/** Keep a value in memory and in its file (once: keys never change once set). */
function remember(key: string, value: BoundaryCollection): void {
  const text = JSON.stringify(value);
  memory.set(key, value, weigh(text));
  if (onDisk.has(key)) return;
  const task = limited(() => writeAtomic(fileOf(key), text))
    .then(() => {
      onDisk.add(key);
    })
    .catch(() => {
      /* a cache: the entry is still in memory, fetched again after a restart at worst */
    });
  pendingWrites.add(task);
  void task.finally(() => pendingWrites.delete(task));
}

/** A key's file, back into memory (undefined: no file, or not a collection). */
async function readKey(key: string): Promise<BoundaryCollection | undefined> {
  let text: string;
  try {
    text = await readFile(fileOf(key), "utf8");
  } catch {
    onDisk.delete(key);
    return undefined;
  }
  let value: BoundaryCollection | undefined;
  try {
    value = JSON.parse(text) as BoundaryCollection;
  } catch {
    value = undefined;
  }
  // A file an older version wrote by halves: as if there were none.
  if (value?.type !== "FeatureCollection" || !Array.isArray(value.features)) {
    onDisk.delete(key);
    return undefined;
  }
  memory.set(key, value, weigh(text));
  return value;
}

/** A key from memory, else from its file. */
async function recall(key: string): Promise<BoundaryCollection | undefined> {
  return memory.get(key) ?? (onDisk.has(key) ? readKey(key) : undefined);
}

/** The boundaries held in memory, for /api/health. */
export function boundariesMemoryStats() {
  return { ...memory.stats(), onDisk: onDisk.size };
}

/**
 * Makes sure the directory has been read (every public function does). Awaited
 * once at boot, before the server listens, where its report is logged.
 */
export function loadBoundariesCache(): Promise<BoundariesLoadReport> {
  return load();
}

/** Wait for the writes in flight — for a shutdown. Nothing is buffered beyond them. */
export async function flushBoundariesCache(): Promise<void> {
  await Promise.all(pendingWrites);
}

// Every upstream call has a deadline: one that hangs would otherwise hold its
// callers until undici gives up (300 s). A commune's contour is a few kB; a
// département's all of its communes' (megabytes for a coast like Finistère's).
const COMMUNE_TIMEOUT_MS = 8000;
const DEP_TIMEOUT_MS = 20000;

// ---- The static levels: vendored (apps/api/data/france-geojson) -----------------
const LEVEL_FILE: Record<string, string> = {
  metropole: join(config.DATA_DIR, "france-geojson", "metropole-version-simplifiee.geojson"),
  regions: join(config.DATA_DIR, "france-geojson", "regions-version-simplifiee.geojson"),
  departements: join(config.DATA_DIR, "france-geojson", "departements-version-simplifiee.geojson"),
};

async function readLevel(level: string): Promise<BoundaryCollection> {
  const file = LEVEL_FILE[level];
  if (!file) throw new Error(`unknown boundary level: ${level}`);
  const raw = await readFile(file, "utf8");
  if (level === "metropole") {
    // The métropole contour is a bare Feature with empty properties: wrapped
    // into a one-feature collection and named here.
    const feat = JSON.parse(raw) as { geometry: Geometry };
    const enriched = enrich({ geometry: feat.geometry, properties: { code: "FR", nom: "France" } });
    return { type: "FeatureCollection", features: [enriched] };
  }
  const fc = JSON.parse(raw) as {
    features: { geometry: Geometry; properties: Record<string, unknown> }[];
  };
  return { type: "FeatureCollection", features: (fc.features ?? []).map(enrich) };
}

/** Métropole / régions / départements as one enriched FeatureCollection (cached). */
export async function getLevel(level: string): Promise<BoundaryCollection> {
  await load();
  const cached = await recall(level);
  if (cached) return cached;
  const fc = await readLevel(level);
  remember(level, fc);
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
export class UpstreamNotFound extends Error {}

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
  const cached = await recall(key);
  if (cached?.features[0]) return cached.features[0];

  return upstreamOnce(key, async () => {
    const url = `${GEO_API}/communes/${encodeURIComponent(insee)}?fields=nom,code,contour&format=geojson&geometry=contour`;
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(COMMUNE_TIMEOUT_MS) });
    if (res.status === 404) throw new UpstreamNotFound(`commune fetch 404 for ${insee}`);
    if (!res.ok) throw new Error(`commune fetch ${res.status} for ${insee}`);
    const feat = (await res.json()) as { geometry: Geometry; properties: Record<string, unknown> };
    const enriched = enrich(feat);
    remember(key, { type: "FeatureCollection", features: [enriched] });
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
        remember(key, { type: "FeatureCollection", features: [enriched] });
      }
    }
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
  // From memory, or read back from disk: a commune is fetched once.
  await pool(unique, 16, async (c) => {
    const hit = (await recall(`commune:${c}`))?.features[0];
    if (hit) found.set(c, hit);
    else missing.push(c);
  });

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
  const cached = await recall(key);
  if (cached?.features[0]) return cached.features[0];

  return upstreamOnce(key, async () => {
    const contours = (await fetchDepartementCommunes(code)).map((f) => f.geometry);
    const merged = contours.length ? mergeTiles(contours) : null;
    if (!merged) throw new Error(`no commune contours for département ${code}`);
    const nom = (await getLevel("departements")).features.find((f) => f.properties.code === code);
    const enriched = enrich({
      geometry: simplifyToBudget(merged, DEP_MAX_VERTICES, DEP_MAX_TOLERANCE_M),
      properties: { code, nom: nom?.properties.nom ?? "" },
    });
    remember(key, { type: "FeatureCollection", features: [enriched] });
    return enriched;
  });
}
