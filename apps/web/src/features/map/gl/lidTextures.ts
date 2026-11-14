// The lid's textures, out of PlateauWallLayer: the one showing, and the ones
// kept for a unit selected again (ac:lid-cache, plateau/lidCache.ts).
//
// - A picture that is not kept (a refine over the visible slice, the DEV
//   "Carte" shot, every picture with the cache off) is uploaded into ONE
//   texture, re-specified at each upload — the layer's texture as it always
//   was. It is freed once another texture shows.
// - A picture handed with a key (`set(snap, keep)`: a whole-unit shot) is
//   uploaded into a texture of its own — that same one texture when it is
//   there, handed over — and kept under the key, by bytes
//   (plateau/lidCache.ts: the least recently shown dropped first, the one
//   showing never dropped for another's sake). `show(key)` then shows it
//   again: a pointer swap, no upload, no shot.
// - `keep(snap, keep)`: a picture kept without being shown (the shot of a
//   run the visitor has already left).
//
// Calls from outside a frame only record what to do; the GL work — uploads,
// deletes — happens in `frame(gl)`, which the layer calls from its render.
// A texture is never deleted in a call from outside a frame, and a kept
// texture showing is never deleted at all: dropped from the cache, it
// becomes the one texture of the pictures not kept. Pure: no mapbox, no DOM
// global; the upload is handed in (gl/lidTexture.ts). Run with
// `node --import tsx --test` (root "test:scripts").

import { LidCache, lidTextureBytes, type LidCacheBudget } from "../plateau/lidCache";

/** Mercator rectangle a picture covers (mapSnapshot.ts Snapshot["merc"]). */
export interface LidMerc {
  minX: number;
  minY: number;
  spanX: number;
  spanY: number;
}

/** What the store reads of a snapshot: its bitmap is closed once uploaded
 *  (or once it is known it never will be). */
export interface LidPicture<B extends LidBitmap = LidBitmap> {
  bitmap: B;
  merc: LidMerc;
}
export interface LidBitmap {
  width: number;
  height: number;
  close(): void;
}

/** A picture's key in the cache and what its asker wants back with it. */
export interface LidKeep<M> {
  key: string;
  meta: M;
}

interface Kept<T, M> {
  tex: T;
  merc: LidMerc;
  meta: M;
}

/** What the store asks of a WebGL context (a WebGL2RenderingContext has it). */
export interface LidGl<T> {
  createTexture(): T | null;
  deleteTexture(tex: T | null): void;
}

export class LidTextureStore<M, T = WebGLTexture, B extends LidBitmap = ImageBitmap> {
  /** The texture drawn and the rectangle it covers; null: no lid is drawn. */
  private shownTex: T | null = null;
  private shownMerc: LidMerc | null = null;
  /** The key of the kept picture showing; null: none, or one that is not kept. */
  private shownKey: string | null = null;
  /** The one texture of the pictures not kept. When there is one, it shows. */
  private scratch: T | null = null;
  private readonly cache: LidCache<Kept<T, M>>;
  /** The picture to upload and show at the next frame, and the one to upload
   *  and keep without showing it. */
  private pending: { snap: LidPicture<B>; keep: LidKeep<M> | null } | null = null;
  private stray: { snap: LidPicture<B>; keep: LidKeep<M> } | null = null;
  /** Textures to delete at the next frame. */
  private drops: T[] = [];
  /** Counters for the probe: uploads, pictures shown again without one. */
  uploads = 0;
  shows = 0;

  /** `upload`: the bitmap into the texture (gl/lidTexture.ts uploadLidTexture). */
  constructor(private readonly upload: (gl: LidGl<T>, tex: T, bitmap: B) => void) {
    this.cache = new LidCache<Kept<T, M>>((kept) => {
      if (kept.tex === this.shownTex) {
        // Showing: it stays, as the one texture of the pictures not kept.
        this.scratch = kept.tex;
        this.shownKey = null;
        this.cache.pinned = null;
      } else this.drops.push(kept.tex);
    });
  }

  /** The texture to draw the lid with, and its rectangle; null: none. */
  get texture(): T | null {
    return this.shownMerc ? this.shownTex : null;
  }
  get merc(): LidMerc | null {
    return this.shownMerc;
  }

  /** There is GL work for the next frame. */
  get dirty(): boolean {
    return !!this.pending || !!this.stray || this.drops.length > 0;
  }

  /** The picture to show from the next frame on; null: no lid. With `keep`
   *  it is kept under that key, room allowing. A picture set before and not
   *  uploaded yet is given up. */
  set(snap: LidPicture<B> | null, keep: LidKeep<M> | null = null): void {
    if (this.pending) this.pending.snap.bitmap.close();
    this.pending = snap ? { snap, keep } : null;
    if (!snap) this.unshow();
  }

  /** A picture kept under `keep.key` without being shown, room allowing (one
   *  waits at a time: a newer one replaces it). */
  keep(snap: LidPicture<B>, keep: LidKeep<M>): void {
    if (this.stray) this.stray.snap.bitmap.close();
    this.stray = { snap, keep };
  }

  /** What was handed with the picture kept under `key`; null: none is kept. */
  kept(key: string): M | null {
    return this.cache.peek(key)?.meta ?? null;
  }

