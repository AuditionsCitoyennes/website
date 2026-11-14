// Which grey sheet is laid and which is on its way (tintCuts.ts), with a fake
// cutter answered by hand: cut here without one, laid as the answer lands
// with one, prepared ahead and laid in the call, superseded answers dropped,
// an empty answer cut here, the perf hooks. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no DOM, no alias.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTintCuts, sameGeoms } from "./tintCuts";
import type { MaskGeom, TintSheet } from "./tintSheet";

const geom = (): MaskGeom => ({ type: "Polygon", coordinates: [] });
const sheetOf = (n: number): TintSheet => ({ positions: new Float32Array(n * 2), origin: [n, n] });
const tick = () => new Promise((r) => setImmediate(r));

function rig(opts: { cutter?: boolean } = {}) {
  let live = opts.cutter ?? true;
  const asked: { geoms: readonly MaskGeom[]; answer: (s: TintSheet | null) => void }[] = [];
  const laid: { vertices: number; via: string }[] = [];
  const here: (readonly MaskGeom[])[] = [];
  let late = 0;
  const cutNotes: [number, number][] = [];
  const cuts = createTintCuts({
    cutter: () =>
      live
        ? (geoms) =>
            new Promise((resolve) =>
              asked.push({ geoms, answer: (s) => resolve(s ? { ...s, ms: 7 } : null) }),
            )
        : null,
    cutHere(geoms) {
      here.push(geoms);
      return sheetOf(geoms.length ? 100 + geoms.length : 0);
    },
    lay: (sheet, via) => laid.push({ vertices: sheet.positions.length / 2, via }),
    onLate: () => late++,
    onCut: (ms, vertices) => cutNotes.push([ms, vertices]),
  });
  return {
    cuts,
    asked,
    laid,
    here,
    late: () => late,
    cutNotes,
    setLive: (v: boolean) => (live = v),
  };
}

test("sameGeoms compares the geometry objects, in order", () => {
  const a = geom();
  const b = geom();
  assert.ok(sameGeoms([], []));
  assert.ok(sameGeoms([a, b], [a, b]));
  assert.ok(!sameGeoms([a, b], [b, a]));
  assert.ok(!sameGeoms([a], [a, b]));
  assert.ok(!sameGeoms([a], [geom()]));
});

test("without a cutter the sheet is cut here, in the call", () => {
  const r = rig({ cutter: false });
  const a = [geom()];
  assert.equal(r.cuts.select(a), true);
  assert.deepEqual(r.laid, [{ vertices: 101, via: "page" }]);
  assert.equal(r.cuts.laid(), a);
  // The same selection again: nothing.
  assert.equal(r.cuts.select(a), false);
  assert.equal(r.laid.length, 1);
  // Prepare does nothing without a cutter.
  r.cuts.prepare([geom()]);
  assert.equal(r.asked.length, 0);
  assert.equal(r.cuts.pending(), null);
  assert.equal(r.late(), 0);
});

test("no selection is laid at once, cutter or not, and drops a cut on its way", async () => {
  const r = rig({ cutter: false });
  // Nothing laid yet and nothing asked for: nothing to do.
  assert.equal(r.cuts.select([]), false);
  assert.deepEqual(r.laid, []);
  r.cuts.select([geom()]);
  r.setLive(true);
  assert.equal(r.cuts.select([geom()]), false);
  assert.equal(r.cuts.pending(), "wanted");
  assert.equal(r.cuts.select([]), true);
  assert.deepEqual(r.laid.at(-1), { vertices: 0, via: "page" });
  assert.equal(r.cuts.pending(), null);
  // The answer of the dropped cut lays nothing.
  r.asked[0].answer(sheetOf(5));
  await tick();
  assert.equal(r.laid.length, 2);
  assert.equal(r.late(), 0);
  assert.deepEqual(r.cutNotes, []);
});

test("with a cutter the sheet is laid as its answer lands, and onLate says so", async () => {
  const r = rig();
  const a = [geom()];
  assert.equal(r.cuts.select(a), false);
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0].geoms, a);
  // Asked again meanwhile (every pass of the plateau pipeline): one cut only.
  assert.equal(r.cuts.select(a), false);
  r.cuts.prepare(a);
  assert.equal(r.asked.length, 1);
  assert.deepEqual(r.laid, []);
  r.asked[0].answer(sheetOf(5));
  await tick();
  assert.deepEqual(r.laid, [{ vertices: 5, via: "worker" }]);
  assert.equal(r.late(), 1);
  assert.deepEqual(r.cutNotes, [[7, 5]]);
  assert.equal(r.cuts.laid(), a);
  assert.equal(r.cuts.pending(), null);
  assert.equal(r.here.length, 0);
  assert.equal(r.cuts.select(a), false);
  assert.equal(r.asked.length, 1);
});

