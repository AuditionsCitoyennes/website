import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getKnownCoordinates, isGenericLocation } from "@ac/shared";
import { config } from "../../config";
import { readJson, writeAtomic } from "../../lib/diskCache";
import {
  arrondissementFromCitycode,
  isHomonyms,
  locate,
  parseContext,
  settleHomonyms,
  type BanFeature,
  type BanQuery,
  type GeoEntry,
  type Located,
} from "./match";

export { arrondissementFromCitycode, type GeoEntry };

// Server-side geocoder for canonical location names.
// - Uses the Base Adresse Nationale (api-adresse.data.gouv.fr) — the official
//   French geocoder: free, France-tuned, and generous on rate limits.
// - Captures the administrative hierarchy (département + région) from BAN's
//   `context` field so the UI can filter by area, not just exact location.
// - What BAN's answers mean — which commune, which level, or no place at all —
//   is decided in match.ts; this file runs the searches and keeps the results.
// - Results are persisted to disk so each location is resolved at most once,
//   surviving restarts. External calls are serialized + lightly throttled.

type Coords = [number, number];

// Bumped to v3 when `citycode` (INSEE) was added: old cache entries lack the
// field, so a fresh file is built (re-querying BAN once per location) rather than
// serving stale, citycode-less data. v4: lieux are placed by match.ts (exact
// commune names, départements and régions, overseas, homonyms kept as
// candidates); v3 entries hold the mis-pins it fixes, and lack `level`.
const CACHE_FILE = join(config.CACHE_DIR, ".geocode-cache-v4.json");
// The files the bumps left behind: never read again, removed once at boot.
const STALE_FILES = [".geocode-cache.json", ".geocode-cache-v2.json", ".geocode-cache-v3.json"];

const cache = new Map<string, Located>();

// The read, memoised as a promise: every caller before it lands waits on the
// SAME read. A flag set before the await let the first callers see an empty
// map on every cold start and re-query BAN for lieux the file already held.
let loading: Promise<{ entries: number }> | undefined;

function load(): Promise<{ entries: number }> {
  return (loading ??= readCache());
}

async function readCache(): Promise<{ entries: number }> {
  try {
    const obj = await readJson<Record<string, Located>>(CACHE_FILE);
    if (obj) for (const [k, v] of Object.entries(obj)) cache.set(k, v);
  } catch {
    /* unreadable: a cold cache */
  }
  await Promise.all(STALE_FILES.map((f) => rm(join(config.CACHE_DIR, f), { force: true })));
  return { entries: cache.size };
}

// Writes are coalesced (a warm pass resolves dozens of lieux in a row, and
// each used to rewrite the whole file), serialised (a later snapshot never
// lands under an earlier one), atomic (tmp + rename: a crash mid-write leaves
// the previous file whole) and compact. flushGeocodeCache() writes what is
// pending now — for a shutdown.
const PERSIST_DEBOUNCE_MS = 1000;
let dirty = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<void> = Promise.resolve();

function schedulePersist(): void {
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persist();
  }, PERSIST_DEBOUNCE_MS);
  // A pending cache write must never hold the process open (scripts, tests).
  persistTimer.unref?.();
}

function persist(): Promise<void> {
  writing = writing.then(async () => {
    if (!dirty) return;
    dirty = false;
    const obj: Record<string, Located> = {};
    for (const [k, v] of cache) obj[k] = v;
    try {
      await writeAtomic(CACHE_FILE, JSON.stringify(obj));
    } catch {
      // Kept for the next write (or the flush): the entries are still in memory.
      dirty = true;
    }
  });
  return writing;
}

/**
 * Makes sure the persisted cache has been read (before `getCachedEntry`).
 * Awaited once at boot, before the server listens; instant afterwards.
 */
export function loadGeocodeCache(): Promise<{ entries: number }> {
  return load();
}

/** Write any entries not yet on disk, now. Nothing to do when none are. */
export async function flushGeocodeCache(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  schedulePersist();
}

/** Cached lookup (homonyms unsettled), or `undefined` if this name has never been resolved. */
export function getCachedEntry(name: string): Located | undefined {
  return cache.has(name) ? cache.get(name)! : undefined;
}

