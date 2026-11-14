// The cap on the ratio the maps draw at (pixelRatio.ts) against a stubbed
// window, run with `node --import tsx --test` (root "test:scripts"): nothing
// redefined without a cap; under one, the window's ratio capped, the screen's
// still read through the browser's own getter (a zoom, another monitor), and
// the screen pixels a canvas pixel covers; a property that cannot be
// redefined; no window at all.

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as { window?: unknown };

let n = 0;
const load = async () =>
  (await import(`./pixelRatio.ts?load=${++n}`)) as typeof import("./pixelRatio");

/** A window whose ratio is an accessor of its own, as browsers define it. */
function ownAccessorWindow(ratio: { now: number }, configurable = true) {
  const w = {};
  Object.defineProperty(w, "devicePixelRatio", {
    configurable,
    enumerable: true,
    get: () => ratio.now,
  });
  return w as { devicePixelRatio: number };
}

test("without a cap: both ratios are the window's, nothing is redefined", async () => {
  const ratio = { now: 3 };
  const w = ownAccessorWindow(ratio);
  const before = Object.getOwnPropertyDescriptor(w, "devicePixelRatio");
  g.window = w;
  const m = await load();
  assert.equal(m.nativePixelRatio(), 3);
  assert.equal(m.mapPixelRatio(), 3);
  assert.equal(m.screenPerMapPixel(), 1);
  ratio.now = 2;
  assert.equal(m.nativePixelRatio(), 2);
  assert.equal(m.mapPixelRatio(), 2);
  assert.deepEqual(Object.getOwnPropertyDescriptor(w, "devicePixelRatio"), before);
  // A window that says nothing usable: 1.
  for (const odd of [undefined, 0, -2, Number.NaN, "3"]) {
    g.window = { devicePixelRatio: odd };
    assert.equal(m.nativePixelRatio(), 1, String(odd));
    assert.equal(m.screenPerMapPixel(), 1, String(odd));
  }
});

test("a cap of 1.5 on a screen at 3: the window answers 1.5, the screen still reads 3", async () => {
  const ratio = { now: 3 };
  const w = ownAccessorWindow(ratio);
  g.window = w;
  const m = await load();
  assert.equal(m.capPixelRatio(1.5), true);
  assert.equal(w.devicePixelRatio, 1.5);
  assert.equal(m.mapPixelRatio(), 1.5);
  assert.equal(m.nativePixelRatio(), 3);
  assert.equal(m.screenPerMapPixel(), 2);
  // The screen's ratio moves (the browser's zoom, another monitor): followed.
  ratio.now = 2;
  assert.equal(w.devicePixelRatio, 1.5);
  assert.equal(m.nativePixelRatio(), 2);
  assert.equal(m.screenPerMapPixel(), 2 / 1.5);
  // A screen at or under the cap keeps its own ratio.
  ratio.now = 1;
  assert.equal(w.devicePixelRatio, 1);
  assert.equal(m.mapPixelRatio(), 1);
  assert.equal(m.screenPerMapPixel(), 1);
  ratio.now = 1.5;
  assert.equal(w.devicePixelRatio, 1.5);
  assert.equal(m.screenPerMapPixel(), 1);
  // A second call keeps the first cap.
  ratio.now = 3;
  assert.equal(m.capPixelRatio(2), true);
  assert.equal(w.devicePixelRatio, 1.5);
  // The property stays configurable and enumerable.
  const d = Object.getOwnPropertyDescriptor(w, "devicePixelRatio")!;
  assert.equal(d.configurable, true);
  assert.equal(d.enumerable, true);
});

test("a ratio held by the window's prototype, or as a plain value, is capped too", async () => {
  const proto = ownAccessorWindow({ now: 2.625 });
  const w = Object.create(proto) as { devicePixelRatio: number };
  g.window = w;
  const m = await load();
  assert.equal(m.capPixelRatio(1.5), true);
  assert.equal(w.devicePixelRatio, 1.5);
  assert.equal(m.nativePixelRatio(), 2.625);
  assert.equal(m.screenPerMapPixel(), 2.625 / 1.5);

  const plain = { devicePixelRatio: 2 };
  g.window = plain;
  const m2 = await load();
  assert.equal(m2.capPixelRatio(1.5), true);
  assert.equal(plain.devicePixelRatio, 1.5);
  assert.equal(m2.nativePixelRatio(), 2);
});

test("no cap where it cannot stand: the maps keep the screen's ratio", async () => {
  // A property that cannot be redefined.
  const locked = ownAccessorWindow({ now: 3 }, false);
  g.window = locked;
  const m = await load();
  assert.equal(m.capPixelRatio(1.5), false);
  assert.equal(locked.devicePixelRatio, 3);
  assert.equal(m.mapPixelRatio(), 3);
  assert.equal(m.screenPerMapPixel(), 1);
  // No ratio at all, or a limit that is no ratio.
  g.window = {};
  assert.equal((await load()).capPixelRatio(1.5), false);
  g.window = ownAccessorWindow({ now: 3 });
  const m3 = await load();
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(m3.capPixelRatio(bad), false, String(bad));
  }
  assert.equal(m3.mapPixelRatio(), 3);
  // No window (a worker, node).
  delete g.window;
  const m4 = await load();
  assert.equal(m4.capPixelRatio(1.5), false);
  assert.equal(m4.nativePixelRatio(), 1);
  assert.equal(m4.mapPixelRatio(), 1);
  assert.equal(m4.screenPerMapPixel(), 1);
});
