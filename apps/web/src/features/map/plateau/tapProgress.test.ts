// A tapped unit's progress (tapProgress.ts): the values of a warm and a cold
// tap on raised and on flat ground (the run's start a step of its own: no
// tap has a one-step line), 1 only when every counted requirement is in, the
// coarse fallback — a run that starts without the outline's file moves the
// line no further, whatever arrives, until a later run finds the file
// stored —, a value that never goes down, a line that nothing reopens once full, what a
// retry keeps and what a new tap resets. Run with `node --import tsx --test`
// (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTapProgress, type TapStep } from "./tapProgress";

const RELIEF = { key: true, mesh: true };
const FLAT = { key: false, mesh: true };
const near = (a: number | undefined, b: number) =>
  assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

function tracker(expect = RELIEF, id = "fr:reg:84") {
  const p = createTapProgress();
  p.begin(id, expect, false);
  const note = (step: TapStep) => p.note(id, step);
  return { p, note };
}

test("a warm tap on raised ground: a fifth at the run, two fifths at the key, 1 at the mesh", () => {
  const { p, note } = tracker();
  assert.equal(p.value(), 0);
  near(note({ t: "run", key: true, mesh: true })?.value, 0.2);
  near(note({ t: "key" })?.value, 0.4);
  assert.deepEqual(note({ t: "mesh" }), { value: 1, done: true });
});

test("the mesh before the key: four fifths, then 1", () => {
  const { note } = tracker();
  note({ t: "run", key: true, mesh: true });
  near(note({ t: "mesh" })?.value, 0.8);
  assert.deepEqual(note({ t: "key" }), { value: 1, done: true });
});

test("a warm tap on flat ground with the worker: two steps, a quarter at the run, 1 at the mesh; a run that needs nothing: 1 at once", () => {
  const flat = tracker(FLAT);
  near(flat.note({ t: "run", key: false, mesh: true })?.value, 0.25);
  assert.deepEqual(flat.note({ t: "mesh" }), { value: 1, done: true });
  const none = tracker({ key: false, mesh: false });
  assert.deepEqual(none.note({ t: "run", key: false, mesh: false }), { value: 1, done: true });
});

test("nothing needed and no run yet: 0, never NaN", () => {
  const { p, note } = tracker({ key: false, mesh: false });
  assert.equal(p.value(), 0);
  assert.equal(note({ t: "key" }), null);
  assert.equal(Number.isNaN(p.value()), false);
});

test("a cold tap on raised ground: the file's share, then stored, the run, the key, the mesh", () => {
  const { p, note } = tracker();
  assert.equal(note({ t: "outline", frac: 0 }), null); // cold, nothing in yet
  near(note({ t: "outline", frac: 0.3 })?.value, (6 * 0.3) / 11);
  near(note({ t: "outline", frac: 0.9 })?.value, 5.4 / 11);
  assert.equal(note({ t: "outline", frac: 0.95 }), null); // capped until it is stored
  near(note({ t: "outline", frac: 1 })?.value, 6 / 11);
  near(note({ t: "run", key: true, mesh: true })?.value, 7 / 11);
  near(note({ t: "key" })?.value, 8 / 11);
  assert.deepEqual(note({ t: "mesh" }), { value: 1, done: true });
  assert.equal(p.value(), 1);
});

test("before a run the denominator is what the tap expects", () => {
  const flat = tracker(FLAT);
  near(flat.note({ t: "outline", frac: 0.5 })?.value, (6 * 0.5) / 10);
  const bare = tracker({ key: false, mesh: false });
  near(bare.note({ t: "outline", frac: 0.5 })?.value, 3 / 7);
  // Stored with no run yet: the outline is in, the run is still to start.
  near(bare.note({ t: "outline", frac: 1 })?.value, 6 / 7);
});

test("the coarse fallback: a run without the outline's file moves the line no further, whatever arrives", () => {
  const { p, note } = tracker();
  near(note({ t: "outline", frac: 0.9 })?.value, 5.4 / 11);
  const held = 5.4 / 11;
  // The run starts on a coarser outline: the file the line measured has not
  // come. Nothing of that run is shown as progress, its verdict included.
  assert.equal(note({ t: "run", key: true, mesh: true }), null);
  assert.equal(p.waived(), true);
  assert.equal(p.state()?.waived, true);
  assert.equal(note({ t: "key" }), null);
  assert.equal(note({ t: "outline", frac: 0.95 }), null);
  assert.equal(note({ t: "mesh" }), null);
  assert.equal(note({ t: "settled" }), null);
  near(p.value(), held);
  assert.equal(p.state()?.stored, false);
});

