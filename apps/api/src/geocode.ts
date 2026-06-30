import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getKnownCoordinates, isGenericLocation } from "@ac/shared";

// Server-side geocoder for canonical location names.
// - Uses the Base Adresse Nationale (api-adresse.data.gouv.fr) — the official
//   French geocoder: free, France-tuned, and generous on rate limits.
// - Captures the administrative hierarchy (département + région) from BAN's
//   `context` field so the UI can filter by area, not just exact location.
// - Results are persisted to disk so each location is resolved at most once,
//   surviving restarts. External calls are serialized + lightly throttled.

type Coords = [number, number];

/** A resolved location: coordinates + administrative area (or null = no match). */
export interface GeoEntry {
  coords: Coords;
  /** Commune / city name (BAN `city`, e.g. "Lyon" — arrondissements collapsed). */
  city: string | null;
  /**
   * INSEE code (BAN `citycode`) of the finest unit — the commune, or the
   * arrondissement municipal for Paris/Lyon/Marseille (e.g. "69387" = Lyon 7e).
   * The join key for fetching that unit's boundary geometry.
   */
  citycode: string | null;
  /**
   * Arrondissement label for the big three cities (e.g. "Lyon 7e", "Paris 11e",
   * "Marseille 1er"), decoded from `citycode`. Null elsewhere — most communes
   * have no arrondissements.
   */
  arrondissement: string | null;
  depCode: string | null;
  depName: string | null;
  region: string | null;
}

// Bumped to v3 when `citycode` (INSEE) was added: old cache entries lack the
// field, so a fresh file is built (re-querying BAN once per location) rather than
// serving stale, citycode-less data.
const CACHE_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", ".geocode-cache-v3.json");

const cache = new Map<string, GeoEntry | null>();
let loaded = false;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readFile(CACHE_FILE, "utf8");
    const obj = JSON.parse(raw) as Record<string, GeoEntry | null>;
    for (const [k, v] of Object.entries(obj)) cache.set(k, v);
  } catch {
    /* no cache file yet */
  }
}

async function persist(): Promise<void> {
  const obj: Record<string, GeoEntry | null> = {};
  for (const [k, v] of cache) obj[k] = v;
  try {
    await writeFile(CACHE_FILE, JSON.stringify(obj, null, 2));
  } catch {
    /* ignore write errors */
  }
}

