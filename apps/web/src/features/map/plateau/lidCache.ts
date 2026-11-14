// The lid pictures kept (ac:lid-cache, plateau/lidCacheSwitch.ts): which
// ones, and how many bytes of them. A plateau's lid is a picture of the map
// shot by the hidden map (mapSnapshot.ts) and uploaded as a texture; the
// whole-unit pictures already uploaded are kept, the least recently shown
// dropped first, so a unit selected again rises with its lid on and no shot
// is rendered. Kept by bytes of graphics memory, a small cap that depends on
// the device (`lidCacheBudget`): the picture showing counts in it and is
// never dropped for another one's sake (`pinned`). Pure: no GL, no DOM — the
// textures are the values, dropped through `onDrop` (gl/lidTextures.ts owns
// them). Run with `node --import tsx --test` (root "test:scripts").

import type { DeviceTier } from "@/shared/device/deviceTier";

const MIB = 1024 * 1024;

/** The graphics memory of a lid texture: RGBA, with its mipmaps (a third more). */
export const lidTextureBytes = (width: number, height: number): number =>
  Math.floor((width * height * 4 * 4) / 3);

export interface LidCacheBudget {
  /** The most bytes kept, the picture showing included; 0: nothing is kept. */
  bytes: number;
  /** The most pictures kept, the one showing included. */
  count: number;
}

export interface LidCacheBudgetInput {
  /** The switch. */
  on: boolean;
  tier: DeviceTier;
  /** A phone: a coarse pointer and a short side under 600 css px (as lidTier.ts). */
  phone: boolean;
  /** navigator.deviceMemory at or under 4 GB (its lids are 1024 px: lidTier.ts). */
  lowMemory: boolean;
}

/** What a device keeps. A 1024 px lid is 5.3 MiB with its mipmaps, a 1280 px
 *  one 8.3, a 2048 px one 21.3.
 *  - a weak device (a tier under "full", or little memory): 12 MiB — the lid
 *    showing and one more at 1024 px;
 *  - a phone: 24 MiB — up to four at 1024 px, two at 1280;
 *  - elsewhere: 64 MiB, four pictures at most — three at 2048 px (a HiDPI
 *    desktop's floor), four at 1024.
 *  A picture larger than the cap is not kept at all (a 4096 px refine is 85 MiB). */
export function lidCacheBudget(i: LidCacheBudgetInput): LidCacheBudget {
  if (!i.on) return { bytes: 0, count: 0 };
  if (i.tier !== "full" || i.lowMemory) return { bytes: 12 * MIB, count: 2 };
  if (i.phone) return { bytes: 24 * MIB, count: 4 };
  return { bytes: 64 * MIB, count: 4 };
}

/** Whether a kept picture answers an ask for the same rectangle at `px`
 *  backing-store pixels: it does when it was shot for at least as many — a
 *  finer ask is shot anew, and its picture kept in the coarser one's place. */
export const keptAnswers = (kept: { px: number } | null | undefined, px: number): boolean =>
  !!kept && kept.px >= px;

interface Entry<V> {
  value: V;
  bytes: number;
}

/** The pictures kept, by key, the least recently used first. */
export class LidCache<V> {
  /** A Map keeps insertion order: the first key is the least recently used. */
  private readonly entries = new Map<string, Entry<V>>();
  private total = 0;
  private capBytes = 0;
  private capCount = 0;
  /** The key no other picture's arrival drops (the one showing); null: none. */
  pinned: string | null = null;

  /** `onDrop`: a picture left the cache (dropped for room, replaced, or
   *  cleared); its owner frees it. */
  constructor(private readonly onDrop: (value: V, key: string) => void) {}

  get bytes(): number {
    return this.total;
  }
  get size(): number {
    return this.entries.size;
  }
  get cap(): LidCacheBudget {
    return { bytes: this.capBytes, count: this.capCount };
  }

  /** The picture kept under `key`, its place in the order unchanged. */
  peek(key: string): V | undefined {
    return this.entries.get(key)?.value;
  }

  /** The picture kept under `key`, now the most recently used. */
  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }

  /** Whether a picture of `bytes` could be kept under `key` now, beside the
   *  pinned one (unless `key` is the pinned one's: it would replace it). */
  fits(key: string, bytes: number): boolean {
    const pin = this.pinned !== null && this.pinned !== key ? this.entries.get(this.pinned) : null;
    return (
      bytes > 0 && (pin?.bytes ?? 0) + bytes <= this.capBytes && (pin ? 1 : 0) + 1 <= this.capCount
    );
  }

  /** Keeps `value` under `key` as the most recently used, dropping the least
   *  recently used others for room. False, and nothing changed: it does not
   *  fit (`fits`). A picture already under `key` is dropped, unless it is
   *  `value` itself. */
  put(key: string, value: V, bytes: number): boolean {
    if (!this.fits(key, bytes)) return false;
    const had = this.entries.get(key);
    if (had) {
      this.entries.delete(key);
      this.total -= had.bytes;
      if (had.value !== value) this.onDrop(had.value, key);
    }
    this.trim(this.capBytes - bytes, this.capCount - 1, true);
    this.entries.set(key, { value, bytes });
    this.total += bytes;
    return true;
  }

  /** The picture under `key` taken out without being dropped, with its
   *  bytes: its owner keeps it (to use it again, or to put it back). */
  take(key: string): { value: V; bytes: number } | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    this.entries.delete(key);
    this.total -= e.bytes;
    return e;
  }

  /** Another cap: the least recently used are dropped down to it — the pinned
   *  one last, and only if it alone is over the cap. */
  setCap(budget: LidCacheBudget): void {
    if (budget.bytes === this.capBytes && budget.count === this.capCount) return;
    this.capBytes = Math.max(0, budget.bytes);
    this.capCount = Math.max(0, budget.count);
    this.trim(this.capBytes, this.capCount, true);
    this.trim(this.capBytes, this.capCount, false);
  }

  /** Drops the least recently used until `bytes` and `count` hold; `keepPin`
   *  leaves the pinned one alone. */
  private trim(bytes: number, count: number, keepPin: boolean): void {
    for (const [key, e] of [...this.entries]) {
      if (this.total <= bytes && this.entries.size <= count) return;
      if (keepPin && key === this.pinned) continue;
      this.entries.delete(key);
      this.total -= e.bytes;
      this.onDrop(e.value, key);
    }
  }

  /** Every picture dropped. */
  clear(): void {
    for (const [key, e] of [...this.entries]) {
      this.entries.delete(key);
      this.onDrop(e.value, key);
    }
    this.total = 0;
  }

  /** Every picture forgotten without being dropped: there is nothing left to
   *  free (the WebGL context was lost). */
  forget(): void {
    this.entries.clear();
    this.total = 0;
  }

  /** The pictures kept, the least recently used first. */
  list(): { key: string; bytes: number }[] {
    return [...this.entries].map(([key, e]) => ({ key, bytes: e.bytes }));
  }
}
