// A map bounded in bytes, least recently used out first: the process memory
// budget's in-memory stores that are not caches of responses (the boundary
// geometry, the gazetteer chunks). The bytes are what the caller says a
// value weighs (its JSON's length); a value heavier than the whole budget is
// not kept.

export interface ByteLruStats {
  name: string;
  entries: number;
  bytes: number;
  maxBytes: number;
  evictions: number;
}

const lrus: ByteLru<unknown>[] = [];

/** Every ByteLru created, for /api/health. */
export function byteLrus(): readonly ByteLru<unknown>[] {
  return lrus;
}

export class ByteLru<V> {
  // Insertion order is recency.
  private readonly map = new Map<string, { value: V; bytes: number }>();
  private total = 0;
  private evictions = 0;

  constructor(
    readonly name: string,
    readonly maxBytes: number,
  ) {
    lrus.push(this as ByteLru<unknown>);
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.total;
  }

  /** The value, made the most recently used. */
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Keep `value` (weighing `bytes`), dropping the least recently used past the budget. */
  set(key: string, value: V, bytes: number): void {
    this.delete(key);
    if (bytes > this.maxBytes) return;
    this.map.set(key, { value, bytes });
    this.total += bytes;
    for (const [k, e] of this.map) {
      if (this.total <= this.maxBytes) break;
      this.map.delete(k);
      this.total -= e.bytes;
      this.evictions++;
    }
  }

  delete(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    this.map.delete(key);
    this.total -= e.bytes;
  }

  stats(): ByteLruStats {
    return {
      name: this.name,
      entries: this.map.size,
      bytes: this.total,
      maxBytes: this.maxBytes,
      evictions: this.evictions,
    };
  }
}
