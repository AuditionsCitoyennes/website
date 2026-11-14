// The lid's textures (lidTextures.ts) on a counting fake of the WebGL calls:
// which texture a picture is uploaded into, which one shows, what is kept,
// what is deleted and when. Run with `node --import tsx --test` (root
// "test:scripts"). Pure: no mapbox, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { lidTextureBytes } from "../plateau/lidCache";
import { LidTextureStore, type LidGl } from "./lidTextures";

interface Tex {
  id: number;
}
interface Bitmap {
  name: string;
  width: number;
  height: number;
  closed: boolean;
  close(): void;
}

const ONE = lidTextureBytes(1024, 1024);

function setup(pictures = 3) {
  let next = 1;
  const created: number[] = [];
  const deleted: number[] = [];
  /** texture id → the picture uploaded into it last. */
  const holds = new Map<number, string>();
  const gl: LidGl<Tex> = {
    createTexture: () => {
      const t = { id: next++ };
      created.push(t.id);
      return t;
    },
    deleteTexture: (t) => {
      if (t) deleted.push(t.id);
    },
  };
  const store = new LidTextureStore<{ px: number }, Tex, Bitmap>((_gl, tex, bitmap) => {
    assert.equal(bitmap.closed, false, "uploaded before it is closed");
    holds.set(tex.id, bitmap.name);
  });
  store.setBudget({ bytes: pictures * ONE, count: 99 });
  const bitmaps: Bitmap[] = [];
  const snap = (name: string, px = 1024) => {
    const bitmap: Bitmap = {
      name,
      width: px,
      height: px,
      closed: false,
      close() {
        this.closed = true;
      },
    };
    bitmaps.push(bitmap);
    return { bitmap, merc: { minX: bitmaps.length, minY: 0, spanX: 1, spanY: 1 } };
  };
  const keep = (key: string, px = 1024) => ({ key, meta: { px } });
  /** The picture the texture showing holds. */
  const showing = () => (store.texture ? holds.get(store.texture.id) : null);
  const keys = () => store.stats().kept.map((e) => e.key);
  return { store, gl, created, deleted, holds, bitmaps, snap, keep, showing, keys };
}

test("no key: one texture, re-specified at each upload, as before", () => {
  const t = setup();
  assert.equal(t.store.texture, null);
  assert.equal(t.store.dirty, false);
  t.store.set(t.snap("a"));
  assert.equal(t.store.dirty, true);
  assert.equal(t.store.texture, null); // nothing shows before its frame
  t.store.frame(t.gl);
  assert.equal(t.showing(), "a");
  assert.equal(t.store.dirty, false);
  t.store.set(t.snap("b"));
  t.store.frame(t.gl);
  assert.equal(t.showing(), "b");
  assert.deepEqual(t.created, [1]);
  assert.deepEqual(t.deleted, []);
  assert.deepEqual(t.keys(), []);
  assert.ok(t.bitmaps.every((b) => b.closed));
  assert.deepEqual(t.store.stats().showing, "(not kept)");
});

test("a picture set over one not uploaded yet: the first is closed, never uploaded", () => {
  const t = setup();
  t.store.set(t.snap("a"));
  t.store.set(t.snap("b"));
  assert.equal(t.bitmaps[0].closed, true);
  t.store.frame(t.gl);
  assert.equal(t.showing(), "b");
  assert.equal(t.store.uploads, 1);
});

test("null: no lid is drawn, the kept pictures stay, the texture not kept is freed at the next frame", () => {
  const t = setup();
  t.store.set(t.snap("a"), t.keep("A"));
  t.store.frame(t.gl);
  t.store.set(t.snap("slice"));
  t.store.frame(t.gl);
  assert.equal(t.showing(), "slice");
  t.store.set(null);
  assert.equal(t.store.texture, null);
  assert.equal(t.store.merc, null);
  assert.deepEqual(t.deleted, []); // not outside a frame
  t.store.frame(t.gl);
  assert.deepEqual(t.deleted, [2]);
  assert.deepEqual(t.keys(), ["A"]);
  assert.equal(t.store.show("A"), true);
  assert.equal(t.showing(), "a");
});