test("a sheet prepared ahead is laid in the call that selects it", async () => {
  const r = rig();
  const a = [geom()];
  r.cuts.prepare(a);
  assert.equal(r.cuts.pending(), "ahead");
  r.asked[0].answer(sheetOf(9));
  await tick();
  assert.equal(r.cuts.pending(), "kept");
  assert.deepEqual(r.laid, []);
  assert.equal(r.late(), 0);
  assert.equal(r.cuts.select(a), true);
  assert.deepEqual(r.laid, [{ vertices: 9, via: "worker" }]);
  assert.equal(r.late(), 0, "laid in the call: not late");
  assert.equal(r.asked.length, 1);
});

test("a sheet prepared and selected before its answer is laid as it lands", async () => {
  const r = rig();
  const a = [geom()];
  r.cuts.prepare(a);
  assert.equal(r.cuts.select(a), false);
  assert.equal(r.cuts.pending(), "wanted");
  assert.equal(r.asked.length, 1);
  r.asked[0].answer(sheetOf(3));
  await tick();
  assert.deepEqual(r.laid, [{ vertices: 3, via: "worker" }]);
  assert.equal(r.late(), 1);
});

test("a newer selection drops the cut before it: its answer lays nothing", async () => {
  const r = rig();
  const a = [geom()];
  const b = [geom()];
  r.cuts.select(a);
  r.cuts.select(b);
  assert.equal(r.asked.length, 2);
  r.asked[0].answer(sheetOf(1));
  await tick();
  assert.deepEqual(r.laid, []);
  r.asked[1].answer(sheetOf(2));
  await tick();
  assert.deepEqual(r.laid, [{ vertices: 2, via: "worker" }]);
  assert.equal(r.cuts.laid(), b);
  assert.equal(r.late(), 1);
});

test("back to the selection laid: the cut on its way is kept, not laid", async () => {
  const r = rig({ cutter: false });
  const a = [geom()];
  const b = [geom()];
  r.cuts.select(a);
  r.setLive(true);
  assert.equal(r.cuts.select(b), false);
  assert.equal(r.cuts.select(a), false);
  assert.equal(r.cuts.pending(), "ahead");
  r.asked[0].answer(sheetOf(4));
  await tick();
  assert.equal(r.laid.length, 1, "a's sheet stays");
  assert.equal(r.cuts.laid(), a);
  assert.equal(r.cuts.pending(), "kept");
  // Selected after all: laid in the call, from what was kept.
  assert.equal(r.cuts.select(b), true);
  assert.deepEqual(r.laid.at(-1), { vertices: 4, via: "worker" });
});

test("an answer without a sheet: cut here if it is wanted, forgotten if it was only prepared", async () => {
  const r = rig();
  const a = [geom()];
  r.cuts.select(a);
  r.asked[0].answer(null);
  await tick();
  assert.deepEqual(r.laid, [{ vertices: 101, via: "page" }]);
  assert.deepEqual(r.here, [a]);
  assert.equal(r.late(), 1);
  assert.deepEqual(r.cutNotes, []);
  const b = [geom()];
  r.cuts.prepare(b);
  r.asked[1].answer(null);
  await tick();
  assert.equal(r.laid.length, 1);
  assert.equal(r.cuts.pending(), null);
  // Its select asks again (the cutter may answer now), or cuts here without one.
  r.setLive(false);
  assert.equal(r.cuts.select(b), true);
  assert.deepEqual(r.laid.at(-1), { vertices: 101, via: "page" });
});

test("the cutter gone between a prepare and its select: cut here, the kept answer unused", async () => {
  const r = rig();
  const a = [geom()];
  r.cuts.prepare(a);
  r.asked[0].answer(sheetOf(6));
  await tick();
  r.setLive(false);
  assert.equal(r.cuts.select(a), true);
  assert.deepEqual(r.laid, [{ vertices: 101, via: "page" }]);
  assert.equal(r.cuts.pending(), null);
});

test("drop forgets the cut on its way and cuts nothing", async () => {
  const r = rig();
  r.cuts.select([geom()]);
  r.cuts.drop();
  assert.equal(r.cuts.pending(), null);
  r.asked[0].answer(sheetOf(2));
  await tick();
  assert.deepEqual(r.laid, []);
  assert.deepEqual(r.here, []);
  assert.equal(r.late(), 0);
});