test("the coarse fallback with nothing arrived (a starved link): the line stays at 0, never one jump to the end", () => {
  const flat = tracker(FLAT);
  assert.equal(flat.note({ t: "outline", frac: 0 }), null);
  assert.equal(flat.note({ t: "run", key: false, mesh: true }), null);
  assert.equal(flat.note({ t: "mesh" }), null);
  assert.equal(flat.p.value(), 0);
  assert.equal(flat.p.waived(), true);
  // A run that needs nothing, without the file: still nothing.
  const bare = tracker({ key: false, mesh: false });
  bare.note({ t: "outline", frac: 0.3 });
  assert.equal(bare.note({ t: "run", key: false, mesh: false }), null);
  near(bare.p.value(), (6 * 0.3) / 7);
});

test("a waived tap counts again once a later run finds the file stored (a retry)", () => {
  const { p, note } = tracker();
  note({ t: "outline", frac: 0.5 });
  assert.equal(note({ t: "run", key: true, mesh: true }), null);
  assert.equal(p.waived(), true);
  // The file lands after all: recorded, not shown yet.
  assert.equal(note({ t: "outline", frac: 1 }), null);
  assert.equal(p.state()?.stored, true);
  // The retry's run: the outline is in, the run has started.
  near(note({ t: "run", key: true, mesh: true })?.value, 7 / 11);
  assert.equal(p.waived(), false);
  near(note({ t: "key" })?.value, 8 / 11);
  assert.deepEqual(note({ t: "mesh" }), { value: 1, done: true });
  // No tap, no waiver.
  assert.equal(createTapProgress().waived(), false);
});

test("the value is monotone whatever the order of the steps", () => {
  const { p, note } = tracker();
  const steps: TapStep[] = [
    { t: "outline", frac: 0.4 },
    { t: "outline", frac: 0.2 },
    { t: "run", key: true, mesh: true },
    { t: "outline", frac: 0.6 },
    { t: "key" },
    { t: "run", key: true, mesh: true },
    { t: "mesh" },
    { t: "key" },
  ];
  let last = 0;
  for (const step of steps) {
    note(step);
    assert.ok(p.value() >= last, `${step.t}: ${p.value()} < ${last}`);
    assert.ok(p.value() <= 1);
    last = p.value();
  }
});

test("a new run asks for its own key and mesh: 1 waits for them", () => {
  const { p, note } = tracker();
  note({ t: "run", key: true, mesh: true });
  note({ t: "key" });
  note({ t: "run", key: true, mesh: true }); // superseding run
  near(note({ t: "mesh" })?.value, 0.8); // the new run's mesh: its key is out again
  assert.equal(p.value() < 1, true);
  assert.deepEqual(note({ t: "key" }), { value: 1, done: true });
});

test("a run after the line is full does not reopen it", () => {
  const { p, note } = tracker();
  note({ t: "run", key: true, mesh: true });
  note({ t: "key" });
  note({ t: "mesh" });
  assert.equal(note({ t: "run", key: true, mesh: true }), null);
  assert.equal(note({ t: "outline", frac: 0.2 }), null);
  assert.equal(note({ t: "settled" }), null);
  assert.equal(p.value(), 1);
});

test("the verdict fills the line whatever is still out; done is said once", () => {
  const { note } = tracker();
  note({ t: "run", key: true, mesh: true });
  assert.deepEqual(note({ t: "settled" }), { value: 1, done: true });
  assert.equal(note({ t: "settled" }), null);
});

test("again keeps the state, a new tap on the same unit resets it, another unit is ignored", () => {
  const p = createTapProgress();
  p.begin("a", RELIEF, false);
  p.note("a", { t: "outline", frac: 0.5 });
  near(p.value(), 3 / 11);
  assert.equal(p.note("b", { t: "key" }), null);
  p.begin("a", RELIEF, true); // « Réessayer »
  near(p.value(), 3 / 11);
  p.begin("b", RELIEF, true); // "again" for another unit: a new tap
  assert.equal(p.value(), 0);
  assert.equal(p.id(), "b");
  p.begin("b", RELIEF, false);
  assert.equal(p.value(), 0);
  p.end();
  assert.equal(p.id(), "");
  assert.equal(p.value(), 0);
  assert.equal(p.note("b", { t: "settled" }), null);
  assert.equal(p.state(), null);
});

test("a share that is no number counts for nothing", () => {
  const { p, note } = tracker();
  assert.equal(note({ t: "outline", frac: Number.NaN }), null);
  assert.equal(note({ t: "outline", frac: -3 }), null);
  near(note({ t: "outline", frac: 7 })?.value, 6 / 11);
  assert.equal(p.state()?.stored, true);
});
