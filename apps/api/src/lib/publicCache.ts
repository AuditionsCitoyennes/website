import { invalidate } from "./cache";

// Cache keys for the public read endpoints. A change to auditions or testimonies
// can move all three (the map groups and the auditions list both carry testimony
// counts), so mutations invalidate the whole set.
export const PUBLIC_CACHE_KEYS = {
  testimonies: "testimonies:public",
  auditions: "auditions:published",
  map: "map:groups",
} as const;

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
  invalidate(...Object.values(PUBLIC_CACHE_KEYS));
}
