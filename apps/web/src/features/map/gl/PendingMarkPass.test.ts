// The pending mark's pass (PendingMarkPass.ts), on a recording stand-in for
// the WebGL context, with a clock, timers and a deferred-task queue by hand:
// a held mark asks for ONE frame however many are drawn (a still map with a
// mark held stays idle); the line is neither built nor drawn at 0 and never
// shows more than its target; a step eases over a bounded number of frames,
// or jumps; the data all in, the fill fades and the gate falls to 0; the
// release rides the new lid; a large unit's meshes come from off the frame
// and join only while the mark still waits; nothing is rebuilt for the same
// geometry. Run with `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PendingMarkPass,
  type MarkBuffers,
  type MarkMotion,
  type PendingMarkSpec,
} from "./PendingMarkPass";
import {
  MARK_CREEP_FREEZE_MS,
  MARK_CREEP_TICK_MS,
  MARK_FADE_MS,
  MARK_GROUND_LINE_M,
  MARK_LINE_HOLD_CAP_MS,
  MARK_PAGE_MAX_VERTICES,
  MARK_REF_M,
  MARK_STEP_MS,
  MARK_UNFILL_MS,
  buildMark,
  fillThreshold,
  markLidLineM,
  type MarkGeometry,
  type MarkRegime,
} from "./pendingMark";
import { MARK_PROGRESS_FULL } from "./pendingMarkShaders";
import type { GlProg } from "./program";

const square = (x: number): MarkGeometry => ({
  type: "Polygon",
  coordinates: [
    [
      [x, 45],
      [x + 1, 45],
      [x + 1, 46],
      [x, 46],
      [x, 45],
    ],
  ],
});
/** A ring of more vertices than the page builds in a frame. */
const large = (): MarkGeometry => {
  const n = MARK_PAGE_MAX_VERTICES + 200;
  const ring: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((i % n) / n) * 2 * Math.PI;
    ring.push([4 + Math.cos(a), 45 + Math.sin(a)]);
  }
  return { type: "Polygon", coordinates: [ring] };
};
const spec = (over: Partial<PendingMarkSpec> = {}): PendingMarkSpec => ({
  id: "fr:dep:69",
  g: square(4),
  spanDeg: 1,
  line: true,
  fill: true,
  raised: false,
  lidM: 0,
  rgb: [0.141, 0.071, 0.431],
  creep: false,
  ...over,
});

const FULL: MarkMotion = {
  animate: true,
  stepMs: MARK_STEP_MS,
  unfillMs: MARK_UNFILL_MS,
  outMs: MARK_FADE_MS,
};
/** Short motion (a weak device): the line jumps, the fill's fade is shorter. */
const SHORT: MarkMotion = { animate: true, stepMs: 0, unfillMs: 47, outMs: MARK_FADE_MS };
/** Reduced motion: nothing fades. */
const STILL: MarkMotion = { animate: false, stepMs: 0, unfillMs: 0, outMs: MARK_FADE_MS };

/** A context that records the calls made on it; locations are their names. */
function fakeGl() {
  const calls: { name: string; args: unknown[] }[] = [];
  const gl = new Proxy(
    {},
    {
      get: (_t, name) =>
        typeof name === "string" && name === name.toUpperCase()
          ? name // a constant: its own name
          : (...args: unknown[]) => {
              calls.push({ name: String(name), args });
              if (name === "getUniformLocation" || name === "getAttribLocation") return args[1];
              if (name === "getProgramParameter") return true;
              return { made: String(name) };
            },
    },
  ) as unknown as WebGL2RenderingContext;
  const count = (name: string) => calls.filter((c) => c.name === name).length;
  /** The value last given to uniform `name` (a float). */
  const uniform = (name: string) =>
    calls.filter((c) => c.name === "uniform1f" && c.args[0] === name).at(-1)?.args[1] as
      number | undefined;
  return { gl, calls, count, uniform };
}

