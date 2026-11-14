// The lid pictures kept (lidCache.ts): the order they are dropped in, the
// cap by bytes and by count, the pinned one, and each device's budget. Run
// with `node --import tsx --test` (root "test:scripts"). Pure: no GL.

import assert from "node:assert/strict";
import { test } from "node:test";
import { LidCache, lidCacheBudget, lidTextureBytes } from "./lidCache";

const MIB = 1024 * 1024;

function setup(bytes: number, count = 99) {
  const dropped: string[] = [];
  const c = new LidCache<string>((value, key) => dropped.push(`${key}=${value}`));
  c.setCap({ bytes, count });
  const keys = () => c.list().map((e) => e.key);
  return { c, dropped, keys };
}

test("a texture's bytes: RGBA and a third more for its mipmaps", () => {
  assert.equal(lidTextureBytes(1024, 1024), Math.floor((1024 * 1024 * 16) / 3));
  assert.ok(Math.abs(lidTextureBytes(1024, 1024) / MIB - 5.33) < 0.01);
  assert.ok(Math.abs(lidTextureBytes(2048, 2048) / MIB - 21.33) < 0.01);
  assert.ok(lidTextureBytes(4096, 4096) > 64 * MIB);
});

test("kept up to the cap in bytes; the least recently used is dropped first", () => {
  const t = setup(30);
  assert.equal(t.c.put("a", "A", 10), true);
  assert.equal(t.c.put("b", "B", 10), true);
  assert.equal(t.c.put("c", "C", 10), true);
  assert.equal(t.c.bytes, 30);
  assert.deepEqual(t.dropped, []);
  assert.equal(t.c.get("a"), "A"); // used: b is now the oldest
  assert.equal(t.c.put("d", "D", 10), true);
  assert.deepEqual(t.dropped, ["b=B"]);
  assert.deepEqual(t.keys(), ["c", "a", "d"]);
  // A bigger one takes the room of two.
  assert.equal(t.c.put("e", "E", 20), true);
  assert.deepEqual(t.dropped, ["b=B", "c=C", "a=A"]);
  assert.deepEqual(t.keys(), ["d", "e"]);
  assert.equal(t.c.bytes, 30);
  assert.equal(t.c.size, 2);
});

test("peek leaves the order alone, get does not", () => {
  const t = setup(20);
  t.c.put("a", "A", 10);
  t.c.put("b", "B", 10);
  assert.equal(t.c.peek("a"), "A");
  assert.equal(t.c.peek("z"), undefined);
  assert.equal(t.c.get("z"), undefined);
  t.c.put("c", "C", 10);
  assert.deepEqual(t.dropped, ["a=A"]);
});

test("a picture larger than the cap is not kept, and nothing is dropped for it", () => {
  const t = setup(30);
  t.c.put("a", "A", 10);
  assert.equal(t.c.fits("big", 31), false);
  assert.equal(t.c.put("big", "BIG", 31), false);
  assert.equal(t.c.put("none", "NONE", 0), false);
  assert.deepEqual(t.dropped, []);
  assert.deepEqual(t.keys(), ["a"]);
  // With nothing allowed, nothing fits.
  const off = setup(0, 0);
  assert.equal(off.c.put("a", "A", 1), false);
  assert.equal(off.c.size, 0);
});

test("the cap by count holds too", () => {
  const t = setup(1000, 2);
  t.c.put("a", "A", 1);
  t.c.put("b", "B", 1);
  t.c.put("c", "C", 1);
  assert.deepEqual(t.dropped, ["a=A"]);
  assert.deepEqual(t.keys(), ["b", "c"]);
});

test("the same key again: the old picture is dropped, unless it is the same one", () => {
  const t = setup(30);
  t.c.put("a", "A", 10);
  t.c.put("b", "B", 10);
  assert.equal(t.c.put("a", "A2", 20), true);
  assert.deepEqual(t.dropped, ["a=A"]);
  assert.deepEqual(t.keys(), ["b", "a"]);
  assert.equal(t.c.bytes, 30);
  assert.equal(t.c.put("a", "A2", 5), true); // the same object, at another size
  assert.deepEqual(t.dropped, ["a=A"]);
  assert.equal(t.c.bytes, 15);
});

