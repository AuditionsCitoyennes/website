// The public read endpoints' caches, the bytes they send, and the logger they
// warn through.
//
// The public site re-pulls the same Supabase data on every page view (and, for
// the map, every 2.5s poll). Without a cache that meant the full testimony
// corpus (~1-3 MB) and the published-auditions list flowed out of Supabase on
// each request — tens of GB of egress per day for a corpus that barely changes.
//
// A cached value is sent as HTTP sends it: the bytes. Serialising the
// testimony corpus (4.75 MB of JSON) and gzipping it cost ~80 ms of CPU on
// EVERY request although the value had not changed; built once per fill and
// kept with the value, a warm hit is a buffer write. The ETag built with them
// lets a browser ask "still this?" and be told so in a bodiless 304 instead of
// downloading 1.5 MB again (see lib/httpCache.ts). The stores are the
// families below (CacheFamily).

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

/** `value` as HTTP sends it: JSON, gzipped, tagged. */
export async function buildResponse(value: unknown): Promise<CachedResponse> {
  return responseOf(Buffer.from(JSON.stringify(value ?? null)));
}

/** JSON bytes as HTTP sends them: gzipped, tagged (by default, with the hash of the bytes). */
export async function responseOf(json: Buffer, etag?: string): Promise<CachedResponse> {
  // zlib's threadpool, never gzipSync: the corpus takes ~60 ms to compress,
  // which must not stall every other request. Gzip only — brotli at its
  // default quality takes seconds on a body this size.
  const gz = await gzipAsync(json);
  // The hash of the bytes, not of the fill: a refill that yields the same JSON
  // keeps the tag, and with it every client's copy.
  return { json, gz, etag: etag ?? `"${createHash("sha1").update(json).digest("base64url")}"` };
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
// default) is served to its caller but never kept — or, in a family that
// refuses them (the whole-table reads), refused for its TTL: never read
// upstream on every request.
//
// Three rules hold per family: single flight per key, a value past its TTL
// served stale while one refill runs behind the reply for STALE_FOR_MS
// (backing off when it fails: 5 s, doubling to 60 s, logged once per
// outage), and a write that wins over a fill in flight.
// When the database is in distress (a timeout, a full gate), an entry past
// its stale window still answers for one more window (`holdForMs`), as
// stale; after that it is dropped, and the error is the answer.
// Writes invalidate a whole family at once: invalidate() bumps its one
// generation counter, and a fill started under an older generation is not
// kept. delete() drops a few keys of a family (the map's two builds).
//
// Batched reads (/api/places?units=…) fill many keys in one upstream call:
// getMany() groups the misses into chunks, one call each, and every key of a
// chunk is single-flighted on that call. A call may answer a key's own
// failure (KeyFailure) in place of its value: that key fails, the others of
// the chunk are kept. A fill may also answer a response it built itself
// (Prebuilt: the bytes of an assembled batch), kept as is.
//
// Errors a family remembers (`remembers`: the whole-table guards' "too
// long") are refused like an oversize value: for the key's TTL, to every
// caller, without reading upstream again; the value the key held is no
// longer served.

export type CacheState = "hit" | "stale" | "miss";

export interface CacheFamilyOptions {
  name: string;
  /** Budget of the family's Buffers (JSON + gzip of every entry). */
  maxBytes: number;
  /** How long a value is served as is (a get may pass its own). */
  ttlMs: number;
  /** How long past its TTL a value is still served while it is refilled. */
  staleForMs?: number;
  /**
   * How long past its stale window a value still answers a transient error
   * (a timeout, a full gate) instead of that error. Default: staleForMs.
   */
  holdForMs?: number;
  /** The heaviest entry kept; heavier ones are served uncached. Default: a quarter of maxBytes. */
  maxEntryBytes?: number;
  /**
   * Refuse a value heavier than an entry may be instead of serving it
   * uncached: the error its caller gets, and every caller of that key until
   * the TTL ends (or a write), without reading it upstream again.
   */
  refuseOversize?: (key: string, bytes: number) => Error;
  /**
   * Errors of a fill remembered the same way: every caller of the key gets
   * the error until the TTL ends (or a write), and what the key held is
   * dropped — never served past it.
   */
  remembers?: (err: unknown) => boolean;
}

/** How a getMany's upstream call is made. */
export interface FetchInfo {
  /** A refill behind stale replies (no caller waits on it, nor was charged for it). */
  refill: boolean;
}

/** Fetches `keys`: one value per key, in their order. */
export type FetchMany = (keys: string[], info: FetchInfo) => Promise<unknown[]>;

/** A key's own failure, answered by a fetchMany in place of its value (the rest of the chunk is kept). */
export class KeyFailure {
  constructor(readonly error: unknown) {}
}

/** A fill's answer already as HTTP sends it: kept as is (no JSON or gzip built again). */
export class Prebuilt {
  constructor(readonly res: CachedResponse) {}
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
   * than the error, for `holdForMs` past its stale window.
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
  /** Values served (or refused) but not kept: heavier than an entry may be. */
  oversize: number;
  evictions: number;
  /** Upstream calls started (one per chunk of misses, one per refill). */
  fills: number;
}

interface FamilyEntry {
  res: CachedResponse;
  value?: unknown;
  bytes: number;
  fresh: number;
  stale: number;
  /** Until then it may answer a transient error; past it, dropped. */
  held: number;
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
  private readonly holdForMs: number;
  private readonly refuseOversize?: (key: string, bytes: number) => Error;
  private readonly remembers?: (err: unknown) => boolean;
  // Insertion order is recency: a hit moves its key to the end, eviction
  // takes from the front.
  private readonly entries = new Map<string, FamilyEntry>();
  private readonly inflight = new Map<string, Promise<Filled>>();
  // Keys whose value was too heavy (refuseOversize), or whose fill failed
  // with an error the family remembers, until their TTL ends.
  private readonly refusals = new Map<string, { until: number; error: Error }>();
  // Per key deleted since the last invalidate(): a fill reads it before and after.
  private readonly epochs = new Map<string, number>();
  private generation = 0;
  private bytes = 0;
  private counts = { hits: 0, stale: 0, misses: 0, oversize: 0, evictions: 0, fills: 0 };
  private oversizeLoggedAt = 0;

  constructor(opts: CacheFamilyOptions) {
    this.name = opts.name;
    this.maxBytes = opts.maxBytes;
    this.ttlMs = opts.ttlMs;
    this.staleForMs = opts.staleForMs ?? STALE_FOR_MS;
    this.holdForMs = opts.holdForMs ?? this.staleForMs;
    this.refuseOversize = opts.refuseOversize;
    this.remembers = opts.remembers;
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
   * The value under `key` itself, kept on the entry from
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
   * call, which must answer one value per key in the order given (or a
   * KeyFailure for a key that failed alone).
   */
  getMany(
    keys: readonly string[],
    fetchMany: FetchMany,
    opts: FamilyGetOptions = {},
  ): Promise<FamilyHit[]> {
    const now = Date.now();
    const ttlMs = opts.ttlMs ?? this.ttlMs;
    const chunk = Math.max(1, opts.chunk ?? 1);
    // Every key is sorted first and the calls charged, before any promise
    // is made: a refused batch must leave nothing behind (a key joined on
    // another request's fill, abandoned, would reject unhandled when that
    // fill fails — and take the process down).
    const out: (FamilyHit | Promise<FamilyHit> | undefined)[] = new Array(keys.length);
    const joins: { at: number; key: string; pending: Promise<Filled> }[] = [];
    const missing: { key: string; at: number[] }[] = [];
    const missingAt = new Map<string, number[]>();
    const refills = new Set<string>();

    for (const [at, key] of keys.entries()) {
      const again = missingAt.get(key);
      if (again) {
        again.push(at);
        continue;
      }
      const refusal = this.refusals.get(key);
      if (refusal) {
        if (refusal.until > now) return Promise.reject(refusal.error);
        this.refusals.delete(key);
      }
      let entry = this.entries.get(key);
      if (entry && entry.held <= now) {
        // Past every window: of no use any more, its bytes go back.
        this.drop(key, entry);
        entry = undefined;
      }
      if (entry && entry.fresh > now) {
        this.touch(key, entry);
        this.counts.hits++;
        out[at] = { res: entry.res, state: "hit", value: entry.value };
        continue;
      }
      if (entry && entry.stale > now) {
        this.touch(key, entry);
        this.counts.stale++;
        out[at] = { res: entry.res, state: "stale", value: entry.value };
        const backingOff = entry.retryAt !== undefined && entry.retryAt > now;
        if (!this.inflight.has(key) && !backingOff) refills.add(key);
        continue;
      }
      this.counts.misses++;
      const pending = this.inflight.get(key);
      if (pending) {
        joins.push({ at, key, pending });
        continue;
      }
      const list = [at];
      missing.push({ key, at: list });
      missingAt.set(key, list);
    }

    const calls = Math.ceil(missing.length / chunk);
    if (calls > 0 && opts.beforeFill) {
      try {
        opts.beforeFill(calls);
      } catch (e) {
        return Promise.reject(e);
      }
    }
    for (const j of joins) out[j.at] = this.served(j.key, j.pending, opts);
    for (let i = 0; i < missing.length; i += chunk) {
      const part = missing.slice(i, i + chunk);
      const fills = this.fill(
        part.map((m) => m.key),
        fetchMany,
        ttlMs,
        opts.keepValue ?? false,
        false,
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
    this.refusals.clear();
    this.bytes = 0;
  }

  /** Drop these keys alone, and their fills in flight. */
  delete(...keys: string[]): void {
    for (const key of keys) {
      this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
      const entry = this.entries.get(key);
      if (entry) this.drop(key, entry);
      this.inflight.delete(key);
      this.refusals.delete(key);
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
      if (held && held.held > Date.now() && opts.transient?.(err)) {
        return { res: held.res, value: held.value, state: "stale" };
      }
      throw err;
    }
  }

  /** One upstream call for `keys`: a promise per key, each single-flighted. */
  private fill(
    keys: string[],
    fetchMany: FetchMany,
    ttlMs: number,
    keepValue: boolean,
    refill: boolean,
  ): Promise<Filled>[] {
    this.counts.fills++;
    const generation = this.generation;
    const epochs = keys.map((k) => this.epochs.get(k) ?? 0);
    // A write landed meanwhile (the family, or this key): what the fill
    // brought may predate it, and is not kept (its caller still gets it).
    const current = (i: number) =>
      this.generation === generation && (this.epochs.get(keys[i]) ?? 0) === epochs[i];
    const batch = fetchMany(keys, { refill }).then((values) => {
      if (!Array.isArray(values) || values.length !== keys.length) {
        throw new Error(`cache ${this.name}: ${keys.length} values expected`);
      }
      return values;
    });
    return keys.map((key, i) => {
      const promise = batch
        .then(async (answer) => {
          const got = answer[i];
          if (got instanceof KeyFailure) throw got.error;
          const value = got instanceof Prebuilt ? undefined : got;
          const res = got instanceof Prebuilt ? got.res : await buildResponse(value);
          const bytes = res.json.length + res.gz.length + key.length + ENTRY_OVERHEAD;
          if (bytes > this.maxEntryBytes) {
            this.oversize(key, bytes);
            // What the key held is older than this value: not served again.
            const old = current(i) ? this.entries.get(key) : undefined;
            if (old) this.drop(key, old);
            if (this.refuseOversize) {
              const error = this.refuseOversize(key, bytes);
              if (current(i)) this.refusals.set(key, { until: Date.now() + ttlMs, error });
              throw error;
            }
          } else if (current(i)) {
            this.put(key, res, keepValue ? value : undefined, bytes, ttlMs);
          }
          return { res, value };
        })
        .catch((err: unknown) => {
          // Remembered: refused to every caller until the TTL ends, and what
          // the key held (a value served stale meanwhile) is not served again.
          if (this.remembers?.(err) && current(i)) {
            const old = this.entries.get(key);
            if (old) this.drop(key, old);
            this.refusals.set(key, { until: Date.now() + ttlMs, error: err as Error });
          }
          throw err;
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
  private refill(keys: string[], fetchMany: FetchMany, ttlMs: number): void {
    // An entry whose value was kept keeps it across its refill.
    const keepValue = keys.some((k) => this.entries.get(k)?.value !== undefined);
    const fills = this.fill(keys, fetchMany, ttlMs, keepValue, true);
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

  private put(
    key: string,
    res: CachedResponse,
    value: unknown,
    bytes: number,
    ttlMs: number,
  ): void {
    const old = this.entries.get(key);
    if (old) this.drop(key, old);
    const now = Date.now();
    const stale = now + ttlMs + this.staleForMs;
    this.entries.set(key, {
      res,
      value,
      bytes,
      fresh: now + ttlMs,
      stale,
      held: stale + this.holdForMs,
    });
    this.bytes += bytes;
    for (const [k, e] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.drop(k, e);
      this.counts.evictions++;
    }
  }

  /** A value too heavy to keep: counted, and said once in a while. */
  private oversize(key: string, bytes: number): void {
    this.counts.oversize++;
    const now = Date.now();
    if (now - this.oversizeLoggedAt > OVERSIZE_LOG_EVERY_MS) {
      this.oversizeLoggedAt = now;
      log.warn(
        { family: this.name, key, bytes, maxEntryBytes: this.maxEntryBytes },
        this.refuseOversize
          ? "cache: value over the entry limit, refused"
          : "cache: value over the entry limit, served uncached",
      );
    }
  }

  private drop(key: string, entry: FamilyEntry): void {
    this.entries.delete(key);
    this.bytes -= entry.bytes;
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