test("A, B, A again: the third shows the first's texture, with no upload", () => {
  const t = setup();
  t.store.set(t.snap("a"), t.keep("A"));
  t.store.frame(t.gl);
  t.store.set(t.snap("b"), t.keep("B"));
  t.store.frame(t.gl);
  assert.equal(t.showing(), "b");
  assert.deepEqual(t.created, [1, 2]);
  assert.deepEqual(t.store.kept("A"), { px: 1024 });
  assert.equal(t.store.kept("C"), null);
  const mercA = { minX: 1, minY: 0, spanX: 1, spanY: 1 };
  assert.equal(t.store.show("A"), true);
  assert.equal(t.showing(), "a"); // at once: a pointer swap
  assert.deepEqual(t.store.merc, mercA);
  assert.equal(t.store.dirty, false); // nothing for a frame to do
  t.store.frame(t.gl);
  assert.equal(t.store.uploads, 2);
  assert.equal(t.store.shows, 1);
  assert.deepEqual(t.created, [1, 2]);
  assert.deepEqual(t.deleted, []);
  assert.equal(t.store.stats().showing, "A");
  assert.equal(t.store.show("C"), false);
  assert.equal(t.showing(), "a");
});

test("the first kept picture takes over the one texture; a refine then gets a new one, freed when a kept one shows", () => {
  const t = setup();
  t.store.set(t.snap("old")); // not kept: the one texture
  t.store.frame(t.gl);
  t.store.set(t.snap("a"), t.keep("A")); // handed over: no second texture
  t.store.frame(t.gl);
  assert.deepEqual(t.created, [1]);
  assert.equal(t.store.stats().scratch, false);
  t.store.set(t.snap("a-slice")); // a refine: A's texture is left alone
  t.store.frame(t.gl);
  assert.deepEqual(t.created, [1, 2]);
  assert.equal(t.showing(), "a-slice");
  assert.equal(t.holds.get(1), "a");
  assert.equal(t.store.stats().scratch, true);
  t.store.set(t.snap("a-slice-2")); // a second refine: the same texture again
  t.store.frame(t.gl);
  assert.deepEqual(t.created, [1, 2]);
  assert.equal(t.store.show("A"), true); // zoomed back out
  assert.deepEqual(t.deleted, []);
  t.store.frame(t.gl);
  assert.deepEqual(t.deleted, [2]);
  assert.equal(t.store.stats().scratch, false);
});

test("the same key again (a finer whole-unit shot): its own texture, re-specified", () => {
  const t = setup();
  t.store.set(t.snap("a"), t.keep("A"));
  t.store.frame(t.gl);
  t.store.set(t.snap("b"), t.keep("B"));
  t.store.frame(t.gl);
  t.store.set(t.snap("a-fine", 1280), t.keep("A", 1280));
  t.store.frame(t.gl);
  assert.deepEqual(t.created, [1, 2]);
  assert.equal(t.holds.get(1), "a-fine");
  assert.equal(t.showing(), "a-fine");
  assert.deepEqual(t.store.kept("A"), { px: 1280 });
  assert.equal(t.store.stats().bytes, ONE + lidTextureBytes(1280, 1280));
  assert.deepEqual(t.deleted, []);
});

test("over the cap: the least recently shown is dropped and deleted in that frame, never the one showing", () => {
  const t = setup(2);
  for (const k of ["A", "B", "C"]) {
    t.store.set(t.snap(k.toLowerCase()), t.keep(k));
    t.store.frame(t.gl);
  }
  assert.deepEqual(t.keys(), ["B", "C"]);
  assert.deepEqual(t.deleted, [1]);
  assert.equal(t.showing(), "c");
  assert.equal(t.store.show("B"), true);
  t.store.set(t.snap("d"), t.keep("D"));
  t.store.frame(t.gl);
  // C was the least recently shown; B, showing until this frame, is kept.
  assert.deepEqual(t.keys(), ["B", "D"]);
  assert.deepEqual(t.deleted, [1, 3]);
  assert.equal(t.showing(), "d");
});

test("a picture too large for the cap is shown and not kept", () => {
  const t = setup(2);
  t.store.set(t.snap("a"), t.keep("A"));
  t.store.frame(t.gl);
  t.store.set(t.snap("huge", 4096), t.keep("H", 4096));
  t.store.frame(t.gl);
  assert.equal(t.showing(), "huge");
  assert.deepEqual(t.keys(), ["A"]);
  assert.equal(t.store.kept("H"), null);
  assert.equal(t.store.stats().showing, "(not kept)");
  assert.equal(t.store.show("A"), true);
  t.store.frame(t.gl);
  assert.deepEqual(t.deleted, [2]); // the large one is not left behind
});

