// The tap-answer probe's logic (tapAnswerCore.ts), run with
// `node --import tsx --test` (root "test:scripts") against fake events, a fake
// clock and a fake frame: the target's kind from the rules, the start at the
// pointer event's own time, the end at the frame painted after the answer,
// one answer per tap, a drag and a late answer left out, a keyboard click, the
// counts by kind.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ANSWER_WINDOW_MS, TAP_SLOP_PX, createTapAnswer, tapKind } from "./tapAnswerCore";

/** An element that matches the selectors given (itself or an ancestor). */
const el = (...selectors: string[]) => ({
  closest: (s: string) => (selectors.includes(s) ? {} : null),
});

const RULES = [
  { kind: "canvas", selector: ".mapboxgl-canvas" },
  { kind: "pin", selector: ".geo-pin-leaf" },
  { kind: "pill", selector: ".geo-pin" },
  { kind: "row", selector: ".unit-row" },
];

function setup() {
  let now = 0;
  const begun: { id: string; detail: Record<string, unknown>; t0: number }[] = [];
  const ended: { id: string; at: number }[] = [];
  const frames: (() => void)[] = [];
  const probe = createTapAnswer({
    now: () => now,
    nextPaint: (done) => void frames.push(done),
    begin: (id, detail, t0) => void begun.push({ id, detail, t0 }),
    end: (id) => void ended.push({ id, at: now }),
  });
  probe.addRules(RULES);
  return {
    probe,
    begun,
    ended,
    at(t: number) {
      now = t;
    },
    /** The next frame is painted at `t`. */
    paint(t: number) {
      now = t;
      for (const f of frames.splice(0)) f();
    },
    /** A press at `t`, a release `press` ms later at (dx, 0) from it, then the click. */
    tap(target: unknown, t: number, { press = 80, dx = 0, pointerType = "touch", id = 1 } = {}) {
      now = t;
      probe.onPointerDown({ timeStamp: t, target, clientX: 100, clientY: 100, pointerId: id });
      const up = t + press;
      // The handlers run a little after the event's own time.
      now = up + 4;
      probe.onPointerUp({
        timeStamp: up,
        target,
        clientX: 100 + dx,
        clientY: 100,
        pointerId: id,
        pointerType,
      });
      probe.onClick({ timeStamp: up + 1, target });
      return up;
    },
  };
}

test("a target's kind is the first rule matching it or an ancestor", () => {
  assert.equal(tapKind(el(".mapboxgl-canvas"), RULES), "canvas");
  assert.equal(tapKind(el(".geo-pin-leaf", ".geo-pin"), RULES), "pin");
  assert.equal(tapKind(el(".geo-pin"), RULES), "pill");
  assert.equal(tapKind(el(".unit-row"), RULES), "row");
  assert.equal(tapKind(el(".crumb"), RULES), null);
  assert.equal(tapKind(null, RULES), null);
  assert.equal(tapKind({}, RULES), null); // the document, a text node
});

test("from the release's own time to the frame painted after the answer", () => {
  const { probe, begun, ended, tap, at, paint } = setup();
  const up = tap(el(".unit-row"), 1000);
  at(up + 12);
  assert.equal(probe.answered("fr-84", { via: "activate" }), true);
  assert.deepEqual(begun, [
    {
      id: "fr-84",
      t0: up,
      detail: { via: "activate", target: "row", pointer: "touch", pressMs: 80, answerMs: 12 },
    },
  ]);
  assert.deepEqual(ended, []);
  paint(up + 30);
  assert.deepEqual(ended, [{ id: "fr-84", at: up + 30 }]);
  assert.deepEqual(probe.read(), { taps: { row: 1 }, answered: { row: 1 } });
});

test("each kind of target is told apart, and a tap elsewhere is other", () => {
  const { probe, begun, tap } = setup();
  let t = 1000;
  for (const [target, id] of [
    [el(".mapboxgl-canvas"), "a"],
    [el(".geo-pin-leaf", ".geo-pin"), "b"],
    [el(".geo-pin"), "c"],
    [el(".unit-row"), "d"],
    [el(".crumb"), "e"],
  ] as const) {
    tap(target, (t += 1000), { pointerType: "mouse" });
    probe.answered(id);
  }
  assert.deepEqual(
    begun.map((b) => b.detail.target),
    ["canvas", "pin", "pill", "row", "other"],
  );
  assert.equal(begun[0].detail.pointer, "mouse");
  // "other" is answered, never counted as a tap seen.
  assert.deepEqual(probe.read(), {
    taps: { canvas: 1, pin: 1, pill: 1, row: 1 },
    answered: { canvas: 1, pin: 1, pill: 1, row: 1, other: 1 },
  });
});