/** The layer's hover-fill program, which draws the flat fill. */
const fillProg = {
  prog: {},
  attr: { aPos: 0, aDist: 1, aMerc: 2, aEcefLo: 3, aEcefHi: 4 },
  uni: { uFillT: "uFillT", uScale: "uScale", uMatrix: "uMatrix" },
} as unknown as GlProg;
const MATRIX = new Float64Array(16);

function harness() {
  let t = 1000;
  let repaints = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const deferred: (() => void)[] = [];
  const filled: string[] = [];
  const pass = new PendingMarkPass({
    repaint: () => repaints++,
    onFill: (id) => filled.push(id),
    now: () => t,
    setTimer: (fn, ms) => {
      timers.set(nextTimer, { at: t + ms, fn });
      return nextTimer++;
    },
    clearTimer: (id) => void timers.delete(id as number),
    defer: (job) => void deferred.push(job),
    dpr: () => 1,
    // A program whose locations are their names (the real builder reads the
    // build's flags, which node has not).
    program: (_gl, _vs, _fs, attrs, unis) => ({
      prog: {} as WebGLProgram,
      attr: Object.fromEntries(attrs.map((a, i) => [a, 10 + i])),
      uni: Object.fromEntries(unis.map((u) => [u, u as unknown as WebGLUniformLocation])),
    }),
  });
  const g = fakeGl();
  pass.onAdd(g.gl);
  /** One mercator frame, as the layer draws it. */
  const frame = (rise = 1) => {
    pass.prepare(g.gl, "merc");
    pass.drawMercator(g.gl, MATRIX, rise, "fill", fillProg);
    pass.drawMercator(g.gl, MATRIX, rise, "line", null);
  };
  /** Time passes; the timers due run, in order. */
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      timers.delete(next[0]);
      t = next[1].at;
      next[1].fn();
    }
    t = end;
  };
  /** Frames every 16 ms for `ms`; how many of them asked for another. */
  const run = (ms: number, rise = 1) => {
    let asked = 0;
    for (let at = 0; at < ms; at += 16) {
      advance(16);
      const before = repaints;
      frame(rise);
      if (repaints > before) asked++;
    }
    return asked;
  };
  const binders = { setCommon: () => {}, bindTriple: () => {} };
  return {
    pass,
    ...g,
    frame,
    advance,
    run,
    binders,
    deferred,
    filled,
    timers,
    repaints: () => repaints,
    shown: () => pass.state()!.progress.shown,
  };
}

/** A provider whose builds are answered by hand. */
function provider(live = true) {
  const asks: { regime: MarkRegime; front: boolean; answer: (b: MarkBuffers | null) => void }[] =
    [];
  return {
    asks,
    live: () => live,
    build: (_g: MarkGeometry, regime: MarkRegime, front: boolean) =>
      new Promise<MarkBuffers | null>((answer) => asks.push({ regime, front, answer })),
  };
}
const settle = () => new Promise<void>((r) => setImmediate(r));

test("a held mark asks for one frame, and none for as long as it is drawn", () => {
  const { pass, frame, repaints, count } = harness();
  pass.set(spec());
  assert.equal(repaints(), 1);
  assert.equal(pass.active, true);
  assert.equal(pass.id, "fr:dep:69");
  for (let i = 0; i < 200; i++) frame();
  assert.equal(repaints(), 1); // a still map with a mark held stays idle
  assert.equal(count("drawArrays"), 200); // the fill, each frame
  assert.equal(count("bufferData"), 1); // the fill built and uploaded once
});

test("at progress 0 the line is neither built nor drawn; its first step builds it", () => {
  const { pass, frame, count, uniform } = harness();
  pass.set(spec());
  frame();
  assert.equal(count("drawArraysInstanced"), 0);
  assert.equal(pass.state()!.lineBytes, 0);
  pass.setProgress(0.25, SHORT);
  frame();
  assert.equal(count("drawArraysInstanced"), 1);
  assert.equal(pass.state()!.lineBytes, 4 * 8 * 4); // four segments, 32 bytes each
  assert.equal(uniform("uProgress"), 0.25);
  assert.equal(uniform("uWidth"), 3);
  // The corners once, the line's buffer once: three uploads with the fill's.
  assert.equal(count("bufferData"), 3);
});