  /** Shows the picture kept under `key`, from the next frame on: no upload.
   *  False: none is kept. A picture set and not uploaded yet is given up. */
  show(key: string): boolean {
    const kept = this.cache.get(key);
    if (!kept) return false;
    if (this.pending) this.pending.snap.bitmap.close();
    this.pending = null;
    this.shownTex = kept.tex;
    this.shownMerc = kept.merc;
    this.shownKey = key;
    this.cache.pinned = key;
    this.dropScratch();
    this.shows++;
    return true;
  }

  /** The cache's cap (plateau/lidCache.ts lidCacheBudget); 0 bytes keeps
   *  nothing, and what was kept is dropped. */
  setBudget(budget: LidCacheBudget): void {
    this.cache.setCap(budget);
  }

  /** No lid is drawn any more. The kept pictures stay. */
  private unshow(): void {
    this.shownTex = null;
    this.shownMerc = null;
    this.shownKey = null;
    this.cache.pinned = null;
    this.dropScratch();
  }

  /** The one texture of the pictures not kept is freed once it does not show. */
  private dropScratch(): void {
    if (this.scratch === null || this.scratch === this.shownTex) return;
    this.drops.push(this.scratch);
    this.scratch = null;
  }

  /** The frame's GL work: the pending picture uploaded and shown, the stray
   *  one uploaded and kept, the dropped textures deleted. */
  frame(gl: LidGl<T>): void {
    if (this.pending) {
      const { snap, keep } = this.pending;
      this.pending = null;
      const bytes = lidTextureBytes(snap.bitmap.width, snap.bitmap.height);
      // Whatever shows now is replaced: nothing is pinned while this one comes in.
      this.cache.pinned = null;
      let tex: T | null;
      if (keep && this.cache.fits(keep.key, bytes)) {
        // Its key's own texture again, else the one texture handed over (the
        // texture object is reused: texImage2D fully re-specifies it), else a new one.
        tex = this.cache.take(keep.key)?.tex ?? this.scratch ?? gl.createTexture();
        if (tex === this.scratch) this.scratch = null;
        if (tex !== null) {
          this.upload(gl, tex, snap.bitmap);
          // Before it is kept: what showed until now may be dropped for its room.
          this.shownTex = tex;
          this.cache.put(keep.key, { tex, merc: snap.merc, meta: keep.meta }, bytes);
          this.cache.pinned = keep.key;
          this.shownKey = keep.key;
        }
      } else {
        tex = this.scratch ??= gl.createTexture();
        if (tex !== null) this.upload(gl, tex, snap.bitmap);
        this.shownKey = null;
      }
      if (tex !== null) {
        this.uploads++;
        this.shownTex = tex;
        this.shownMerc = snap.merc;
      }
      snap.bitmap.close();
      this.dropScratch();
    }
    if (this.stray) {
      const { snap, keep } = this.stray;
      this.stray = null;
      const bytes = lidTextureBytes(snap.bitmap.width, snap.bitmap.height);
      if (this.cache.fits(keep.key, bytes)) {
        const had = this.cache.take(keep.key);
        const tex = had?.tex ?? gl.createTexture();
        if (tex !== null) {
          this.upload(gl, tex, snap.bitmap);
          this.uploads++;
          this.cache.put(keep.key, { tex, merc: snap.merc, meta: keep.meta }, bytes);
          // Its key's texture was the one showing: it shows the new picture.
          if (tex === this.shownTex) this.shownMerc = snap.merc;
          // The one showing stays the most recently used.
          else if (this.shownKey !== null) this.cache.get(this.shownKey);
        }
      }
      snap.bitmap.close();
    }
    for (const tex of this.drops.splice(0)) gl.deleteTexture(tex);
  }

  /** The WebGL context was lost: every texture is gone with it. Nothing is
   *  deleted, nothing shows, nothing is kept. */
  forget(): void {
    if (this.pending) this.pending.snap.bitmap.close();
    if (this.stray) this.stray.snap.bitmap.close();
    this.pending = null;
    this.stray = null;
    this.cache.forget();
    this.cache.pinned = null;
    this.drops = [];
    this.scratch = null;
    this.shownTex = null;
    this.shownMerc = null;
    this.shownKey = null;
  }

  /** The layer is removed: every texture deleted, every bitmap closed. */
  dispose(gl: LidGl<T>): void {
    const kept = this.cache.list().map((e) => this.cache.peek(e.key)!.tex);
    for (const tex of new Set([...kept, ...this.drops, this.scratch, this.shownTex])) {
      if (tex !== null) gl.deleteTexture(tex);
    }
    this.forget();
  }

  /** For the probe: what is kept (the least recently shown first), its bytes
   *  and the cap, the key showing, and whether the one texture of the
   *  pictures not kept exists. */
  stats() {
    return {
      kept: this.cache.list(),
      bytes: this.cache.bytes,
      cap: this.cache.cap,
      showing: this.shownMerc ? (this.shownKey ?? "(not kept)") : null,
      scratch: this.scratch !== null,
      uploads: this.uploads,
      shows: this.shows,
    };
  }
}
