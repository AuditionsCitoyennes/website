import { CacheFamily } from "./cache";
import { TooLongError } from "./guards";

// The caches of the public reads, one family each (lib/cache.ts), within one
// memory budget (design A19, D3): 74 MB of Buffers in all — 64 MB of answers
// and 10 MB of responses assembled from them — beside the 256 MB heap (which
// holds the boundaries' LRU) in a 512 MB container. Every family can be full
// at once (entries leave by LRU, a delete or a write, never by age alone),
// so the budgets below add up to the 74 MB. A change to auditions or
// testimonies can move any of them (the map groups, the auditions list and
// every place count carry testimony counts), so a write invalidates them all.

const MB = 1024 * 1024;
const MINUTE = 60_000;

/**
 * The place counts (map phase 1), per unit, and the filter dialog's facets:
 * answers read from the database. A unit's is at most 2 MB of JSON
 * (modules/places/read.ts) plus its gzip, within the default entry limit
 * (a quarter of the family). Nothing assembled from them is kept here
 * (assembledCache): an assembly, cheap to make again, never evicts an
 * answer that costs a database call.
 */
export const placesCache = new CacheFamily({ name: "places", maxBytes: 18 * MB, ttlMs: MINUTE });
/**
 * Responses assembled from cached answers, under their ETag (the hash of
 * their parts' tags, so a key always names the same bytes): a units= batch
 * of place counts, an answer with "textIgnored" (modules/places/readRoutes.ts).
 * Their own family, so that however many there are they only evict one
 * another. An entry may take 6 MB: a batch is at most 4 MB of JSON
 * (BATCH_MAX_BYTES) plus its gzip — kept, not built again per request. The
 * TTL only bounds how long an unused one stays (the LRU and a write drop it
 * sooner).
 */
export const assembledCache = new CacheFamily({
  name: "assembled",
  maxBytes: 10 * MB,
  maxEntryBytes: 6 * MB,
  ttlMs: 10 * MINUTE,
});
// A lieu's answer may be as heavy as a read brings back (lib/supabase.ts,
// 2 MB of JSON, plus its gzip): kept, not read again per request.
export const lieuCache = new CacheFamily({
  name: "lieu",
  maxBytes: 6 * MB,
  maxEntryBytes: 3 * MB,
  ttlMs: MINUTE,
});
export const resultsCache = new CacheFamily({ name: "results", maxBytes: 8 * MB, ttlMs: MINUTE });
export const tpageCache = new CacheFamily({ name: "tpage", maxBytes: 8 * MB, ttlMs: MINUTE });

/** One published audition's detail (/api/auditions/:id), by id. */
export const auditionCache = new CacheFamily({
  name: "audition",
  maxBytes: 4 * MB,
  ttlMs: MINUTE,
});

/**
 * The whole-table reads (/api/auditions, /api/map, /api/testimonies), under
 * their keys below. Not the design's 4 MB: the production corpus already
 * weighs about 6.3 MB of JSON and gzip (4.75 MB + 1.5 MB), and an uncached
 * corpus is a whole-table pull per page view. An entry may take 16 MB, and
 * the family holds it beside the auditions list at its guard (5,000
 * auditions, about 4 MB) and the map. A value heavier than 16 MB is refused
 * (503 "Liste trop longue"), remembered for its TTL: never pulled per
 * request. So is a table past its guard's count (lib/guards.ts): one count
 * per TTL, not one per request, and the value held before is not served
 * past the refusal.
 */
export const legacyCache = new CacheFamily({
  name: "legacy",
  maxBytes: 20 * MB,
  maxEntryBytes: 16 * MB,
  ttlMs: MINUTE,
  refuseOversize: (key, bytes) => new TooLongError(key, bytes),
  remembers: (err) => err instanceof TooLongError,
});

/** Every public family: what a write invalidates. */
export const PUBLIC_FAMILIES = [
  placesCache,
  assembledCache,
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