test("a step eases over a bounded number of frames and never shows more than its target", () => {
  const h = harness();
  h.pass.set(spec());
  h.frame();
  h.pass.setProgress(0.6, FULL);
  const asked = h.run(400);
  assert.ok(asked >= 4 && asked <= Math.ceil(MARK_STEP_MS / 16), `${asked} frames asked`);
  const seen = h.calls
    .filter((c) => c.name === "uniform1f" && c.args[0] === "uProgress")
    .map((c) => c.args[1] as number);
  assert.ok(seen.length > 5);
  for (let i = 0; i < seen.length; i++) {
    assert.ok(seen[i] <= 0.6 + 1e-9, `${seen[i]} above the target`);
    if (i) assert.ok(seen[i] >= seen[i - 1], "never back");
  }
  assert.equal(seen.at(-1), 0.6);
  const before = h.repaints();
  for (let i = 0; i < 50; i++) h.frame();
  assert.equal(h.repaints(), before); // the ease over: a still map again
});

test("a step during an ease retargets it from what is shown; two steps before a frame make one ease", () => {
  const h = harness();
  h.pass.set(spec());
  h.frame();
  h.pass.setProgress(0.3, FULL);
  h.advance(50);
  h.frame();
  const mid = h.shown();
  assert.ok(mid > 0 && mid < 0.3);
  h.pass.setProgress(0.7, FULL);
  assert.equal(h.shown(), mid); // no jump at the retarget
  h.advance(MARK_STEP_MS);
  assert.equal(h.shown(), 0.7); // one ease from there, not two queued
  // Two steps in the same task: one ease to the last.
  h.pass.setProgress(0.8, FULL);
  h.pass.setProgress(0.9, FULL);
  h.advance(MARK_STEP_MS);
  assert.equal(h.shown(), 0.9);
  // A step back is ignored.
  h.pass.setProgress(0.5, FULL);
  assert.equal(h.pass.state()!.progress.target, 0.9);
});

test("short and reduced motion: the line jumps, one frame a step", () => {
  for (const motion of [SHORT, STILL]) {
    const h = harness();
    h.pass.set(spec());
    h.frame();
    const before = h.repaints();
    h.pass.setProgress(0.4, motion);
    assert.equal(h.repaints(), before + 1);
    assert.equal(h.shown(), 0.4);
    assert.equal(h.run(200), 0); // no frame asked beyond the step's own
  }
});

test("the data all in: the line is whole, the fill fades over a bounded time, the gate falls to 0", () => {
  const h = harness();
  h.pass.set(spec());
  h.frame();
  h.pass.setProgress(0.25, FULL);
  h.run(200);
  assert.equal(h.pass.gateMs(), 0); // not finished: no gate
  h.pass.finish(FULL, "then");
  assert.equal(h.pass.gateMs(), MARK_UNFILL_MS);
  assert.equal(h.pass.state()!.progress.target, 1);
  h.advance(40);
  h.frame();
  assert.equal(h.pass.gateMs(), MARK_UNFILL_MS - 40);
  const a = h.pass.state()!.fillAlpha;
  assert.ok(a > 0.6 && a < 0.7, `fill at ${a}`);
  assert.equal(h.uniform("uFillT"), fillThreshold(a));
  const asked = h.run(400);
  assert.ok(asked >= 4 && asked <= Math.ceil(MARK_UNFILL_MS / 16), `${asked} frames asked`);
  assert.equal(h.pass.gateMs(), 0);
  assert.equal(h.pass.state()!.fillAlpha, 0);
  assert.equal(h.uniform("uProgress"), MARK_PROGRESS_FULL); // the whole boundary
  assert.equal(h.pass.active, true); // the line holds until the rise
  const fills = h.count("drawArrays");
  const before = h.repaints();
  for (let i = 0; i < 50; i++) h.frame();
  assert.equal(h.count("drawArrays"), fills); // the fill is gone
  assert.equal(h.repaints(), before); // a full line on a still map: no frame
  // Once per mark.
  h.pass.finish(FULL, "then");
  assert.equal(h.pass.gateMs(), 0);
});

