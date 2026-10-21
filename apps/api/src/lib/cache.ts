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
// Three rules keep it honest:
// - A write wins over a read in flight. `invalidate()` bumps the key's epoch,
//   and a fill that started before it is not stored (its value may predate
//   the write); it also drops the in-flight promise, so the next reader
//   starts a fill of its own instead of waiting on the old one.
// - Past its TTL a value is served stale while ONE refill runs behind the
//   reply (stale-while-revalidate), for STALE_FOR_MS; after that it is a miss.
//   The unlucky visitor after each TTL no longer pays the 1.65 s refill of the
//   corpus. When the refill fails, the last good value keeps being served and
//   the next try waits a backoff (5 s, doubling to 60 s), logged once per
//   outage: a Supabase hiccup is not a 500 on every poll while a good copy is
//   in memory.
// - `invalidate()` is a hard delete, never stale: a write must surface at the
//   next read (the admin UI and the geocode warm pass rely on it).
//
// `cachedResponse()` goes one step further for the routes that send a cached
// value as it is: the bytes. Serialising the testimony corpus (4.75 MB of
// JSON) and gzipping it cost ~80 ms of CPU on EVERY request although the value
// had not changed; built once per fill and kept with the value, a warm hit is
// a buffer write. The ETag built with them lets a browser ask "still this?"
// and be told so in a bodiless 304 instead of downloading 1.5 MB again (see
// lib/httpCache.ts). The bytes live on the entry, so they follow the three
// rules above: filled under the same epoch, served stale with the value,
// dropped by the same invalidate().

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
  /** Served as is until then. */
  fresh: number;
  /** After `fresh`, still served while a refill runs behind the reply — until then. */
  stale: number;
  /** After a failed refill: the next try not before, and how long the one after it waits. */
  retryAt?: number;
  backoff?: number;
  /** `value` as HTTP sends it, built by the first cachedResponse() on this fill. */
  response?: Promise<CachedResponse>;
}

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
// Per key, how many times invalidate() ran: a fill reads it before and after.
const epochs = new Map<string, number>();

/** How long a value is still served past its TTL while it is being refilled. */
const STALE_FOR_MS = 5 * 60_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

interface CacheLogger {
  warn(obj: object, msg: string): void;
}
let log: CacheLogger = { warn: (obj, msg) => console.warn(msg, obj) };

/** Route the cache's warnings (a refill that failed) through the app's logger. */
export function setCacheLogger(logger: CacheLogger): void {
  log = logger;
}

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.fresh > now) return hit.value;
  if (hit && hit.stale > now) {
    // Stale: served at once, and one refill behind the reply — unless one is
    // already running, or the last one failed too recently.
    if (!inflight.has(key) && !(hit.retryAt !== undefined && hit.retryAt > now)) {
      void refill(key, ttlMs, fn, hit);
    }
    return hit.value;
  }
  return fill(key, ttlMs, fn);
}

/**
 * The value under `key` (filled by `fn`, as with `cached()`) as HTTP sends it:
 * serialised and gzipped once per fill, with its ETag. It shares the entry
 * with `cached()`: a reader of the value and a route sending it fill once,
 * a stale entry serves its bytes while the refill runs, and `invalidate()`
 * drops both.
 */
export async function cachedResponse(
  key: string,
  ttlMs: number,
  fn: () => Promise<unknown>,
): Promise<CachedResponse> {
  const value = await cached(key, ttlMs, fn);
  const entry = store.get(key);
  // Not stored (a write landed during the fill) or invalidated while the
  // value was awaited: the next fill will have its own bytes, these are built
  // for this reply alone.
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

/** One fill per key at a time; stored only if nothing invalidated the key meanwhile. */
function fill<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const epoch = epochs.get(key) ?? 0;
  const promise = (async () => {
    const value = await fn();
    // A write landed while this ran: the value may predate it. Not stored —
    // the next read starts a fill of its own. (This caller still gets it.)
    if ((epochs.get(key) ?? 0) === epoch) {
      const now = Date.now();
      store.set(key, { value, fresh: now + ttlMs, stale: now + ttlMs + STALE_FOR_MS });
    }
    return value;
  })();
  inflight.set(key, promise);
  // Its own slot only: invalidate() may have dropped it, and a newer fill may
  // hold the key by the time this one settles.
  const done = () => {
    if (inflight.get(key) === promise) inflight.delete(key);
  };
  promise.then(done, done);
  return promise;
}

/**
 * A refill behind a stale reply. A failure keeps the last good value in
 * place and backs the next try off, doubling up to BACKOFF_MAX_MS; logged
 * once per outage (a refill that succeeds replaces the entry, backoff and all).
 */
async function refill<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  entry: Entry<T>,
): Promise<void> {
  try {
    await fill(key, ttlMs, fn);
  } catch (err) {
    const first = entry.backoff === undefined;
    const backoff = first ? BACKOFF_MIN_MS : Math.min(BACKOFF_MAX_MS, entry.backoff! * 2);
    entry.backoff = backoff;
    entry.retryAt = Date.now() + backoff;
    if (first) log.warn({ key, err }, "cache: refill failed, serving the last good value");
  }
}

/**
 * Drop cached entries so the next read recomputes them (after a mutation). A
 * hard delete: nothing stale is served past a write, and a fill in flight
 * across it is neither waited on nor stored.
 */
export function invalidate(...keys: string[]): void {
  for (const key of keys) {
    epochs.set(key, (epochs.get(key) ?? 0) + 1);
    store.delete(key);
    inflight.delete(key);
  }
}
