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
//
// `cachedResponse()` goes one step further for the routes that send a cached
// value as it is: the bytes. Serialising the testimony corpus (4.75 MB of
// JSON) and gzipping it cost ~80 ms of CPU on EVERY request although the value
// had not changed; built once per fill and kept with the value, a warm hit is
// a buffer write. The ETag built with them lets a browser ask "still this?"
// and be told so in a bodiless 304 instead of downloading 1.5 MB again (see
// lib/httpCache.ts).

import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);

/** A cached value as HTTP sends it, built once per fill. */
export interface CachedResponse {
  /** The JSON body, UTF-8. */
  json: Buffer;
  /** The same body gzipped, for the clients that accept it (every browser). */
  gz: Buffer;
  /**
   * Validator of the JSON bytes. A refill that yields the same bytes keeps the
   * tag, so a client's copy stays good for as long as the data does.
   */
  etag: string;
}

interface Entry<T> {
  value: T;
  expires: number;
  /** `value` as HTTP sends it, built by the first cachedResponse() on this fill. */
  response?: Promise<CachedResponse>;
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

/**
 * The value under `key` (filled by `fn`, as with `cached()`) as HTTP sends it:
 * serialised and gzipped once per fill, with its ETag. It shares the entry
 * with `cached()`: a reader of the value and a route sending it fill once,
 * and `invalidate()` drops both.
 */
export async function cachedResponse(
  key: string,
  ttlMs: number,
  fn: () => Promise<unknown>,
): Promise<CachedResponse> {
  const value = await cached(key, ttlMs, fn);
  const entry = store.get(key);
  // Invalidated while the value was awaited: the next fill will have its own
  // bytes, these are built for this reply alone.
  if (!entry || entry.value !== value) return buildResponse(value);
  if (!entry.response) {
    entry.response = buildResponse(value).catch((e: unknown) => {
      entry.response = undefined;
      throw e;
    });
  }
  return entry.response;
}

async function buildResponse(value: unknown): Promise<CachedResponse> {
  const json = Buffer.from(JSON.stringify(value));
  // zlib's threadpool, never gzipSync: the corpus takes ~60 ms to compress,
  // which must not stall every other request. Gzip only — brotli at its
  // default quality takes seconds on a body this size.
  const gz = await gzipAsync(json);
  // The hash of the bytes, not of the fill: a refill that yields the same JSON
  // keeps the tag, and with it every client's copy.
  const etag = `"${createHash("sha1").update(json).digest("base64url")}"`;
  return { json, gz, etag };
}

/** Drop cached entries so the next read recomputes them (after a mutation). */
export function invalidate(...keys: string[]): void {
  for (const key of keys) store.delete(key);
}