test("the gate is 0 for anything that is not a fill on screen under « then »", async () => {
  // No mark.
  assert.equal(harness().pass.gateMs(), 0);
  // No fill asked.
  const noFill = harness();
  noFill.pass.set(spec({ fill: false }));
  noFill.frame();
  noFill.pass.finish(FULL, "then");
  assert.equal(noFill.pass.gateMs(), 0);
  // A geometry no builder reads.
  const bad = harness();
  bad.pass.set(spec({ g: { type: "Polygon", coordinates: [] } }));
  bad.frame();
  bad.pass.finish(FULL, "then");
  assert.equal(bad.pass.gateMs(), 0);
  // A large unit's fill, not arrived.
  const late = harness();
  const p = provider();
  late.pass.setProvider(p);
  late.pass.set(spec({ g: large() }));
  late.frame();
  late.pass.finish(FULL, "then");
  assert.equal(late.pass.gateMs(), 0);
  // Reduced motion.
  const still = harness();
  still.pass.set(spec());
  still.frame();
  still.pass.finish(STILL, "then");
  assert.equal(still.pass.gateMs(), 0);
  still.frame();
  assert.equal(still.pass.state()!.fillAlpha, 0); // gone in one frame
  // « together ».
  const together = harness();
  together.pass.set(spec());
  together.frame();
  together.pass.finish(FULL, "together");
  assert.equal(together.pass.gateMs(), 0);
  assert.equal(together.pass.state()!.fillAlpha, 1); // the fill waits for the rise
});

test("the data in before any frame: the fill still shows and fades, the gate counts it", () => {
  const h = harness();
  h.pass.set(spec());
  h.pass.finish(SHORT, "then"); // no frame drawn since the tap
  assert.equal(h.pass.gateMs(), 47);
  h.advance(10);
  h.frame();
  assert.equal(h.count("drawArrays"), 1);
  assert.ok(h.pass.state()!.fillAlpha > 0.7);
});

test("after a blocked main thread: one frame shows the line at its target, the fill gone, in order", () => {
  const h = harness();
  h.pass.set(spec());
  h.frame();
  h.pass.setProgress(0.25, FULL);
  h.advance(300); // the thread was blocked past the ease
  const before = h.repaints();
  h.frame();
  assert.equal(h.shown(), 0.25);
  assert.equal(h.repaints(), before); // nothing left to animate
  h.pass.finish(FULL, "then");
  h.advance(300); // …and past the unfill
  assert.equal(h.pass.gateMs(), 0); // a timer's time, not a frame's
  h.frame();
  assert.equal(h.pass.state()!.fillAlpha, 0);
  assert.equal(h.shown(), 1);
});

test("the release rides the new lid and ends within its fade", () => {
  const h = harness();
  h.pass.set(spec());
  h.frame();
  h.pass.finish(FULL, "then");
  h.run(200);
  assert.ok(Math.abs(h.uniform("uScale")! - MARK_GROUND_LINE_M / MARK_REF_M) < 1e-12); // on the ground
  const uploads = h.count("bufferData");
  h.pass.release(2000, FULL);
  assert.equal(h.pass.state()!.phase, "released");
  h.advance(16);
  h.frame(0.5); // the plateau half up
  assert.ok(Math.abs(h.uniform("uScale")! - (markLidLineM(2000) * 0.5) / MARK_REF_M) < 1e-12);
  assert.ok(h.calls.some((x) => x.name === "disable" && x.args[0] === "DEPTH_TEST"));
  h.advance(16);
  h.frame(0); // never under where it stood on the ground
  assert.ok(Math.abs(h.uniform("uScale")! - MARK_GROUND_LINE_M / MARK_REF_M) < 1e-12);
  const asked = h.run(400);
  assert.ok(asked >= 3 && asked <= Math.ceil(MARK_FADE_MS / 16), `${asked} frames asked`);
  assert.equal(h.pass.active, false);
  assert.equal(h.count("bufferData"), uploads); // nothing rebuilt to move it
  const before = h.repaints();
  const drawn = h.count("drawArraysInstanced");
  for (let i = 0; i < 50; i++) h.frame();
  assert.equal(h.repaints(), before);
  assert.equal(h.count("drawArraysInstanced"), drawn);
});

