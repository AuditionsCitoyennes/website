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
  /** Its bytes (JSON + gzip), once built. */
  bytes?: number;
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
    entry.response = buildResponse(value).then(
      (res) => {
        entry.bytes = res.json.length + res.gz.length;
        return res;
      },
      (e: unknown) => {
        entry.response = undefined;
        throw e;
      },
    );
  }
  return entry.response;
}

/** `value` as HTTP sends it: JSON, gzipped, tagged. */
export async function buildResponse(value: unknown): Promise<CachedResponse> {
  const json = Buffer.from(JSON.stringify(value ?? null));
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

/** The bytes the store above holds (boundary levels and départements), for /api/health. */
export function storeStats(): { entries: number; bytes: number } {
  let bytes = 0;
  for (const entry of store.values()) bytes += entry.bytes ?? 0;
  return { entries: store.size, bytes };
}

// ---- Families -------------------------------------------------------------------
//
// A CacheFamily is a store of its own for one kind of answer (map phase 1:
// the place reads, an audition's detail, the whole-table endpoints), bounded
// in BYTES rather than keys: what it holds are Buffers outside the V8 heap,
// which --max-old-space-size does not cap. Each entry keeps its value as
// HTTP sends it (JSON, gzip, ETag, built once per fill) and weighs
// json + gz; past the family's budget the least recently used entries go,
// and a value heavier than an entry may be (a quarter of the budget by
// default) is served to its caller but never kept.
//
// The rules of the store above hold per family: single flight per key, a
// value past its TTL served stale while one refill runs behind the reply
// (backing off when it fails), and a write that wins over a fill in flight.
// Writes invalidate a whole family at once: invalidate() bumps its one
// generation counter, and a fill started under an older generation is not
// kept. delete() drops a few keys of a family (the map's two builds).
//
// Batched reads (/api/places?units=…) fill many keys in one upstream call:
// getMany() groups the misses into chunks, one call each, and every key of a
// chunk is single-flighted on that call.

export type CacheState = "hit" | "stale" | "miss";

export interface CacheFamilyOptions {
  name: string;
  /** Budget of the family's Buffers (JSON + gzip of every entry). */
  maxBytes: number;
  /** How long a value is served as is (a get may pass its own). */
  ttlMs: number;
  /** How long past its TTL a value is still served while it is refilled. */
  staleForMs?: number;
  /** The heaviest entry kept; heavier ones are served uncached. Default: a quarter of maxBytes. */
  maxEntryBytes?: number;
}

export interface FamilyHit {
  res: CachedResponse;
  state: CacheState;
  /** The value, when the fill was this call's or the entry keeps it. */
  value?: unknown;
}

export interface FamilyGetOptions {
  ttlMs?: number;
  /** Keys per upstream call (getMany): default 1. */
  chunk?: number;
  /**
   * Called once, before any upstream call this get starts, with how many it
   * is about to make (misses only, not refills behind a stale reply). Throws
   * to refuse them all (a rate limit): nothing is fetched.
   */
  beforeFill?: (calls: number) => void;
  /**
   * Whether an error leaves an entry still held usable: a timeout, a full
   * gate. Then the last value of this generation is served (as stale) rather
   * than the error, however old.
   */
  transient?: (err: unknown) => boolean;
  /** Keep the value on the entry (value() reads it without parsing the JSON again). */
  keepValue?: boolean;
}

export interface CacheFamilyStats {
  name: string;
  entries: number;
  bytes: number;
  maxBytes: number;
  generation: number;
  hits: number;
  stale: number;
  misses: number;
  /** Values served but not kept: heavier than an entry may be. */
  oversize: number;
  evictions: number;
}

interface FamilyEntry {
  res: CachedResponse;
  value?: unknown;
  bytes: number;
  fresh: number;
  stale: number;
  retryAt?: number;
  backoff?: number;
}

interface Filled {
  res: CachedResponse;
  value: unknown;
}

const families: CacheFamily[] = [];
const OVERSIZE_LOG_EVERY_MS = 10 * 60_000;
// What an entry costs beyond its bytes (its key, the entry and response
// objects, two Buffer headers), counted with them: a scan of random keys
// (unknown audition ids, a few bytes each) must not hold thousands of
// entries for nothing.
const ENTRY_OVERHEAD = 256;

/** Every family created, for the health report and invalidatePublicCaches(). */
export function cacheFamilies(): readonly CacheFamily[] {
  return families;
}

export class CacheFamily {
  readonly name: string;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
  private readonly ttlMs: number;
  private readonly staleForMs: number;
  // Insertion order is recency: a hit moves its key to the end, eviction
  // takes from the front.
  private readonly entries = new Map<string, FamilyEntry>();
  private readonly inflight = new Map<string, Promise<Filled>>();
  // Per key deleted since the last invalidate(): a fill reads it before and after.
  private readonly epochs = new Map<string, number>();
  private generation = 0;
  private bytes = 0;
  private counts = { hits: 0, stale: 0, misses: 0, oversize: 0, evictions: 0 };
  private oversizeLoggedAt = 0;

  constructor(opts: CacheFamilyOptions) {
    this.name = opts.name;
    this.maxBytes = opts.maxBytes;
    this.ttlMs = opts.ttlMs;
    this.staleForMs = opts.staleForMs ?? STALE_FOR_MS;
    this.maxEntryBytes = opts.maxEntryBytes ?? Math.floor(opts.maxBytes / 4);
    families.push(this);
  }

  /** The value under `key` as HTTP sends it, filled by `fn` on a miss. */
  async get(
    key: string,
    fn: () => Promise<unknown>,
    opts: FamilyGetOptions = {},
  ): Promise<FamilyHit> {
    const [hit] = await this.getMany([key], async () => [await fn()], { ...opts, chunk: 1 });
    return hit;
  }

  /** The response alone. */
  async response(
    key: string,
    fn: () => Promise<unknown>,
    opts: FamilyGetOptions = {},
  ): Promise<CachedResponse> {
    return (await this.get(key, fn, opts)).res;
  }

  /**
   * The value under `key` (as cached() gives it), kept on the entry from
   * then on; parsed back from the entry's JSON when the fill did not keep it.
   */
  async value<T>(key: string, fn: () => Promise<T>, opts: FamilyGetOptions = {}): Promise<T> {
    const hit = await this.get(key, fn, { ...opts, keepValue: true });
    if (hit.value !== undefined) return hit.value as T;
    const value = JSON.parse(hit.res.json.toString("utf8")) as T;
    const entry = this.entries.get(key);
    if (entry && entry.res === hit.res) entry.value = value;
    return value;
  }

  /**
   * Many keys at once, in their order. Fresh and stale entries are served
   * from memory (a stale one refilled behind the reply); keys being filled
   * wait for that fill; the rest are fetched by `fetchMany`, `chunk` keys a
   * call, which must answer one value per key in the order given.
   */
  getMany(
    keys: readonly string[],
    fetchMany: (keys: string[]) => Promise<unknown[]>,
    opts: FamilyGetOptions = {},
  ): Promise<FamilyHit[]> {
    const now = Date.now();
    const ttlMs = opts.ttlMs ?? this.ttlMs;
    const chunk = Math.max(1, opts.chunk ?? 1);
    const out: (FamilyHit | Promise<FamilyHit> | undefined)[] = [];
    const missing: { key: string; at: number[] }[] = [];
    const missingAt = new Map<string, number[]>();
    const refills = new Set<string>();

    for (const key of keys) {
      const again = missingAt.get(key);
      if (again) {
        again.push(out.length);
        out.push(undefined);
        continue;
      }
      const entry = this.entries.get(key);
      if (entry && entry.fresh > now) {
        this.touch(key, entry);
        this.counts.hits++;
        out.push({ res: entry.res, state: "hit", value: entry.value });
        continue;
      }
      if (entry && entry.stale > now) {
        this.touch(key, entry);
        this.counts.stale++;
        out.push({ res: entry.res, state: "stale", value: entry.value });
        const backingOff = entry.retryAt !== undefined && entry.retryAt > now;
        if (!this.inflight.has(key) && !backingOff) refills.add(key);
        continue;
      }
      this.counts.misses++;
      const pending = this.inflight.get(key);
      if (pending) {
        out.push(this.served(key, pending, opts));
        continue;
      }
      const at = [out.length];
      missing.push({ key, at });
      missingAt.set(key, at);
      out.push(undefined);
    }

    const calls = Math.ceil(missing.length / chunk);
    if (calls > 0 && opts.beforeFill) {
      try {
        opts.beforeFill(calls);
      } catch (e) {
        return Promise.reject(e);
      }
    }
    for (let i = 0; i < missing.length; i += chunk) {
      const part = missing.slice(i, i + chunk);
      const fills = this.fill(
        part.map((m) => m.key),
        fetchMany,
        ttlMs,
        opts.keepValue ?? false,
      );
      part.forEach((m, j) => {
        const served = this.served(m.key, fills[j], opts);
        for (const at of m.at) out[at] = served;
      });
    }
    const stale = [...refills];
    for (let i = 0; i < stale.length; i += chunk) {
      this.refill(stale.slice(i, i + chunk), fetchMany, ttlMs);
    }
    return Promise.all(out as (FamilyHit | Promise<FamilyHit>)[]);
  }

  /** Drop every entry and every fill in flight: the next reads fill again (a write). */
  invalidate(): void {
    this.generation++;
    this.entries.clear();
    this.inflight.clear();
    this.epochs.clear();
    this.bytes = 0;
  }

  /** Drop these keys alone, and their fills in flight. */
  delete(...keys: string[]): void {
    for (const key of keys) {
      this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
      const entry = this.entries.get(key);
      if (entry) {
        this.bytes -= entry.bytes;
        this.entries.delete(key);
      }
      this.inflight.delete(key);
    }
  }

  stats(): CacheFamilyStats {
    return {
      name: this.name,
      entries: this.entries.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      generation: this.generation,
      ...this.counts,
    };
  }

  /** A fill's outcome for one caller: on a transient error, the entry still held. */
  private async served(
    key: string,
    pending: Promise<Filled>,
    opts: FamilyGetOptions,
  ): Promise<FamilyHit> {
    try {
      const { res, value } = await pending;
      return { res, value, state: "miss" };
    } catch (err) {
      const held = this.entries.get(key);
      if (held && opts.transient?.(err)) {
        return { res: held.res, value: held.value, state: "stale" };
      }
      throw err;
    }
  }

  /** One upstream call for `keys`: a promise per key, each single-flighted. */
  private fill(
    keys: string[],
    fetchMany: (keys: string[]) => Promise<unknown[]>,
    ttlMs: number,
    keepValue: boolean,
  ): Promise<Filled>[] {
    const generation = this.generation;
    const epochs = keys.map((k) => this.epochs.get(k) ?? 0);
    const batch = fetchMany(keys).then((values) => {
      if (!Array.isArray(values) || values.length !== keys.length) {
        throw new Error(`cache ${this.name}: ${keys.length} values expected`);
      }
      return values;
    });
    return keys.map((key, i) => {
      const promise = batch.then(async (values) => {
        const value = values[i];
        const res = await buildResponse(value);
        // A write landed meanwhile (the family, or this key): the value may
        // predate it. Not kept; this caller still gets it.
        if (this.generation === generation && (this.epochs.get(key) ?? 0) === epochs[i]) {
          this.put(key, res, keepValue ? value : undefined, ttlMs);
        }
        return { res, value };
      });
      this.inflight.set(key, promise);
      // Its own slot only: invalidate() may have dropped it, and a newer
      // fill may hold the key by the time this one settles.
      const done = () => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      };
      promise.then(done, done);
      return promise;
    });
  }

  /** Refills behind stale replies: a failure keeps the entries and backs them off. */
  private refill(
    keys: string[],
    fetchMany: (keys: string[]) => Promise<unknown[]>,
    ttlMs: number,
  ): void {
    // An entry whose value was kept keeps it across its refill.
    const keepValue = keys.some((k) => this.entries.get(k)?.value !== undefined);
    const fills = this.fill(keys, fetchMany, ttlMs, keepValue);
    fills.forEach((p, i) => {
      p.catch((err: unknown) => {
        const entry = this.entries.get(keys[i]);
        if (!entry) return;
        const first = entry.backoff === undefined;
        entry.backoff = first ? BACKOFF_MIN_MS : Math.min(BACKOFF_MAX_MS, entry.backoff! * 2);
        entry.retryAt = Date.now() + entry.backoff;
        if (first) {
          log.warn(
            { family: this.name, key: keys[i], err },
            "cache: refill failed, serving the last good value",
          );
        }
      });
    });
  }

  private put(key: string, res: CachedResponse, value: unknown, ttlMs: number): void {
    const old = this.entries.get(key);
    if (old) {
      this.bytes -= old.bytes;
      this.entries.delete(key);
    }
    const bytes = res.json.length + res.gz.length + key.length + ENTRY_OVERHEAD;
    if (bytes > this.maxEntryBytes) {
      this.counts.oversize++;
      // Said once in a while: served uncached, the value is read upstream again per request.
      const now = Date.now();
      if (now - this.oversizeLoggedAt > OVERSIZE_LOG_EVERY_MS) {
        this.oversizeLoggedAt = now;
        log.warn(
          { family: this.name, key, bytes, maxEntryBytes: this.maxEntryBytes },
          "cache: value over the entry limit, served uncached",
        );
      }
      return;
    }
    const now = Date.now();
    this.entries.set(key, {
      res,
      value,
      bytes,
      fresh: now + ttlMs,
      stale: now + ttlMs + this.staleForMs,
    });
    this.bytes += bytes;
    for (const [k, e] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(k);
      this.bytes -= e.bytes;
      this.counts.evictions++;
    }
  }

  private touch(key: string, entry: FamilyEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
}

/** A strong ETag over a few others (a response assembled from cached parts). */
export function combinedEtag(parts: readonly string[]): string {
  return `"${createHash("sha1").update(parts.join("\n")).digest("base64url")}"`;
}