/** Cached entry, or `undefined` if this name has never been resolved. */
export function getCachedEntry(name: string): GeoEntry | null | undefined {
  return cache.has(name) ? cache.get(name)! : undefined;
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

// Metropolitan France (incl. Corsica) bounding box.
const FR_BBOX = { latMin: 41.0, latMax: 51.6, lonMin: -5.6, lonMax: 9.8 };

function inFrance([lat, lon]: Coords): boolean {
  return (
    lat >= FR_BBOX.latMin && lat <= FR_BBOX.latMax && lon >= FR_BBOX.lonMin && lon <= FR_BBOX.lonMax
  );
}

interface BanHit {
  coords: Coords;
  context: string | null;
  city: string | null;
  citycode: string | null;
}

/**
 * Query BAN once. Returns the top hit's coords + `context`, or null. Throws on
 * a transient HTTP error so the caller can retry without caching. A proximity
 * bias nudges ambiguous names toward the audition region.
 */
async function queryBan(name: string, municipalityOnly = false): Promise<BanHit | null> {
  const type = municipalityOnly ? "&type=municipality" : "";
  const res = await fetch(
    `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(name)}&limit=1&lat=45.6&lon=5.1${type}`,
    { headers: { "User-Agent": "AuditionsCitoyennes/1.0" } },
  );
  if (!res.ok) throw new Error(`BAN ${res.status}`);
  const data = (await res.json()) as {
    features?: {
      geometry: { coordinates: [number, number] };
      properties?: { context?: string; city?: string; citycode?: string };
    }[];
  };
  const feature = data.features?.[0];
  if (!feature) return null;
  // BAN returns [lon, lat]; we store [lat, lon].
  const [lon, lat] = feature.geometry.coordinates;
  return {
    coords: [lat, lon],
    context: feature.properties?.context ?? null,
    city: feature.properties?.city ?? null,
    citycode: feature.properties?.citycode ?? null,
  };
}

/** Reverse-geocode coordinates → the BAN admin fields of the nearest address. */
async function reverseBan([lat, lon]: Coords): Promise<{
  citycode: string | null;
  context: string | null;
  city: string | null;
} | null> {
  const res = await fetch(`https://api-adresse.data.gouv.fr/reverse/?lat=${lat}&lon=${lon}`, {
    headers: { "User-Agent": "AuditionsCitoyennes/1.0" },
  });
  if (!res.ok) throw new Error(`BAN reverse ${res.status}`);
  const data = (await res.json()) as {
    features?: { properties?: { context?: string; city?: string; citycode?: string } }[];
  };
  const p = data.features?.[0]?.properties;
  if (!p) return null;
  return { citycode: p.citycode ?? null, context: p.context ?? null, city: p.city ?? null };
}

// BAN `context` is "<depCode>, <depName>, <region>" e.g. "69, Rhône, Auvergne-Rhône-Alpes".
function parseContext(context: string | null): Pick<GeoEntry, "depCode" | "depName" | "region"> {
  if (!context) return { depCode: null, depName: null, region: null };
  const parts = context.split(",").map((s) => s.trim());
  return { depCode: parts[0] ?? null, depName: parts[1] ?? null, region: parts[2] ?? null };
}

// French ordinal for an arrondissement number: 1 → "1er", n → "ne".
function ordinalFr(n: number): string {
  return n === 1 ? "1er" : `${n}e`;
}

// Decode an arrondissement label from BAN's `citycode` (the 5-digit INSEE code).
// Only Paris (751xx), Lyon (693xx) and Marseille (132xx) split their commune into
// arrondissements; the code's last two digits give the number. Everywhere else
// the commune *is* the smallest unit, so there's no arrondissement.
function arrondissementFromCitycode(citycode: string | null): string | null {
  if (!citycode || !/^\d{5}$/.test(citycode)) return null;
  const n = Number(citycode);
  if (n >= 75101 && n <= 75120) return `Paris ${ordinalFr(n - 75100)}`;
  if (n >= 69381 && n <= 69389) return `Lyon ${ordinalFr(n - 69380)}`;
  if (n >= 13201 && n <= 13216) return `Marseille ${ordinalFr(n - 13200)}`;
  return null;
}

// A bare commune name ("Montgardin", "La Faurie") vs a place within a city
// ("Place Carnot, Lyon"). Communes resolve far better via a municipality
// lookup — BAN's default address search often matches a same-named street
// elsewhere in France.
const PLACE_PREFIX =
  /^(place|march[ée]|avenue|av|quai|parc|rue|cours|boulevard|bd|manif|maison|parvis|m[ée]diath[èe]que|gare|pont|esplanade|all[ée]e|square|jardin|halles?)\b/i;

function looksLikeCommune(name: string): boolean {
  if (name.includes(",")) return false;
  if (PLACE_PREFIX.test(name.trim())) return false;
  return true;
}

/** Resolve a canonical location to coords + admin area (cached + persisted). */
export async function resolve(name: string): Promise<GeoEntry | null> {
  await load();
  const cached = getCachedEntry(name);
  if (cached !== undefined) return cached;

  if (isGenericLocation(name)) {
    cache.set(name, null);
    await persist();
    return null;
  }

  return throttle(async () => {
    const again = getCachedEntry(name);
    if (again !== undefined) return again;
    try {
      const communeLike = looksLikeCommune(name);
      let hit = await queryBan(name, communeLike);
      // If outside metropolitan France (e.g. overseas namesake "Rambaud"),
      // retry in the other query mode.
      if (hit && !inFrance(hit.coords)) {
        const alt = await queryBan(name, !communeLike);
        hit = alt && inFrance(alt.coords) ? alt : null;
      }
      // No match, or a match with no administrative context (e.g. a named
      // venue like "Marché des Charpennes, Villeurbanne"): retry with the
      // trailing commune to recover the département/région. Keep any precise
      // coordinates we already have.
      if ((!hit || !hit.context) && name.includes(",")) {
        const commune = name.slice(name.lastIndexOf(",") + 1).trim();
        if (commune) {
          const c = await queryBan(commune, true);
          if (c && inFrance(c.coords)) {
            // Keep the precise hit's coords + citycode (the arrondissement lives
            // in the address-level code, not the commune fallback); borrow only
            // the commune's administrative context + city name.
            hit = hit
              ? { coords: hit.coords, context: c.context, city: c.city, citycode: hit.citycode }
              : c;
          }
        }
      }
      let entry: GeoEntry | null = hit
        ? {
            coords: hit.coords,
            city: hit.city,
            citycode: hit.citycode,
            arrondissement: arrondissementFromCitycode(hit.citycode),
            ...parseContext(hit.context),
          }
        : null;

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
            entry = entry
              ? {
                  ...entry,
                  arrondissement,
                  citycode: rev.citycode ?? entry.citycode,
                  city: rev.city ?? entry.city,
                  depCode: ctx.depCode ?? entry.depCode,
                  depName: ctx.depName ?? entry.depName,
                  region: ctx.region ?? entry.region,
                }
              : { coords: known, city: rev.city, citycode: rev.citycode, arrondissement, ...ctx };
          }
        } catch {
          /* reverse failed — keep the forward-search entry */
        }
      }

      cache.set(name, entry);
      await persist();
      return entry;
    } catch {
      return null; // transient — retry on a later warm pass
    }
  });
}

/** Coordinates only (back-compat helper). */
export async function geocode(name: string): Promise<Coords | null> {
  return (await resolve(name))?.coords ?? null;
}