test("« together »: the fill rides the lid and fades with the line", () => {
  const h = harness();
  h.pass.set(spec());
  h.frame();
  h.pass.finish(FULL, "together");
  h.pass.release(1500, FULL);
  h.advance(58);
  h.frame(0.3);
  const s = h.pass.state()!;
  assert.ok(s.fillAlpha > 0.4 && s.fillAlpha < 0.6);
  assert.ok(Math.abs(s.fillAlpha - s.lineAlpha) < 1e-9);
  h.run(300);
  assert.equal(h.pass.active, false);
});

test("reduced motion: the release switches the mark off at once", () => {
  const h = harness();
  h.pass.set(spec());
  h.frame();
  h.pass.finish(STILL, "then");
  h.pass.release(1500, STILL);
  assert.equal(h.pass.active, false);
  const drawn = h.count("drawArrays");
  h.frame();
  assert.equal(h.count("drawArrays"), drawn);
});

test("on the globe a mark draws in its own pass only: ground before the walls, raised after", () => {
  const h = harness();
  const draw = (raised: boolean) => {
    h.pass.prepare(h.gl, "globe");
    h.pass.drawGlobe(h.gl, h.binders, raised, 1, "fill", fillProg);
    h.pass.drawGlobe(h.gl, h.binders, raised, 1, "line", null);
  };
  h.pass.set(spec(), 0.5);
  draw(true);
  assert.equal(h.count("drawArrays") + h.count("drawArraysInstanced"), 0);
  draw(false);
  assert.equal(h.count("drawArrays"), 1);
  assert.equal(h.count("drawArraysInstanced"), 1);
  assert.equal(h.pass.state()!.lineBytes, 4 * 20 * 4); // the globe's records, 80 bytes each
  // Released: its plateau rises — the raised pass from now.
  h.pass.finish(FULL, "together");
  h.pass.release(1500, FULL);
  draw(false);
  assert.equal(h.count("drawArraysInstanced"), 1);
  draw(true);
  assert.equal(h.count("drawArraysInstanced"), 2);
  // A child of a standing plateau: the raised pass from the tap.
  h.pass.set(spec({ raised: true, lidM: 1000 }), 0.5);
  draw(false);
  assert.equal(h.count("drawArraysInstanced"), 2);
  draw(true);
  assert.equal(h.count("drawArraysInstanced"), 3);
});

test("the last tap wins: a newer mark replaces the older in one repaint, with its own meshes", () => {
  const h = harness();
  h.pass.set(spec({ id: "a" }));
  h.frame();
  h.pass.set(spec({ id: "b", g: square(8) }));
  assert.equal(h.pass.id, "b");
  assert.equal(h.repaints(), 2);
  h.frame();
  assert.equal(h.count("bufferData"), 2); // b's fill built for its first frame
});

test("the same geometry again: nothing is rebuilt, and a retry's line starts where its data had come", () => {
  const h = harness();
  const g = square(4);
  h.pass.set(spec({ g }));
  h.frame();
  h.pass.setProgress(0.54, SHORT);
  h.frame();
  const uploads = h.count("bufferData");
  h.pass.drain(FULL);
  h.run(300);
  assert.equal(h.pass.active, false);
  h.pass.set(spec({ g }), 0.54); // « Réessayer »
  h.frame();
  assert.equal(h.count("bufferData"), uploads);
  assert.equal(h.uniform("uProgress"), 0.54); // at once: no ease from 0
  assert.equal(h.pass.state()!.fillAlpha, 1);
});

