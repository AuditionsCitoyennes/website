import { invalidate } from "./cache";

// Cache keys for the public read endpoints. A change to auditions or testimonies
// can move all three (the map groups and the auditions list both carry testimony
// counts), so mutations invalidate the whole set.
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

// One published audition's detail, by id. Bounded: a scan of random ids must
// not grow the store without end — past PER_ID_MAX the oldest key goes.
const PER_ID_MAX = 500;
const perIdKeys = new Set<string>();

/** The cache key of one audition's public detail; dropped with the rest on any write. */
export function auditionCacheKey(id: string): string {
  const key = `audition:${id}`;
  if (!perIdKeys.has(key)) {
    perIdKeys.add(key);
    if (perIdKeys.size > PER_ID_MAX) {
      const oldest = perIdKeys.values().next().value as string;
      perIdKeys.delete(oldest);
      invalidate(oldest);
    }
  }
  return key;
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
  invalidate(...Object.values(PUBLIC_CACHE_KEYS), ...perIdKeys);
  perIdKeys.clear();
}