/**
 * Where each of these lieux goes, from the cache (no network): homonyms are
 * settled against the others (match.ts settleHomonyms), so pass a whole
 * corpus — every lieu of the map — not one name. Lieux never resolved are
 * left out.
 */
export function placeLieux(names: Iterable<string>): Map<string, GeoEntry | null> {
  const located = new Map<string, Located>();
  for (const name of names) {
    const v = getCachedEntry(name);
    if (v !== undefined) located.set(name, v);
  }
  return settleHomonyms(located);
}

interface GeocodeLogger {
  info(obj: object, msg: string): void;
}
let log: GeocodeLogger = { info: (obj, msg) => console.info(msg, obj) };

/** Route the geocoder's notes (a lieu left off the map, and why) through the app's logger. */
export function setGeocodeLogger(logger: GeocodeLogger): void {
  log = logger;
}

// A BAN call that never answered wedged this serial chain for the life of the
// process: the warm pass stayed "running", every /api/map hit returned early,
// the admin list's lookups hung. BAN answers in ~100 ms; five seconds is wide.
const BAN_TIMEOUT_MS = 5000;

/** BAN answered with an error status: 429 and 5xx are passing, another 4xx says the query itself is no good. */
class BanError extends Error {
  constructor(
    public status: number,
    what: string,
  ) {
    super(`BAN ${what} ${status}`);
    this.name = "BanError";
  }
}

// Lookups that failed, remembered in memory only — never in the file, where
// "no match" is final — and tried again further apart each time. Without
// this, one lieu BAN could not resolve made every /api/map hit start a warm
// pass, each issuing BAN calls and then dropping the cached map: per-poll
// upstream traffic, the very thing the cache is for.
const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const backoff = new Map<string, { until: number; tries: number }>();

/** When a lieu whose lookup failed may be tried again (undefined: it may now). */
export function backoffUntil(name: string): number | undefined {
  const b = backoff.get(name);
  return b && b.until > Date.now() ? b.until : undefined;
}

// Single-flight throttle: chain external calls so only one runs at a time.
let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;

function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = Math.max(0, 150 - (Date.now() - lastCall));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      // Stamp after the work too: a slot may issue several BAN calls (forward +
      // commune fallback + reverse), so spacing the *next* slot from this one's
      // completion keeps the 150ms gap meaningful instead of always collapsing it.
      lastCall = Date.now();
    }
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

interface BanResponse {
  features?: {
    geometry: { coordinates: [number, number] };
    properties?: {
      score?: number;
      type?: string;
      name?: string;
      city?: string;
      citycode?: string;
      postcode?: string;
      context?: string;
      population?: number;
    };
  }[];
}

/** Query BAN once. Throws on an HTTP error, so the caller can tell a refusal from a failure. */
async function searchBan(q: string, opts: BanQuery = {}): Promise<BanFeature[]> {
  const params = new URLSearchParams({ q, limit: String(opts.limit ?? 5) });
  if (opts.municipality) params.set("type", "municipality");
  if (opts.postcode) params.set("postcode", opts.postcode);
  const res = await fetch(`https://api-adresse.data.gouv.fr/search/?${params}`, {
    headers: { "User-Agent": "AuditionsCitoyennes/1.0" },
    signal: AbortSignal.timeout(BAN_TIMEOUT_MS),
  });
  if (!res.ok) throw new BanError(res.status, "search");
  const data = (await res.json()) as BanResponse;
  return (data.features ?? []).map((f) => {
    const p = f.properties ?? {};
    // BAN returns [lon, lat]; we store [lat, lon].
    const [lon, lat] = f.geometry.coordinates;
    return {
      coords: [lat, lon],
      score: p.score ?? 0,
      type: p.type ?? "",
      name: p.name ?? "",
      city: p.city ?? null,
      citycode: p.citycode ?? null,
      postcode: p.postcode ?? null,
      context: p.context ?? null,
      population: p.population ?? null,
    };
  });
}