test("drain: the mark fades where it stands, frames asked only until it is gone", () => {
  const h = harness();
  h.pass.set(spec());
  h.frame();
  h.pass.setProgress(0.3, SHORT);
  h.frame();
  const uploads = h.count("bufferData");
  h.pass.drain(FULL);
  assert.equal(h.pass.state()!.phase, "draining");
  h.pass.drain(FULL); // fading already: not started over
  const asked = h.run(400);
  assert.ok(asked >= 3 && asked <= Math.ceil(MARK_FADE_MS / 16), `${asked} frames asked`);
  assert.equal(h.count("bufferData"), uploads);
  assert.equal(h.pass.active, false);
  assert.equal(h.pass.gateMs(), 0);
  // A verdict after a late wait finds no mark.
  h.pass.finish(FULL, "then");
  h.pass.release(1000, FULL);
  assert.equal(h.pass.active, false);
});

test("drain under reduced motion, or with no mark: at once, or nothing", () => {
  const h = harness();
  h.pass.drain(FULL);
  assert.equal(h.repaints(), 0);
  h.pass.set(spec());
  h.pass.drain(STILL);
  assert.equal(h.pass.active, false);
  assert.equal(h.repaints(), 2);
});

test("clear: no mark, one repaint, nothing kept; a second clear asks for nothing", () => {
  const h = harness();
  const g = square(4);
  h.pass.set(spec({ g }));
  h.frame();
  h.pass.clear();
  assert.equal(h.repaints(), 2);
  h.pass.clear();
  assert.equal(h.repaints(), 2);
  h.frame();
  assert.equal(h.count("drawArrays"), 1);
  assert.equal(h.pass.state(), null);
  h.pass.set(spec({ g }));
  h.frame();
  assert.equal(h.count("bufferData"), 2); // built again: nothing was kept
});

test("forget: the kept meshes go once the mark is over, not while it fades", () => {
  const h = harness();
  const g = square(4);
  h.pass.set(spec({ g }));
  h.frame();
  h.pass.finish(FULL, "then");
  h.pass.release(1000, FULL);
  h.pass.forget(); // the pending state ended while the line fades
  h.advance(16);
  h.frame();
  assert.equal(h.pass.active, true);
  assert.ok(h.pass.state()!.fillBytes > 0);
  h.run(300);
  assert.equal(h.pass.active, false);
  const uploads = h.count("bufferData");
  h.pass.set(spec({ g }));
  h.frame();
  assert.equal(h.count("bufferData"), uploads + 1); // the fill, built again
});

test("nothing asked for: no mark at all", () => {
  const h = harness();
  h.pass.set(spec({ line: false, fill: false }));
  assert.equal(h.pass.active, false);
});

test("a geometry no builder reads: given up, never retried, never thrown", () => {
  const h = harness();
  h.pass.set(spec({ g: { type: "Polygon", coordinates: [] } }), 0.5);
  for (let i = 0; i < 5; i++) h.frame();
  assert.equal(h.count("drawArrays"), 0);
  assert.equal(h.count("drawArraysInstanced"), 0);
  assert.equal(h.count("bufferData"), 0);
});

