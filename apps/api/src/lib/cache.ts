// In-memory TTL cache with single-flight, fronting the public read endpoints.
//
// The public site re-pulls the same Supabase data on every page view (and, for
// the map, every 2.5s poll). Without a cache that meant the full testimony
// corpus (~1-3 MB) and the published-auditions list flowed out of Supabase on
// each request — tens of GB of egress per day for a corpus that barely changes.
//
// `cached()` serves a value for `ttlMs`, and collapses concurrent misses into a
// single upstream call (single-flight) so a burst of map polls hitting a cold
// key issues one Supabase query, not one per request. Mutations call
// `invalidate()` so admin changes surface on the public site without waiting out
// the TTL.

interface Entry<T> {
  value: T;
  expires: number;
}

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expires > Date.now()) return hit.value;

  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const promise = (async () => {
    try {
      const value = await fn();
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/** Drop cached entries so the next read recomputes them (after a mutation). */
export function invalidate(...keys: string[]): void {
  for (const key of keys) store.delete(key);
}