/** Reverse-geocode coordinates → the BAN admin fields of the nearest address. */
async function reverseBan([lat, lon]: Coords): Promise<{
  citycode: string | null;
  context: string | null;
  city: string | null;
} | null> {
  const res = await fetch(`https://api-adresse.data.gouv.fr/reverse/?lat=${lat}&lon=${lon}`, {
    headers: { "User-Agent": "AuditionsCitoyennes/1.0" },
    signal: AbortSignal.timeout(BAN_TIMEOUT_MS),
  });
  if (!res.ok) throw new BanError(res.status, "reverse");
  const data = (await res.json()) as {
    features?: { properties?: { context?: string; city?: string; citycode?: string } }[];
  };
  const p = data.features?.[0]?.properties;
  if (!p) return null;
  return { citycode: p.citycode ?? null, context: p.context ?? null, city: p.city ?? null };
}

/** Resolve a canonical location to coords + admin area (cached + persisted). */
export async function resolve(name: string): Promise<Located> {
  await load();
  const cached = getCachedEntry(name);
  if (cached !== undefined) return cached;

  if (isGenericLocation(name)) {
    cache.set(name, null);
    schedulePersist();
    return null;
  }

  // Failed a moment ago: no slot in the throttle, no call, until its backoff ends.
  if (backoffUntil(name) !== undefined) return null;

  // One lookup per name at a time: several callers asking for the same lieu
  // (the admin list, the warm pass, a creation) share it instead of each
  // queueing a slot in the throttle.
  const pending = inflight.get(name);
  if (pending) return pending;
  const lookup = lookUp(name).finally(() => inflight.delete(name));
  inflight.set(name, lookup);
  return lookup;
}

const inflight = new Map<string, Promise<Located>>();

function lookUp(name: string): Promise<Located> {
  return throttle(async () => {
    const again = getCachedEntry(name);
    if (again !== undefined) return again;
    try {
      let entry = await locate(name, searchBan);

      // Curated locations (LOCATION_RULES coords): the forward search can match a
      // same-named street in the wrong arrondissement (e.g. "Parc Blandan" → Lyon
      // 1 instead of Lyon 7). Reverse-geocode the authoritative coordinates so the
      // arrondissement — and any missing admin area — matches the marker.
      const known = getKnownCoordinates(name);
      if (known) {
        try {
          const rev = await reverseBan(known);
          if (rev) {
            const ctx = parseContext(rev.context);
            const arrondissement = arrondissementFromCitycode(rev.citycode);
            // The curated coordinates are authoritative, so the reverse-geocode of
            // them wins over the forward match (which may have landed in the wrong
            // commune — the very reason this override exists). Keep a forward field
            // only when reverse didn't return it.
            const forward = entry && !isHomonyms(entry) ? entry : null;
            entry = {
              coords: known,
              arrondissement,
              citycode: rev.citycode ?? forward?.citycode ?? null,
              city: rev.city ?? forward?.city ?? null,
              depCode: ctx.depCode ?? forward?.depCode ?? null,
              depName: ctx.depName ?? forward?.depName ?? null,
              region: ctx.region ?? forward?.region ?? null,
              level: "address",
            };
          }
        } catch {
          /* reverse failed — keep the forward-search entry */
        }
      }

      if (entry === null) {
        log.info(
          { lieu: name },
          "geocode: lieu left off the map (no commune, département or région by that name)",
        );
      } else if (isHomonyms(entry)) {
        log.info(
          { lieu: name, communes: entry.homonyms.map((h) => `${h.citycode} (${h.depCode})`) },
          "geocode: several communes by that name, settled against the other lieux",
        );
      }

      cache.set(name, entry);
      backoff.delete(name);
      schedulePersist();
      return entry;
    } catch (e) {
      // A query BAN itself refuses (a 4xx other than 429) will never match:
      // as final as "no match", and kept like one. Anything else — a timeout,
      // the network, a 5xx, a 429 — is tried again later, further apart each
      // time; nothing of it reaches the file.
      if (e instanceof BanError && e.status >= 400 && e.status < 500 && e.status !== 429) {
        cache.set(name, null);
        schedulePersist();
        return null;
      }
      const tries = (backoff.get(name)?.tries ?? 0) + 1;
      const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (tries - 1));
      backoff.set(name, { until: Date.now() + wait, tries });
      return null;
    }
  });
}

/** Coordinates only (back-compat helper): a lieu named by several communes has none on its own. */
export async function geocode(name: string): Promise<Coords | null> {
  const v = await resolve(name);
  return v && !isHomonyms(v) ? v.coords : null;
}