test("a large unit: nothing is built in the tap's frame; its meshes come from the provider and join", async () => {
  const h = harness();
  const p = provider();
  h.pass.setProvider(p);
  const g = large();
  h.pass.set(spec({ g }), 0.3);
  assert.equal(h.pass.fillAtOnce("merc"), false);
  h.frame();
  assert.equal(h.count("bufferData"), 0);
  assert.equal(h.count("drawArrays"), 0);
  assert.deepEqual(
    p.asks.map((a) => [a.regime, a.front]),
    [["merc", true]],
  );
  h.frame(); // asked once
  assert.equal(p.asks.length, 1);
  h.advance(20);
  const before = h.repaints();
  p.asks[0].answer(buildMark(g, "merc"));
  await settle();
  assert.equal(h.repaints(), before + 1); // one repaint for the arrival
  assert.deepEqual(h.filled, ["fr:dep:69"]);
  h.frame();
  assert.equal(h.count("drawArrays"), 1);
  assert.equal(h.count("drawArraysInstanced"), 1); // the line came with it
  const s = h.pass.state()!;
  assert.equal(s.fillVia, "worker");
  assert.equal(s.fillLateMs, 20);
  assert.equal(h.pass.ownsFill("merc"), true);
  // The other regime, should the projection change: asked behind the builds.
  h.pass.prepare(h.gl, "globe");
  assert.deepEqual(
    p.asks.map((a) => [a.regime, a.front]),
    [
      ["merc", true],
      ["globe", false],
    ],
  );
});

test("a large unit's meshes are asked at the tap itself when the regime is known, once", () => {
  const h = harness();
  const p = provider();
  h.pass.setProvider(p);
  h.pass.set(spec({ g: large() }), 0, "merc");
  assert.equal(p.asks.length, 1); // before any frame
  assert.equal(p.asks[0].front, true);
  h.frame();
  assert.equal(p.asks.length, 1);
  // A small unit is the frame's: nothing asked.
  const small = harness();
  const q = provider();
  small.pass.setProvider(q);
  small.pass.set(spec(), 0, "merc");
  small.frame();
  assert.equal(q.asks.length, 0);
});

test("a large unit with no provider, or one that gives nothing: built in a task after the frame", async () => {
  for (const withProvider of [false, true]) {
    const h = harness();
    const p = provider();
    if (withProvider) h.pass.setProvider(p);
    h.pass.set(spec({ g: large() }));
    h.frame();
    if (withProvider) {
      assert.equal(h.deferred.length, 0);
      p.asks[0].answer(null);
      await settle();
    }
    assert.equal(h.deferred.length, 1);
    assert.equal(h.count("bufferData"), 0); // not in the frame
    h.deferred[0]();
    h.frame();
    assert.equal(h.count("drawArrays"), 1);
    assert.equal(h.pass.state()!.fillVia, "deferred");
  }
  // A provider that is not live is not asked.
  const h = harness();
  const dead = provider(false);
  h.pass.setProvider(dead);
  h.pass.set(spec({ g: large() }));
  h.frame();
  assert.equal(dead.asks.length, 0);
  assert.equal(h.deferred.length, 1);
});

test("a fill that lands after the data was all in, the drain, a clear or a newer mark does not join", async () => {
  const g = large();
  const arrive = async (act: (h: ReturnType<typeof harness>) => void) => {
    const h = harness();
    const p = provider();
    h.pass.setProvider(p);
    h.pass.set(spec({ g }), 0.3);
    h.frame();
    act(h);
    p.asks[0].answer(buildMark(g, "merc"));
    await settle();
    h.frame();
    return h;
  };
  const finished = await arrive((h) => h.pass.finish(FULL, "then"));
  assert.equal(finished.count("drawArrays"), 0); // no fill
  assert.equal(finished.count("drawArraysInstanced"), 1); // the line, whole
  assert.equal(finished.pass.gateMs(), 0);
  assert.deepEqual(finished.filled, []);
  assert.equal(finished.pass.ownsFill("merc"), false);
  const drained = await arrive((h) => h.pass.drain(FULL));
  assert.equal(drained.count("drawArrays"), 0);
  // …but it is kept: a retry draws it in its first frame.
  drained.run(300);
  drained.pass.set(spec({ g }), 0.3);
  assert.equal(drained.pass.fillAtOnce("merc"), true);
  drained.frame();
  assert.equal(drained.count("drawArrays"), 1);
  const cleared = await arrive((h) => h.pass.clear());
  assert.equal(cleared.count("bufferData"), 0);
  const replaced = await arrive((h) => h.pass.set(spec({ id: "b", g: square(8) })));
  assert.equal(replaced.pass.state()!.fillVerts, 6); // b's own square, not the large unit
});