test("a stray picture is kept without being shown, and the one showing stays the last to go", () => {
  const t = setup(2);
  t.store.set(t.snap("a"), t.keep("A"));
  t.store.frame(t.gl);
  t.store.keep(t.snap("b"), t.keep("B"));
  assert.equal(t.store.dirty, true);
  t.store.frame(t.gl);
  assert.equal(t.showing(), "a");
  assert.deepEqual(t.keys(), ["B", "A"]);
  assert.equal(t.store.uploads, 2);
  // A second stray: B goes, not A (showing).
  t.store.keep(t.snap("c"), t.keep("C"));
  t.store.frame(t.gl);
  assert.deepEqual(t.keys(), ["C", "A"]);
  assert.deepEqual(t.deleted, [2]);
  assert.equal(t.showing(), "a");
  assert.equal(t.store.show("C"), true);
  assert.equal(t.showing(), "c");
  // Two strays before a frame: the first is closed, never uploaded.
  const first = t.snap("d");
  t.store.keep(first, t.keep("D"));
  t.store.keep(t.snap("e"), t.keep("E"));
  assert.equal(first.bitmap.closed, true);
  t.store.frame(t.gl);
  assert.deepEqual(t.keys(), ["E", "C"]);
  assert.ok(t.bitmaps.every((b) => b.closed));
});

test("a stray that cannot sit beside the one showing is closed and not kept", () => {
  const t = setup(1);
  t.store.set(t.snap("a"), t.keep("A"));
  t.store.frame(t.gl);
  const b = t.snap("b");
  t.store.keep(b, t.keep("B"));
  t.store.frame(t.gl);
  assert.equal(b.bitmap.closed, true);
  assert.deepEqual(t.keys(), ["A"]);
  assert.deepEqual(t.created, [1]);
  assert.equal(t.store.uploads, 1);
});

test("a stray for the key showing: its texture shows the new picture", () => {
  const t = setup();
  t.store.set(t.snap("a"), t.keep("A"));
  t.store.frame(t.gl);
  const again = t.snap("a2");
  t.store.keep(again, t.keep("A"));
  t.store.frame(t.gl);
  assert.equal(t.showing(), "a2");
  assert.deepEqual(t.store.merc, again.merc);
  assert.deepEqual(t.created, [1]);
});

test("the budget down to nothing: the kept ones are deleted at the next frame, the one showing stays as the texture not kept", () => {
  const t = setup();
  t.store.set(t.snap("a"), t.keep("A"));
  t.store.frame(t.gl);
  t.store.set(t.snap("b"), t.keep("B"));
  t.store.frame(t.gl);
  t.store.setBudget({ bytes: 0, count: 0 });
  assert.deepEqual(t.deleted, []);
  assert.equal(t.showing(), "b");
  assert.equal(t.store.dirty, true);
  t.store.frame(t.gl);
  assert.deepEqual(t.deleted, [1]);
  assert.deepEqual(t.keys(), []);
  assert.deepEqual(t.store.stats().showing, "(not kept)");
  assert.equal(t.store.stats().scratch, true);
  // Off: a keyed picture is not kept, and goes into the one texture.
  t.store.set(t.snap("c"), t.keep("C"));
  t.store.frame(t.gl);
  assert.equal(t.showing(), "c");
  assert.deepEqual(t.created, [1, 2]);
  assert.equal(t.store.show("C"), false);
});

test("the context lost: nothing kept, nothing shown, nothing deleted; then it works again", () => {
  const t = setup();
  t.store.set(t.snap("a"), t.keep("A"));
  t.store.frame(t.gl);
  const waiting = t.snap("b");
  t.store.set(waiting, t.keep("B"));
  t.store.forget();
  assert.equal(waiting.bitmap.closed, true);
  assert.equal(t.store.texture, null);
  assert.deepEqual(t.keys(), []);
  assert.equal(t.store.dirty, false);
  t.store.frame(t.gl);
  assert.deepEqual(t.deleted, []);
  t.store.set(t.snap("c"), t.keep("C"));
  t.store.frame(t.gl);
  assert.equal(t.showing(), "c");
});

test("the layer removed: every texture is deleted once, every bitmap closed", () => {
  const t = setup();
  t.store.set(t.snap("a"), t.keep("A"));
  t.store.frame(t.gl);
  t.store.set(t.snap("b"), t.keep("B"));
  t.store.frame(t.gl);
  t.store.set(t.snap("slice"));
  t.store.frame(t.gl);
  t.store.set(t.snap("waiting"));
  t.store.keep(t.snap("stray"), t.keep("S"));
  t.store.dispose(t.gl);
  assert.deepEqual(
    [...t.deleted].sort((a, b) => a - b),
    [1, 2, 3],
  );
  assert.ok(t.bitmaps.every((b) => b.closed));
  assert.equal(t.store.texture, null);
  assert.deepEqual(t.keys(), []);
});