test("the pinned one is never dropped for another's sake; one that cannot sit beside it is refused", () => {
  const t = setup(30);
  t.c.put("a", "A", 10);
  t.c.put("b", "B", 10);
  t.c.put("c", "C", 10);
  t.c.pinned = "a"; // the oldest, and the one showing
  assert.equal(t.c.put("d", "D", 10), true);
  assert.deepEqual(t.dropped, ["b=B"]);
  assert.deepEqual(t.keys(), ["a", "c", "d"]);
  assert.equal(t.c.fits("e", 21), false); // 10 pinned + 21 > 30
  assert.equal(t.c.put("e", "E", 21), false);
  assert.deepEqual(t.keys(), ["a", "c", "d"]);
  assert.equal(t.c.put("e", "E", 20), true);
  assert.deepEqual(t.keys(), ["a", "e"]);
  // The pinned key's own replacement needs no room beside it.
  assert.equal(t.c.fits("a", 30), true);
  assert.equal(t.c.put("a", "A2", 30), true);
  assert.deepEqual(t.keys(), ["a"]);
  // By count: one place beside the pinned one.
  const n = setup(1000, 1);
  n.c.put("a", "A", 1);
  n.c.pinned = "a";
  assert.equal(n.c.put("b", "B", 1), false);
  assert.deepEqual(n.keys(), ["a"]);
});

test("take removes without dropping", () => {
  const t = setup(30);
  t.c.put("a", "A", 10);
  assert.deepEqual(t.c.take("a"), { value: "A", bytes: 10 });
  assert.equal(t.c.take("a"), undefined);
  assert.deepEqual(t.dropped, []);
  assert.equal(t.c.bytes, 0);
});

test("a smaller cap drops the oldest down to it, the pinned one last and only if it must", () => {
  const t = setup(40);
  for (const k of ["a", "b", "c", "d"]) t.c.put(k, k.toUpperCase(), 10);
  t.c.pinned = "a";
  t.c.setCap({ bytes: 20, count: 99 });
  assert.deepEqual(t.dropped, ["b=B", "c=C"]);
  assert.deepEqual(t.keys(), ["a", "d"]);
  t.c.setCap({ bytes: 20, count: 99 }); // unchanged: nothing
  assert.deepEqual(t.keys(), ["a", "d"]);
  t.c.setCap({ bytes: 10, count: 99 });
  assert.deepEqual(t.keys(), ["a"]);
  t.c.setCap({ bytes: 0, count: 0 }); // the switch off: the pinned one too
  assert.deepEqual(t.dropped, ["b=B", "c=C", "d=D", "a=A"]);
  assert.equal(t.c.size, 0);
  assert.equal(t.c.bytes, 0);
  assert.deepEqual(t.c.cap, { bytes: 0, count: 0 });
});

test("clear drops every picture; forget drops none", () => {
  const t = setup(30);
  t.c.put("a", "A", 10);
  t.c.put("b", "B", 10);
  t.c.clear();
  assert.deepEqual(t.dropped, ["a=A", "b=B"]);
  assert.equal(t.c.bytes, 0);
  t.c.put("c", "C", 10);
  t.c.forget();
  assert.deepEqual(t.dropped, ["a=A", "b=B"]);
  assert.equal(t.c.size, 0);
  assert.equal(t.c.bytes, 0);
});

test("the budget: nothing with the switch off, less on a weak device, by bytes everywhere", () => {
  const full = { on: true, tier: "full" as const, phone: false, lowMemory: false };
  assert.deepEqual(lidCacheBudget({ ...full, on: false }), { bytes: 0, count: 0 });
  const desktop = lidCacheBudget(full);
  const phone = lidCacheBudget({ ...full, phone: true });
  const light = lidCacheBudget({ ...full, tier: "light" });
  const minimal = lidCacheBudget({ ...full, tier: "minimal", phone: true });
  const lowMemory = lidCacheBudget({ ...full, phone: true, lowMemory: true });
  assert.deepEqual(desktop, { bytes: 64 * MIB, count: 4 });
  assert.deepEqual(phone, { bytes: 24 * MIB, count: 4 });
  assert.deepEqual(light, { bytes: 12 * MIB, count: 2 });
  assert.deepEqual(minimal, light);
  assert.deepEqual(lowMemory, light);
  // What that holds: a weak device its lid and one more at 1024 px; a phone
  // four at 1024 or two at 1280; a desktop three at 2048, never a 4096.
  const fit = (b: { bytes: number; count: number }, px: number) =>
    Math.min(b.count, Math.floor(b.bytes / lidTextureBytes(px, px)));
  assert.equal(fit(light, 1024), 2);
  assert.equal(fit(phone, 1024), 4);
  assert.equal(fit(phone, 1280), 2);
  assert.equal(fit(desktop, 2048), 3);
  assert.equal(fit(desktop, 1024), 4);
  assert.equal(fit(desktop, 4096), 0);
});
