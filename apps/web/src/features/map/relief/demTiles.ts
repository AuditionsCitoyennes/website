// The client relief's tile plumbing, pure: the raster-dem template Mapbox asks
// for (`ac-dem://<key>/{z}/{x}/{y}`, a scheme Mapbox hands untouched to
// `transformRequest`), its parser, the answers' cache and the per-frame budget
// that hands answers back to Mapbox a few at a time. No DOM at import: the
// browser scheduler is read only when a budget built with it first queues.

export const DEM_SCHEME = "ac-dem://";

/** The raster-dem source's tile template for one version key. */
export function demTemplate(key: string): string {
  return `${DEM_SCHEME}${key}/{z}/{x}/{y}`;
}

export interface DemTileId {
  key: string;
  z: number;
  x: number;
  y: number;
}

// Keys are the server's 32 hex digits or the "f" + 16 hex fallback; z/x/y
// plain integers (no sign, no leading zero), and nothing after them.
const DEM_URL = /^ac-dem:\/\/([0-9a-z]+)\/(0|[1-9]\d*)\/(0|[1-9]\d*)\/(0|[1-9]\d*)$/;

/** The tile a template URL names, or null for anything else (z capped at 30: 2^z stays exact). */
export function parseDemUrl(url: string): DemTileId | null {
  const m = DEM_URL.exec(url);
  if (!m) return null;
  const z = Number(m[2]);
  const x = Number(m[3]);
  const y = Number(m[4]);
  if (z > 30 || x >= 2 ** z || y >= 2 ** z) return null;
  return { key: m[1], z, x, y };
}

/** FNV-1a, 64-bit, over the UTF-8 bytes, as 16 hex digits (16-bit limbs: no BigInt per byte). */
export function fnv1a64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (let i = 0; i < bytes.length; i++) {
    h0 ^= bytes[i];
    // h * (2^40 + 0x1b3) mod 2^64: 2^40 lands on limb 2 shifted by 8 bits.
    const t0 = h0 * 0x1b3;
    let t1 = h1 * 0x1b3;
    let t2 = h2 * 0x1b3 + h0 * 256;
    let t3 = h3 * 0x1b3 + h1 * 256;
    t1 += t0 >>> 16;
    t2 += t1 >>> 16;
    t3 += t2 >>> 16;
    h0 = t0 & 0xffff;
    h1 = t1 & 0xffff;
    h2 = t2 & 0xffff;
    h3 = t3 & 0xffff;
  }
  return [h3, h2, h1, h0].map((h) => h.toString(16).padStart(4, "0")).join("");
}

/**
 * The answers by `key/z/x/y`, the promise itself (a request arriving while the
 * first is still rendering shares it). LRU: a hit refreshes recency. The a/b
 * slots and a repeated ensurePlateau of one selection share it.
 */
export class TileCache {
  private readonly map = new Map<string, Promise<string>>();
  constructor(private readonly max = 2000) {}
  get size(): number {
    return this.map.size;
  }
  get(k: string): Promise<string> | undefined {
    const p = this.map.get(k);
    if (p) {
      this.map.delete(k);
      this.map.set(k, p);
    }
    return p;
  }
  set(k: string, p: Promise<string>): void {
    this.map.delete(k);
    this.map.set(k, p);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  /** With `only`, deletes the entry only while it is still that promise. */
  delete(k: string, only?: Promise<string>): void {
    if (only === undefined || this.map.get(k) === only) this.map.delete(k);
  }
}

export interface FrameScheduler {
  frame(cb: () => void): unknown;
  cancelFrame(h: unknown): void;
  timer(cb: () => void, ms: number): unknown;
  cancelTimer(h: unknown): void;
}

// Read off globalThis: this module is also compiled for Node (scripts/), without DOM types.
const raf = globalThis as unknown as {
  requestAnimationFrame(cb: () => void): number;
  cancelAnimationFrame(h: number): void;
};

export const browserScheduler: FrameScheduler = {
  frame: (cb) => raf.requestAnimationFrame(cb),
  cancelFrame: (h) => raf.cancelAnimationFrame(h as number),
  timer: (cb, ms) => setTimeout(cb, ms),
  cancelTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** A frame's turn comes on the animation frame, or after this long if rAF is throttled. */
export const FRAME_FALLBACK_MS = 50;

/**
 * At most `n` answers released per animation frame, lowest z first then in
 * arrival order, so a burst of tiles lands over a few frames instead of one.
 * A 50 ms timer stands in for a throttled rAF; `n = 0` releases at once.
 * Nothing is scheduled while the queue is empty (an idle map stays idle).
 */
export class FrameBudget {
  private queue: { z: number; seq: number; release: () => void }[] = [];
  private seq = 0;
  private armed: { frame: unknown; timer: unknown } | null = null;
  constructor(
    private readonly n: number,
    private readonly sched: FrameScheduler = browserScheduler,
  ) {}

  release(z: number): Promise<void> {
    if (this.n <= 0) return Promise.resolve();
    return new Promise((release) => {
      this.queue.push({ z, seq: this.seq++, release });
      this.arm();
    });
  }

  get queued(): number {
    return this.queue.length;
  }

  private arm(): void {
    if (this.armed || this.queue.length === 0) return;
    const armed: { frame: unknown; timer: unknown } = { frame: null, timer: null };
    // Whichever of the frame and the timer comes first takes the turn and
    // cancels the other.
    const turn = () => {
      if (this.armed !== armed) return;
      this.sched.cancelFrame(armed.frame);
      this.sched.cancelTimer(armed.timer);
      this.armed = null;
      this.queue.sort((a, b) => a.z - b.z || a.seq - b.seq);
      for (const q of this.queue.splice(0, this.n)) q.release();
      this.arm();
    };
    this.armed = armed;
    armed.frame = this.sched.frame(turn);
    armed.timer = this.sched.timer(turn, FRAME_FALLBACK_MS);
  }
}