test("a tap is answered once, and a tap nothing answers only counts", () => {
  const { probe, begun, tap } = setup();
  tap(el(".geo-pin"), 1000);
  assert.equal(probe.answered("x"), true);
  assert.equal(probe.answered("y"), false);
  tap(el(".mapboxgl-canvas"), 3000); // the sea
  tap(el(".mapboxgl-canvas"), 5000);
  assert.equal(probe.answered("z"), true);
  assert.deepEqual(
    begun.map((b) => b.id),
    ["x", "z"],
  );
  assert.deepEqual(probe.read(), {
    taps: { pill: 1, canvas: 2 },
    answered: { pill: 1, canvas: 1 },
  });
});

test("an answer with no tap waiting is ignored: a selection the code made", () => {
  const { probe, begun } = setup();
  assert.equal(probe.answered("x"), false);
  assert.deepEqual(begun, []);
});

test("a drag is not a tap, and the click the browser sends after it is not one either", () => {
  const { probe, begun, tap } = setup();
  tap(el(".mapboxgl-canvas"), 1000, { dx: TAP_SLOP_PX + 1 });
  assert.equal(probe.answered("x"), false);
  assert.deepEqual(probe.read(), { taps: {}, answered: {} });
  // Within the slop it is one.
  tap(el(".mapboxgl-canvas"), 3000, { dx: TAP_SLOP_PX });
  assert.equal(probe.answered("x"), true);
  assert.equal(begun.length, 1);
});

test("a late answer is not the tap's, and a new press closes the tap before it", () => {
  const { probe, tap, at } = setup();
  const up = tap(el(".unit-row"), 1000);
  at(up + ANSWER_WINDOW_MS + 1);
  assert.equal(probe.answered("late"), false);
  const up2 = tap(el(".unit-row"), 20_000);
  at(up2 + ANSWER_WINDOW_MS);
  assert.equal(probe.answered("in time"), true);
  tap(el(".unit-row"), 40_000);
  probe.onPointerDown({ timeStamp: 41_000, target: el(".mapboxgl-canvas"), pointerId: 1 });
  assert.equal(probe.answered("old tap"), false);
});

test("a gesture the browser takes over, or another pointer's release, makes no tap", () => {
  const { probe, at } = setup();
  at(1000);
  probe.onPointerDown({ timeStamp: 1000, target: el(".unit-row"), pointerId: 1 });
  probe.onPointerCancel();
  assert.equal(probe.answered("x"), false);
  probe.onPointerDown({ timeStamp: 2000, target: el(".unit-row"), pointerId: 1 });
  at(2100);
  probe.onPointerUp({ timeStamp: 2090, target: el(".unit-row"), pointerId: 2 });
  assert.equal(probe.answered("x"), false);
});

test("a click no pointer made (the keyboard) is timed from the click", () => {
  const { probe, begun, at } = setup();
  at(5003);
  probe.onClick({ timeStamp: 5000, target: el(".unit-row") });
  at(5010);
  assert.equal(probe.answered("fr-84"), true);
  assert.deepEqual(begun, [
    { id: "fr-84", t0: 5000, detail: { target: "row", pointer: "none", answerMs: 10 } },
  ]);
  // A second keyboard click is a tap of its own.
  at(6001);
  probe.onClick({ timeStamp: 6000, target: el(".unit-row") });
  assert.equal(probe.answered("fr-11"), true);
  assert.deepEqual(probe.read(), { taps: { row: 2 }, answered: { row: 2 } });
});

test("an event time that is not on the page's clock falls back to the handler's", () => {
  const { probe, begun, at } = setup();
  at(1000);
  probe.onPointerDown({ timeStamp: 1_700_000_000_000, target: el(".unit-row"), pointerId: 1 });
  at(1080);
  probe.onPointerUp({ timeStamp: 1_700_000_000_080, target: el(".unit-row"), pointerId: 1 });
  probe.onClick({ timeStamp: 1_700_000_000_081, target: el(".unit-row") });
  at(1090);
  probe.answered("x");
  assert.equal(begun[0].t0, 1080);
  assert.equal(begun[0].detail.pressMs, 80);
  assert.equal(begun[0].detail.answerMs, 10);
});

test("the first rule of a kind is kept, and the counts reset", () => {
  const { probe, begun, tap } = setup();
  probe.addRules([
    { kind: "row", selector: ".other-row" },
    { kind: "crumb", selector: ".crumb" },
  ]);
  tap(el(".other-row"), 1000);
  probe.answered("a");
  tap(el(".crumb"), 3000);
  probe.answered("b");
  assert.deepEqual(
    begun.map((b) => b.detail.target),
    ["other", "crumb"],
  );
  probe.reset();
  assert.deepEqual(probe.read(), { taps: {}, answered: {} });
});
