import { CacheFamily } from "./cache";

// The caches of the public reads, one family each (lib/cache.ts), within one
// memory budget (design A19, D3): 60 MB of Buffers for the place reads and
// the audition detail, 16 MB for the whole-table reads (full only when the
// others are empty, see legacyCache), beside the 256 MB heap, the
// boundaries' 32 MB and the gazetteer's 16 MB, in a 512 MB container. A
// change to auditions or testimonies can move any of them (the map groups,
// the auditions list and every place count carry testimony counts), so a
// write invalidates them all.

const MB = 1024 * 1024;
const MINUTE = 60_000;

/** The place reads (map phase 1): per unit, per lieu, the results' and testimonies' first pages. */
export const placesCache = new CacheFamily({ name: "places", maxBytes: 24 * MB, ttlMs: MINUTE });
export const lieuCache = new CacheFamily({ name: "lieu", maxBytes: 6 * MB, ttlMs: MINUTE });
export const resultsCache = new CacheFamily({ name: "results", maxBytes: 12 * MB, ttlMs: MINUTE });
export const tpageCache = new CacheFamily({ name: "tpage", maxBytes: 12 * MB, ttlMs: MINUTE });

/** One published audition's detail (/api/auditions/:id), by id. */
export const auditionCache = new CacheFamily({
  name: "audition",
  maxBytes: 6 * MB,
  ttlMs: MINUTE,
});

/**
 * The whole-table reads (/api/auditions, /api/map, /api/testimonies), under
 * their keys below. Four keys; an entry may take the whole family, so that
 * the corpus stays cached (a 4,813-testimony seed weighs 6.5 MB of JSON and
 * gzip; an uncached corpus is a whole-table pull per page view). Its 16 MB
 * come on top of the others' 60, but the two are never full
 * together: at the size that fills those, the guards (lib/guards.ts) refuse
 * these tables and nothing is kept here. Past 16 MB, served uncached.
 */
export const legacyCache = new CacheFamily({
  name: "legacy",
  maxBytes: 16 * MB,
  maxEntryBytes: 16 * MB,
  ttlMs: MINUTE,
});

/** Every public family: what a write invalidates. */
export const PUBLIC_FAMILIES = [
  placesCache,
  lieuCache,
  resultsCache,
  tpageCache,
  auditionCache,
  legacyCache,
] as const;

// Keys of the legacy family.
export const PUBLIC_CACHE_KEYS = {
  testimonies: "testimonies:public",
  auditions: "auditions:published",
  map: "map:groups",
  // The geocoder's build of the map, beside the stored places' (testing
  // tools: /api/map?source=geocoder).
  mapGeocoder: "map:groups:geocoder",
} as const;

/** How long each is served as is before a refill (behind the reply, see lib/cache.ts). */
export const PUBLIC_CACHE_TTL_MS = {
  testimonies: 60_000,
  auditions: 60_000,
  // Short: a newly placed lieu must surface within a poll or two.
  map: 15_000,
} as const;

/** The cache key of one audition's public detail (auditionCache). */
export function auditionCacheKey(id: string): string {
  return `audition:${id}`;
}

// Counts the writes: whoever decided "nothing left to do" on the data of one
// generation (the geocode warm pass) knows to look again on the next.
let publicGeneration = 0;

/** How many times the public caches have been invalidated (i.e. written under). */
export function publicCachesGeneration(): number {
  return publicGeneration;
}

/** Invalidate every public read cache — call after any audition/testimony write. */
export function invalidatePublicCaches(): void {
  publicGeneration++;
  for (const family of PUBLIC_FAMILIES) family.invalidate();
}