test("a full line whose plateau never rises is cleared by a timer, not by a frame", () => {
  const h = harness();
  h.pass.set(spec());
  h.frame();
  h.pass.finish(FULL, "then");
  h.run(200);
  h.advance(MARK_LINE_HOLD_CAP_MS - 100);
  assert.equal(h.pass.active, true);
  h.advance(MARK_UNFILL_MS);
  assert.equal(h.pass.active, false);
  assert.equal(h.timers.size, 0);
});

test("the creep: a tick asks for a frame unless one was drawn, never past its ceiling, and stops", () => {
  const h = harness();
  h.pass.set(spec({ creep: true }));
  h.frame();
  h.pass.setProgress(0.25, FULL);
  h.frame();
  // A second of waiting on a still map: about ten frames asked, by the ticks.
  // (The map draws a frame only when one is asked.)
  let before = h.repaints();
  for (let i = 0; i < 10; i++) {
    const was = h.repaints();
    h.advance(MARK_CREEP_TICK_MS);
    if (h.repaints() > was) h.frame();
  }
  const asked = h.repaints() - before;
  assert.ok(asked >= 9 && asked <= 11, `${asked} frames asked in a second`);
  const at1s = h.shown();
  assert.ok(at1s > 0.25 && at1s < 0.625, `shown ${at1s}`);
  // A map that draws frames of its own (a flight): the ticks ask for none.
  before = h.repaints();
  for (let i = 0; i < 50; i++) {
    h.advance(20);
    h.frame();
  }
  assert.equal(h.repaints(), before);
  // Past the freeze: no tick left, no frame asked, the value at rest.
  h.advance(MARK_CREEP_FREEZE_MS);
  h.frame();
  const rest = h.shown();
  assert.ok(rest < 0.625);
  before = h.repaints();
  h.advance(5000);
  h.frame();
  assert.equal(h.repaints(), before);
  assert.equal(h.shown(), rest);
  assert.equal(h.timers.size, 0);
  // A real step under what is shown does not pull the line back.
  h.pass.setProgress(0.3, FULL);
  assert.ok(h.shown() >= rest);
  // The data all in: no creep any more, the line goes to the end.
  h.pass.finish(FULL, "then");
  h.advance(MARK_STEP_MS);
  assert.equal(h.shown(), 1);
});

test("the mark never writes depth, hands the frame back tested and written, and unbinds its vertex array", () => {
  const h = harness();
  h.pass.set(spec(), 0.5);
  h.frame();
  const masks = h.calls.filter((x) => x.name === "depthMask").map((x) => x.args[0]);
  assert.deepEqual(masks, [false, true, false, true]); // the fill's draw, the line's
  assert.deepEqual(h.calls.at(-1), { name: "enable", args: ["DEPTH_TEST"] });
  const binds = h.calls.filter((x) => x.name === "bindVertexArray").map((x) => x.args[0]);
  assert.equal(binds.length, 2);
  assert.notEqual(binds[0], null);
  assert.equal(binds[1], null); // the default one again on the way out
  // The instanced attributes live in the pass's own vertex array: set between the two binds.
  const names = h.calls.map((x) => x.name);
  const first = names.indexOf("bindVertexArray");
  const last = names.lastIndexOf("bindVertexArray");
  const divisors = names.flatMap((n, i) => (n === "vertexAttribDivisor" ? [i] : []));
  assert.equal(divisors.length, 3); // the two ends and the lengths
  for (const i of divisors) assert.ok(i > first && i < last);
});

test("a context given back: the meshes are uploaded again", () => {
  const h = harness();
  h.pass.set(spec(), 0.5);
  h.frame();
  assert.equal(h.count("bufferData"), 3);
  h.pass.onRemove(h.gl);
  h.pass.onAdd(h.gl);
  h.frame();
  assert.equal(h.count("bufferData"), 6);
  assert.equal(h.pass.state(true)!.linked, true);
});