test("set aside, then committed: what shows stays until the commit, and nothing drops the one set aside", () => {
  const t = setup(2);
  t.store.set(t.snap("a"), t.keep("A"));
  t.store.frame(t.gl);
  t.store.set(t.snap("b"), t.keep("B"));
  t.store.frame(t.gl);
  assert.equal(t.store.current, "B");
  assert.equal(t.store.reserve("A"), true);
  assert.equal(t.showing(), "b"); // B's lid stays while its plateau sinks
  assert.equal(t.store.current, "A");
  assert.deepEqual(t.store.kept("A"), { px: 1024 }); // still answered for
  assert.equal(t.store.stats().reserved, "A");
  assert.equal(t.store.reserve("A"), true); // asked again: nothing changes
  // A stray lands meanwhile: there is room beside B, and A is not in the way.
  t.store.keep(t.snap("c"), t.keep("C"));
  t.store.frame(t.gl);
  assert.deepEqual(t.keys(), ["C", "B"]);
  assert.deepEqual(t.deleted, []);
  assert.equal(t.store.commit(), true);
  assert.equal(t.showing(), "a");
  assert.equal(t.store.current, "A");
  assert.equal(t.store.stats().reserved, null);
  // Back in the cache as the one showing: the least recently shown made room.
  assert.deepEqual(t.keys(), ["B", "A"]);
  t.store.frame(t.gl);
  assert.deepEqual(t.deleted, [3]);
  assert.equal(t.store.uploads, 3);
  assert.equal(t.store.shows, 1);
  assert.equal(t.store.commit(), false); // nothing set aside any more
  assert.equal(t.store.reserve("Z"), false);
});

test("set aside, then cancelled or replaced: it goes back among the kept ones", () => {
  const t = setup();
  for (const k of ["A", "B", "C"]) {
    t.store.set(t.snap(k.toLowerCase()), t.keep(k));
    t.store.frame(t.gl);
  }
  t.store.reserve("A");
  t.store.cancel();
  assert.equal(t.store.current, "C");
  assert.deepEqual(t.keys().sort(), ["A", "B", "C"]);
  assert.equal(t.store.commit(), false);
  assert.equal(t.showing(), "c");
  // Another one set aside in its place.
  t.store.reserve("A");
  t.store.reserve("B");
  assert.equal(t.store.current, "B");
  assert.deepEqual(t.store.kept("A"), { px: 1024 });
  t.store.commit();
  assert.equal(t.showing(), "b");
  assert.deepEqual(t.keys().sort(), ["A", "B", "C"]);
  // A new picture given: the one set aside will not show.
  t.store.reserve("A");
  t.store.set(t.snap("d"));
  assert.equal(t.store.stats().reserved, null);
  t.store.frame(t.gl);
  assert.equal(t.showing(), "d");
  assert.equal(t.store.commit(), false);
  // No lid at all: the same.
  t.store.reserve("A");
  t.store.set(null);
  assert.equal(t.store.current, null);
  assert.deepEqual(t.keys().sort(), ["A", "B", "C"]);
  assert.deepEqual(t.deleted, []);
});

test("set aside while the budget shrinks to nothing: it still shows at its commit, as the texture not kept", () => {
  const t = setup();
  t.store.set(t.snap("a"), t.keep("A"));
  t.store.frame(t.gl);
  t.store.set(t.snap("b"), t.keep("B"));
  t.store.frame(t.gl);
  t.store.reserve("A");
  t.store.setBudget({ bytes: 0, count: 0 });
  assert.equal(t.showing(), "b");
  assert.equal(t.store.commit(), true);
  assert.equal(t.showing(), "a");
  assert.deepEqual(t.keys(), []);
  assert.equal(t.store.stats().showing, "(not kept)");
  t.store.frame(t.gl);
  assert.deepEqual(t.deleted, [2]); // B's, which showed until the commit
  // And cancelled instead: with no room to go back to, it is freed.
  const u = setup();
  u.store.set(u.snap("a"), u.keep("A"));
  u.store.frame(u.gl);
  u.store.set(u.snap("b"), u.keep("B"));
  u.store.frame(u.gl);
  u.store.reserve("A");
  u.store.setBudget({ bytes: 0, count: 0 });
  u.store.cancel();
  u.store.frame(u.gl);
  assert.deepEqual(u.deleted, [1]);
  assert.equal(u.showing(), "b");
});

test("the layer removed with one set aside: its texture is deleted too", () => {
  const t = setup();
  t.store.set(t.snap("a"), t.keep("A"));
  t.store.frame(t.gl);
  t.store.set(t.snap("b"), t.keep("B"));
  t.store.frame(t.gl);
  t.store.reserve("A");
  t.store.dispose(t.gl);
  assert.deepEqual(
    [...t.deleted].sort((a, b) => a - b),
    [1, 2],
  );
  assert.equal(t.store.stats().reserved, null);
});
