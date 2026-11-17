// The pending mark's pass (PendingMarkPass.ts), on a recording stand-in for
// the WebGL context, with a clock, timers and a deferred-task queue by hand:
// a held mark asks for ONE frame however many are drawn (a still map with a
// mark held stays idle); the line is built with the fill, not drawn at 0 and
// never shows more than its target; a step eases over a bounded number of
// frames, or jumps; the data all in, the line first, then the fill fades and
// the gate falls to 0 (reduced motion: two plain steps, each held); the
// release rides the new lid; a large unit is filled with a stand-in in the
// tap's frame, its real meshes come from off the frame and take its place,
// and are never built for a mark that can no longer show them; a fill still
// fading when the other regime is first drawn fades on there; the creep's
// lead is small, bounded, and rides on top of the real value; nothing is
// rebuilt for the same geometry; dropped meshes leave the GPU. Run with
// `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type MarkRiseEta,
  PendingMarkPass,
  type MarkBuffers,
  type MarkMotion,
  type PendingMarkSpec,
} from "./PendingMarkPass";
import {
  G_MARK_LINE_FLOATS,
  MARK_CREEP_FREEZE_MS,
  MARK_CREEP_LEAD,
  MARK_CREEP_TICK_MS,
  MARK_CREEP_TICK_SHORT_MS,
  MARK_FADE_MS,
  MARK_FILL_SHARE,
  MARK_GROUND_LINE_M,
  MARK_LINE_FLOATS,
  MARK_LINE_HOLD_CAP_MS,
  MARK_LINE_MIN_SHARE,
  MARK_LINE_WIDTH,
  MARK_PAGE_MAX_VERTICES,
  MARK_LINE_FULL_MS,
  MARK_LINE_SHOW_MS,
  MARK_REDUCED_GAP_MS,
  MARK_REDUCED_HOLD_MS,
  MARK_REF_M,
  MARK_SHORT_FRAME_MS,
  MARK_UNFILL_FLOOR,
  MARK_WHOLE_UNSEEN_MS,
  MARK_STANDIN_VERTICES,
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
/** Reduced motion: nothing eases, nothing fades. */
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
  const count = (name: string) =>
    name === "bufferData"
      ? // The uploads of a mesh: emptying a buffer (a size) is counted apart.
        calls.filter((c) => c.name === name && typeof c.args[1] !== "number").length
      : calls.filter((c) => c.name === name).length;
  /** The buffers emptied (bufferData with a size of 0). */
  const emptied = () => calls.filter((c) => c.name === "bufferData" && c.args[1] === 0).length;
  /** The value last given to uniform `name` (a float). */
  const uniform = (name: string) =>
    calls.filter((c) => c.name === "uniform1f" && c.args[0] === name).at(-1)?.args[1] as
      number | undefined;
  return { gl, calls, count, emptied, uniform };
}

/** The layer's hover-fill program, which draws the flat fill. */
const fillProg = {
  prog: {},
  attr: { aPos: 0, aDist: 1, aMerc: 2, aEcefLo: 3, aEcefHi: 4 },
  uni: { uFillT: "uFillT", uScale: "uScale", uMatrix: "uMatrix" },
} as unknown as GlProg;
const MATRIX = new Float64Array(16);

/** `startMs`: the clock's value at the start (the page's age). `rise`: the
 *  pass is told when the rise can start (`rise.eta`, changed at will). */
function harness(startMs = 1000, rise?: { eta: MarkRiseEta | null }) {
  let t = startMs;
  let repaints = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const deferred: (() => void)[] = [];
  const filled: string[] = [];
  const pass = new PendingMarkPass({
    repaint: () => repaints++,
    onFill: (id) => filled.push(id),
    ...(rise ? { riseEta: () => rise.eta } : {}),
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
  const frame = (rise = 1, zoom?: number) => {
    pass.prepare(g.gl, "merc", zoom);
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
    /** The delays, from now, of the timers armed. */
    timersIn: () => [...timers.values()].map((e) => e.at - t).sort((x, y) => x - y),
    repaints: () => repaints,
    now: () => t,
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
  assert.equal(count("bufferData"), 2); // the fill and the line, built and uploaded once
});

test("the line is built with the fill, in the first frame, and not drawn at progress 0", () => {
  const { pass, frame, count, uniform } = harness();
  pass.set(spec());
  frame();
  assert.equal(count("drawArraysInstanced"), 0);
  assert.equal(pass.state()!.lineBytes, 4 * MARK_LINE_FLOATS * 4); // four segments
  assert.equal(count("bufferData"), 2);
  pass.setProgress(0.25, SHORT);
  frame();
  assert.equal(count("drawArraysInstanced"), 1);
  assert.equal(uniform("uProgress"), 0.25);
  assert.equal(uniform("uWidth"), MARK_LINE_WIDTH);
  // The corners, at the line's first draw: three uploads in all, none later.
  assert.equal(count("bufferData"), 3);
  for (let i = 0; i < 20; i++) frame();
  assert.equal(count("bufferData"), 3);
});

test("a line alone (no fill asked) is built at its first progress", () => {
  const { pass, frame, count } = harness();
  pass.set(spec({ fill: false }));
  frame();
  assert.equal(pass.state()!.lineBytes, 0);
  assert.equal(count("bufferData"), 0);
  pass.setProgress(0.25, SHORT);
  frame();
  assert.equal(pass.state()!.lineBytes, 4 * MARK_LINE_FLOATS * 4);
  assert.equal(count("drawArraysInstanced"), 1);
});

test("the line is thinner around a unit small on screen (the camera's zoom of the frame)", () => {
  const { pass, frame, uniform } = harness();
  pass.set(spec({ spanDeg: 1 }), 0.5);
  frame(1, 5); // a 1° unit at zoom 5: 45 px wide
  assert.equal(uniform("uWidth"), MARK_LINE_WIDTH * MARK_LINE_MIN_SHARE);
  frame(1, 9); // 728 px wide
  assert.equal(uniform("uWidth"), MARK_LINE_WIDTH);
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

test("the data all in: the line first, then the fill fades over a bounded time, the gate falls to 0", () => {
  const h = harness();
  h.pass.set(spec());
  h.frame();
  h.pass.setProgress(0.25, FULL);
  h.run(200);
  assert.equal(h.pass.gateMs(), 0); // not finished: no gate
  h.pass.finish(FULL, "then");
  // The line's last ease, a frame to show it whole, then the fade.
  const gate = h.pass.gateMs();
  assert.ok(gate > MARK_STEP_MS + MARK_UNFILL_MS + 8, `gate ${gate}`);
  assert.ok(gate < MARK_STEP_MS + MARK_UNFILL_MS + 30, `gate ${gate}`);
  assert.equal(h.pass.state()!.progress.target, 1);
  // The violet is whole while the line eases, and in the frame that first
  // shows the whole line.
  let wholeFrame = -1;
  for (let i = 0; i < 12 && wholeFrame < 0; i++) {
    h.advance(16);
    h.frame();
    const s = h.pass.state()!;
    assert.equal(s.fillAlpha, 1);
    if (s.progress.shown >= 1) wholeFrame = i;
  }
  assert.ok(wholeFrame >= 5, `whole at frame ${wholeFrame}`);
  assert.equal(h.pass.gateMs(), MARK_UNFILL_MS); // the fade starts after that frame
  h.advance(40);
  h.frame();
  assert.equal(h.pass.gateMs(), MARK_UNFILL_MS - 40);
  const a = h.pass.state()!.fillAlpha;
  assert.ok(Math.abs(a - (1 - 40 / MARK_UNFILL_MS)) < 1e-9, `fill at ${a}`); // linear
  assert.equal(h.uniform("uFillT"), fillThreshold(a));
  assert.equal(h.shown(), 1); // the line whole while the violet thins
  const asked = h.run(400);
  assert.ok(asked >= 2 && asked <= Math.ceil(MARK_UNFILL_MS / 16), `${asked} frames asked`);
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

test("the gate is 0 for anything that is not a line to show whole or a fill on screen under « then »", async () => {
  // No mark.
  assert.equal(harness().pass.gateMs(), 0);
  // No fill asked: the whole line is shown, and nothing more is waited for.
  const noFill = harness();
  noFill.pass.set(spec({ fill: false }));
  noFill.frame();
  noFill.pass.finish(FULL, "then");
  assert.ok(noFill.pass.gateMs() > MARK_STEP_MS);
  assert.ok(noFill.pass.gateMs() < MARK_STEP_MS + 30);
  noFill.run(200);
  assert.equal(noFill.pass.gateMs(), 0);
  // A geometry no builder reads.
  const bad = harness();
  bad.pass.set(spec({ g: { type: "Polygon", coordinates: [] } }));
  bad.frame();
  bad.pass.finish(FULL, "then");
  bad.run(200);
  assert.equal(bad.pass.gateMs(), 0);
  // « together »: the whole line shown, the fill left for the rise.
  const together = harness();
  together.pass.set(spec());
  together.frame();
  together.pass.finish(FULL, "together");
  assert.ok(together.pass.gateMs() > MARK_STEP_MS);
  together.run(200);
  assert.equal(together.pass.gateMs(), 0);
  assert.equal(together.pass.state()!.fillAlpha, 1); // the fill waits for the rise
  // A whole line no frame ever shows (a hidden tab) is waited for a bounded time.
  const blind = harness();
  blind.pass.set(spec());
  blind.frame();
  blind.pass.finish(FULL, "together");
  blind.advance(MARK_STEP_MS + MARK_WHOLE_UNSEEN_MS);
  assert.equal(blind.pass.gateMs(), 0);
});

test("reduced motion: the end is two plain steps — the line whole over the fill, then the fill gone — and the gate covers both", () => {
  const h = harness();
  h.pass.set(spec());
  h.frame();
  h.pass.setProgress(0.4, STILL);
  h.frame();
  let before = h.repaints();
  h.pass.finish(STILL, "then");
  assert.equal(h.repaints(), before + 1);
  // The first step: the line whole, at once, the violet still there.
  h.frame();
  assert.equal(h.pass.gateMs(), MARK_REDUCED_HOLD_MS + MARK_REDUCED_GAP_MS);
  assert.equal(h.shown(), 1);
  assert.equal(h.uniform("uProgress"), MARK_PROGRESS_FULL);
  assert.equal(h.pass.state()!.fillAlpha, 1);
  assert.equal(h.uniform("uFillT"), fillThreshold(1)); // never a partial opacity
  // Held: no frame asked while nothing changes.
  before = h.repaints();
  h.advance(MARK_REDUCED_HOLD_MS - 1);
  h.frame();
  assert.equal(h.repaints(), before);
  assert.equal(h.pass.state()!.fillAlpha, 1);
  // The second step, by a timer: the fill gone in one frame, the line whole.
  h.advance(1);
  assert.equal(h.repaints(), before + 1);
  const fills = h.count("drawArrays");
  h.frame();
  assert.equal(h.count("drawArrays"), fills);
  assert.equal(h.pass.state()!.fillAlpha, 0);
  assert.equal(h.pass.gateMs(), MARK_REDUCED_GAP_MS); // seen unfilled before it rises
  assert.equal(h.pass.active, true);
  h.advance(MARK_REDUCED_GAP_MS);
  assert.equal(h.pass.gateMs(), 0);
  // The rise: the mark goes at once.
  before = h.repaints();
  h.pass.release(1500, STILL);
  assert.equal(h.pass.active, false);
  h.advance(10_000);
  assert.equal(h.timers.size, 0);
  // « together »: no step of its own; the whole line shown, then no gate.
  const together = harness();
  together.pass.set(spec());
  together.frame();
  together.pass.finish(STILL, "together");
  together.frame();
  assert.equal(together.pass.gateMs(), 0);
  assert.equal(together.pass.state()!.fillAlpha, 1);
});

test("the data in before any frame: the fill still shows and fades, the gate counts it", () => {
  const h = harness();
  h.pass.set(spec());
  h.pass.finish(SHORT, "then"); // no frame drawn since the tap
  // The line jumps: a frame to show it whole, then the fade.
  assert.ok(Math.abs(h.pass.gateMs() - (16.7 + 47)) < 1e-9);
  h.advance(10);
  h.frame();
  assert.equal(h.count("drawArrays"), 1);
  assert.equal(h.pass.state()!.fillAlpha, 1);
  assert.equal(h.pass.gateMs(), 47);
});

test("a draining mark holds the rise for what is left of its fade, while its fill is on screen", () => {
  const h = harness();
  h.pass.set(spec());
  h.frame();
  h.pass.drain(FULL);
  assert.equal(h.pass.gateMs(), MARK_FADE_MS);
  h.advance(100);
  assert.equal(h.pass.gateMs(), MARK_FADE_MS - 100);
  h.advance(100);
  assert.equal(h.pass.gateMs(), 0);
  // Never drawn (no frame since the tap): nothing to wait for.
  const blind = harness();
  blind.pass.set(spec());
  blind.pass.drain(FULL);
  assert.equal(blind.pass.gateMs(), 0);
});

test("a regime first drawn once the violet is gone: the line alone is built, never the fill", () => {
  const h = harness();
  h.pass.set(spec(), 0.5);
  h.frame();
  h.pass.finish(SHORT, "then");
  h.run(200); // the fill has left; the line holds, full
  const uploads = h.count("bufferData");
  // The flight crosses zoom 6: the globe's first frame.
  h.pass.prepare(h.gl, "globe");
  h.pass.drawGlobe(h.gl, h.binders, false, 1, "fill", fillProg);
  h.pass.drawGlobe(h.gl, h.binders, false, 1, "line", null);
  assert.equal(h.count("bufferData"), uploads + 1); // the line's segments only
  const s = h.pass.state()!;
  assert.equal(s.fillBytes, 6 * 4 * 4); // the flat view's fill, no globe fill
  assert.equal(s.lineBytes, 4 * MARK_LINE_FLOATS * 4 + 4 * G_MARK_LINE_FLOATS * 4);
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
  assert.equal(h.pass.state()!.lineBytes, 4 * G_MARK_LINE_FLOATS * 4); // the globe's records
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
  assert.equal(h.count("bufferData"), 4); // b's fill and line built for its first frame
  assert.equal(h.emptied(), 0); // a's buffers were filled again: nothing to empty
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
  assert.equal(h.count("bufferData"), 4); // built again: nothing was kept
});

test("dropped meshes leave the GPU by the next frame, once", () => {
  const h = harness();
  h.pass.set(spec(), 0.5);
  h.frame();
  assert.equal(h.emptied(), 0);
  h.pass.clear();
  assert.equal(h.emptied(), 0); // not outside a frame
  h.frame(); // any frame of the layer's, the mark gone
  assert.equal(h.emptied(), 2); // the fill's buffer and the line's
  for (let i = 0; i < 5; i++) h.frame();
  assert.equal(h.emptied(), 2);
  // Kept for a retry (a drain): nothing emptied until the pending state ends.
  const kept = harness();
  kept.pass.set(spec(), 0.5);
  kept.frame();
  kept.pass.drain(FULL);
  kept.run(300);
  assert.equal(kept.pass.active, false);
  kept.frame();
  assert.equal(kept.emptied(), 0);
  kept.pass.forget();
  kept.frame();
  assert.equal(kept.emptied(), 2);
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
  assert.equal(h.count("bufferData"), uploads + 2); // the fill and the line, built again
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

test("a large unit: a stand-in fill in the tap's frame, nothing triangulated whole; its real meshes come from the provider and take its place", async () => {
  const h = harness();
  const p = provider();
  h.pass.setProvider(p);
  const g = large();
  h.pass.set(spec({ g }), 0.3);
  assert.equal(h.pass.fillAtOnce("merc"), true); // the stand-in, by the first frame
  h.frame();
  assert.equal(h.count("bufferData"), 1); // the stand-in alone
  assert.equal(h.count("drawArrays"), 1);
  assert.equal(h.count("drawArraysInstanced"), 0); // no line yet
  let s = h.pass.state()!;
  assert.deepEqual(
    [s.fillVia, s.fillLateMs, s.fillPlain, s.lineSegs],
    ["stand-in", null, true, null],
  );
  // The cost of a small unit's: about MARK_STANDIN_VERTICES boundary vertices.
  const whole = buildMark(g, "merc")!;
  assert.ok(s.fillVerts! <= 3 * MARK_STANDIN_VERTICES, `${s.fillVerts} vertices`);
  assert.ok(s.fillVerts! < whole.fill.fillCount / 2);
  assert.equal(h.pass.ownsFill("merc"), true);
  assert.deepEqual(
    p.asks.map((a) => [a.regime, a.front]),
    [["merc", true]],
  );
  h.frame(); // asked once, the stand-in built once
  assert.equal(p.asks.length, 1);
  assert.equal(h.count("bufferData"), 1);
  h.advance(20);
  const before = h.repaints();
  p.asks[0].answer(whole);
  await settle();
  assert.equal(h.repaints(), before + 1); // one repaint for the arrival
  assert.deepEqual(h.filled, []); // the violet was there: nothing to hand over
  h.frame();
  assert.equal(h.count("drawArrays"), 3);
  assert.equal(h.count("drawArraysInstanced"), 1); // the line came with it
  s = h.pass.state()!;
  assert.deepEqual([s.fillVia, s.fillLateMs, s.fillPlain], ["stand-in", null, false]);
  assert.equal(s.fillVerts, whole.fill.fillCount);
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

test("a large unit whose real fill lands before any frame joins the mark; the stand-in is then not built", async () => {
  const h = harness();
  const p = provider();
  h.pass.setProvider(p);
  const g = large();
  h.pass.set(spec({ g }), 0.3, "merc");
  h.advance(5);
  p.asks[0].answer(buildMark(g, "merc"));
  await settle();
  assert.deepEqual(h.filled, ["fr:dep:69"]);
  h.frame();
  const s = h.pass.state()!;
  assert.deepEqual([s.fillVia, s.fillLateMs, s.fillPlain], ["worker", 5, false]);
  assert.equal(h.count("bufferData"), 3); // the fill, the line, the corners: no stand-in
});

test("a large unit's data all in before its first frame: the stand-in still shows and fades, the gate counts it", () => {
  const h = harness(); // no provider: the page's own task builds the rest
  h.pass.set(spec({ g: large() }), 0, "merc");
  h.pass.finish(FULL, "then");
  assert.ok(Math.abs(h.pass.gateMs() - (MARK_STEP_MS + 16.7 + MARK_UNFILL_MS)) < 1e-9);
  h.advance(10);
  h.frame();
  assert.equal(h.count("drawArrays"), 1); // the violet, on the unit
  assert.equal(h.pass.state()!.fillVia, "stand-in");
  // The task after the frame: the line alone, nothing triangulated.
  assert.equal(h.deferred.length, 1);
  const fillBytes = h.pass.state()!.fillBytes;
  h.deferred[0]();
  h.frame();
  assert.equal(h.pass.state()!.fillBytes, fillBytes);
  assert.equal(h.pass.state()!.fillPlain, true);
  assert.equal(h.count("drawArraysInstanced"), 1); // the line, on its way to whole
  h.run(400);
  assert.equal(h.pass.state()!.fillAlpha, 0);
  assert.equal(h.pass.gateMs(), 0);
  assert.equal(h.deferred.length, 1); // asked once for this mark, not by every frame
});

test("a wide unit on the globe: a plain fill and its line in the tap's frame; the bisected fill, asked behind the builds, takes its place", async () => {
  const h = harness();
  const p = provider();
  h.pass.setProvider(p);
  const g: MarkGeometry = {
    type: "Polygon",
    coordinates: [
      [
        [-70, -30],
        [-30, -30],
        [-30, 5],
        [-70, 5],
        [-70, -30],
      ],
    ],
  };
  const draw = () => {
    h.pass.prepare(h.gl, "globe");
    h.pass.drawGlobe(h.gl, h.binders, false, 1, "fill", fillProg);
    h.pass.drawGlobe(h.gl, h.binders, false, 1, "line", null);
  };
  h.pass.set(spec({ g, spanDeg: 40 }), 0.3, "globe");
  assert.equal(p.asks.length, 0); // nothing asked at the tap: the frame builds it
  assert.equal(h.pass.fillAtOnce("globe"), true);
  draw();
  assert.equal(h.count("drawArrays"), 1); // the fill, in the first frame
  assert.equal(h.count("drawArraysInstanced"), 1);
  let s = h.pass.state()!;
  assert.deepEqual([s.fillVia, s.fillLateMs, s.fillPlain, s.fillVerts], ["page", null, true, 6]);
  assert.deepEqual(
    p.asks.map((a) => [a.regime, a.front]),
    [["globe", false]], // never ahead of the plateau's own mesh
  );
  draw();
  assert.equal(p.asks.length, 1); // asked once
  const before = h.repaints();
  p.asks[0].answer(buildMark(g, "globe"));
  await settle();
  assert.equal(h.repaints(), before + 1);
  draw();
  s = h.pass.state()!;
  assert.equal(s.fillPlain, false);
  assert.ok(s.fillVerts! > 600); // bisected
  assert.equal(s.fillVia, "page"); // on time: nothing joined late
  assert.deepEqual(h.filled, []);
  assert.equal(h.pass.ownsFill("globe"), true);
  // The flat view of the same unit is never plain.
  h.pass.prepare(h.gl, "merc");
  assert.equal(p.asks.length, 1);
});

test("a wide unit's bisected fill that never comes, or comes once the violet is leaving: the plain one stays", async () => {
  const g: MarkGeometry = {
    type: "Polygon",
    coordinates: [
      [
        [-70, -30],
        [-30, -30],
        [-30, 5],
        [-70, 5],
        [-70, -30],
      ],
    ],
  };
  const draw = (h: ReturnType<typeof harness>) => {
    h.pass.prepare(h.gl, "globe");
    h.pass.drawGlobe(h.gl, h.binders, false, 1, "fill", fillProg);
  };
  // The worker gives nothing while the mark has finished: no page build.
  const h = harness();
  const p = provider();
  h.pass.setProvider(p);
  h.pass.set(spec({ g, spanDeg: 40 }), 0, "globe");
  draw(h);
  h.pass.finish(SHORT, "then");
  p.asks[0].answer(null);
  await settle();
  assert.equal(h.deferred.length, 1);
  h.deferred[0]();
  draw(h);
  assert.equal(h.pass.state()!.fillVerts, 6);
  assert.equal(h.pass.gateMs() > 0, true); // the plain fill is the one leaving
  // No worker: the bisected fill in a task of the page's own, after the frame.
  const alone = harness();
  alone.pass.set(spec({ g, spanDeg: 40 }), 0, "globe");
  draw(alone);
  assert.equal(alone.pass.state()!.fillVerts, 6);
  assert.equal(alone.deferred.length, 1);
  alone.deferred[0]();
  draw(alone);
  assert.ok(alone.pass.state()!.fillVerts! > 600);
  assert.equal(alone.pass.state()!.fillPlain, false);
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

test("a large unit with no provider, or one that gives nothing: its real meshes built in a task after the frame", async () => {
  for (const withProvider of [false, true]) {
    const h = harness();
    const p = provider();
    if (withProvider) h.pass.setProvider(p);
    const g = large();
    h.pass.set(spec({ g }), 0.3);
    h.frame();
    if (withProvider) {
      assert.equal(h.deferred.length, 0);
      p.asks[0].answer(null);
      await settle();
    }
    assert.equal(h.deferred.length, 1);
    assert.equal(h.count("bufferData"), 1); // the stand-in: nothing else in the frame
    assert.equal(h.count("drawArraysInstanced"), 0);
    h.deferred[0]();
    h.frame();
    assert.equal(h.count("drawArrays"), 2);
    assert.equal(h.count("drawArraysInstanced"), 1);
    const s = h.pass.state()!;
    assert.deepEqual([s.fillVia, s.fillPlain], ["stand-in", false]);
    assert.equal(s.fillVerts, buildMark(g, "merc")!.fill.fillCount);
  }
  // The task comes after the mark can no longer show a fill: nothing is
  // triangulated — the line alone for a mark held with its data all in,
  // nothing at all once it drains, is cleared or is replaced.
  const g = large();
  const late = (act: (h: ReturnType<typeof harness>) => void) => {
    const h = harness();
    h.pass.set(spec({ g }), 0.3);
    h.frame();
    act(h);
    h.deferred[0]();
    h.frame();
    return h;
  };
  const standIn = late(() => {}).pass.state()!.fillBytes;
  const finished = late((h) => h.pass.finish(SHORT, "then"));
  assert.ok(finished.pass.state()!.fillBytes < standIn); // the stand-in, as it was
  assert.equal(finished.pass.state()!.fillPlain, true);
  assert.ok(finished.pass.state()!.lineBytes > 0);
  assert.equal(finished.count("drawArraysInstanced"), 1); // the line, whole
  const drained = late((h) => h.pass.drain(FULL));
  assert.equal(drained.pass.state()!.lineBytes, 0);
  assert.equal(drained.pass.state()!.fillPlain, true);
  const cleared = late((h) => h.pass.clear());
  assert.equal(cleared.count("bufferData"), 1); // the stand-in's upload, before the clear
  // …and a later mark of the same geometry (« Réessayer ») asks again.
  drained.run(300);
  drained.pass.set(spec({ g }), 0.3);
  drained.frame();
  assert.equal(drained.deferred.length, 2);
  drained.deferred[1]();
  drained.frame();
  assert.equal(drained.pass.state()!.fillPlain, false);
  assert.equal(drained.count("drawArraysInstanced"), 1);
  // A provider that is not live is not asked.
  const h = harness();
  const dead = provider(false);
  h.pass.setProvider(dead);
  h.pass.set(spec({ g: large() }));
  h.frame();
  assert.equal(dead.asks.length, 0);
  assert.equal(h.deferred.length, 1);
});

test("real meshes that land after the data was all in, the drain, a clear or a newer mark", async () => {
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
  // The data all in: the fill on screen (the stand-in) is the one leaving,
  // on the true boundary from now; the line is whole; the gate counts it.
  const finished = await arrive((h) => h.pass.finish(FULL, "then"));
  assert.equal(finished.count("drawArrays"), 2);
  assert.equal(finished.count("drawArraysInstanced"), 1);
  assert.ok(finished.pass.gateMs() > MARK_STEP_MS + MARK_UNFILL_MS);
  assert.deepEqual(finished.filled, []);
  assert.equal(finished.pass.ownsFill("merc"), true);
  finished.run(400);
  assert.equal(finished.pass.state()!.fillAlpha, 0);
  // Draining: drawn as it fades, and kept — a retry draws it in its first frame.
  const drained = await arrive((h) => h.pass.drain(FULL));
  drained.run(300);
  assert.equal(drained.pass.active, false);
  const fills = drained.count("drawArrays");
  drained.pass.set(spec({ g }), 0.3);
  assert.equal(drained.pass.fillAtOnce("merc"), true);
  drained.frame();
  assert.equal(drained.count("drawArrays"), fills + 1);
  assert.equal(drained.pass.state()!.fillPlain, false);
  const cleared = await arrive((h) => h.pass.clear());
  assert.equal(cleared.count("bufferData"), 1); // the stand-in's, before the clear
  const replaced = await arrive((h) => h.pass.set(spec({ id: "b", g: square(8) })));
  assert.equal(replaced.pass.state()!.fillVerts, 6); // b's own square, not the large unit
});

test("a full line whose plateau never rises is cleared by a timer, not by a frame", () => {
  const h = harness();
  h.pass.set(spec());
  h.frame();
  h.pass.finish(FULL, "then");
  h.run(200);
  h.advance(MARK_LINE_HOLD_CAP_MS - 300);
  assert.equal(h.pass.active, true);
  h.advance(200);
  assert.equal(h.pass.active, false);
  assert.equal(h.timers.size, 0);
});

// The page's age is no part of any delay: the same waits on a page a minute
// (or an hour) old as on one just loaded.
for (const age of [60_000, 3_600_000]) {
  test(`« together », page ${age / 1000} s old: the mark is held whole until the rise, then fades on the lid`, () => {
    const h = harness(age);
    h.pass.set(spec());
    h.frame();
    h.pass.setProgress(0.25, FULL);
    h.run(200);
    h.pass.finish(FULL, "together");
    // The whole line's own wait, and the cap, counted from now.
    assert.deepEqual(h.timersIn(), [MARK_STEP_MS + MARK_WHOLE_UNSEEN_MS, MARK_LINE_HOLD_CAP_MS]);
    assert.ok(h.pass.gateMs() < MARK_STEP_MS + 30); // the rise waits for the whole line only
    // A slow link: the rise comes half a second later.
    h.run(500);
    let s = h.pass.state()!;
    assert.equal(h.pass.active, true);
    assert.equal(s.phase, "held");
    assert.equal(s.fillAlpha, 1); // the violet whole…
    assert.equal(s.lineAlpha, 1);
    assert.equal(s.progress.shown, 1); // …under the whole line
    h.pass.release(1500, FULL);
    h.advance(58);
    h.frame(0.3);
    s = h.pass.state()!;
    assert.ok(s.fillAlpha > 0.4 && s.fillAlpha < 0.6, `fill at ${s.fillAlpha}`); // fading as it rises
    assert.ok(Math.abs(s.fillAlpha - s.lineAlpha) < 1e-9);
    h.run(300);
    assert.equal(h.pass.active, false);
    assert.equal(h.timers.size, 0);
  });

  test(`« together », page ${age / 1000} s old: a plateau that never rises ends the mark at the cap, not before`, () => {
    const h = harness(age);
    h.pass.set(spec());
    h.frame();
    h.pass.finish(FULL, "together");
    h.advance(MARK_LINE_HOLD_CAP_MS - 1);
    assert.equal(h.pass.active, true);
    h.advance(1);
    assert.equal(h.pass.active, false);
    assert.equal(h.timers.size, 0);
  });

  test(`« then », page ${age / 1000} s old: the gate and the cap count from the data's arrival`, () => {
    // Full motion, the line easing its last step: the fill leaves once a
    // frame has shown it whole; the cap counts from the data.
    let h = harness(age);
    h.pass.set(spec());
    h.frame();
    h.pass.finish(FULL, "then");
    assert.ok(Math.abs(h.pass.gateMs() - (MARK_STEP_MS + 16.7 + MARK_UNFILL_MS)) < 1e-9);
    assert.deepEqual(h.timersIn(), [MARK_STEP_MS + MARK_WHOLE_UNSEEN_MS, MARK_LINE_HOLD_CAP_MS]);
    h.run(96);
    assert.equal(h.pass.state()!.fillAlpha, 1);
    h.run(300);
    assert.equal(h.pass.state()!.fillAlpha, 0);
    assert.equal(h.pass.gateMs(), 0);
    assert.equal(h.pass.active, true); // the line holds until the rise
    const [capIn] = h.timersIn();
    assert.ok(
      capIn > MARK_LINE_HOLD_CAP_MS - 500 && capIn < MARK_LINE_HOLD_CAP_MS,
      `cap in ${capIn}`,
    );
    h.advance(capIn - 1);
    assert.equal(h.pass.active, true);
    h.advance(1);
    assert.equal(h.pass.active, false);

    // The line whole already (nothing to ease): the fill leaves after the
    // frame that shows it.
    h = harness(age);
    h.pass.set(spec(), 1);
    h.frame();
    h.pass.finish(FULL, "then");
    h.frame();
    assert.equal(h.pass.gateMs(), MARK_UNFILL_MS);

    // Short motion: the line jumps, the shorter fade.
    h = harness(age);
    h.pass.set(spec());
    h.frame();
    h.pass.finish(SHORT, "then");
    h.frame();
    assert.equal(h.pass.gateMs(), SHORT.unfillMs);

    // Reduced motion: two plain steps, the drop's own timer, then the cap.
    h = harness(age);
    h.pass.set(spec());
    h.frame();
    h.pass.finish(STILL, "then");
    h.frame();
    assert.equal(h.pass.gateMs(), MARK_REDUCED_HOLD_MS + MARK_REDUCED_GAP_MS);
    assert.deepEqual(h.timersIn(), [MARK_REDUCED_HOLD_MS, MARK_LINE_HOLD_CAP_MS]);
    h.advance(MARK_REDUCED_HOLD_MS);
    h.frame();
    assert.equal(h.pass.state()!.fillAlpha, 0);
    assert.equal(h.pass.gateMs(), MARK_REDUCED_GAP_MS);
    h.advance(MARK_REDUCED_GAP_MS);
    assert.equal(h.pass.gateMs(), 0);
    assert.equal(h.pass.active, true);
  });

  test(`page ${age / 1000} s old: a context given back arms the cap again, counted from then`, () => {
    for (const order of ["then", "together"] as const) {
      const h = harness(age);
      h.pass.set(spec(), 0.5);
      h.frame();
      h.pass.finish(SHORT, order);
      h.run(200);
      assert.equal(h.pass.active, true, order);
      h.pass.onRemove(h.gl);
      assert.equal(h.timers.size, 0);
      h.pass.onAdd(h.gl);
      assert.deepEqual(h.timersIn(), [MARK_LINE_HOLD_CAP_MS], order);
    }
  });

  test(`page ${age / 1000} s old: a drain holds the rise for its fade and no longer`, () => {
    const h = harness(age);
    h.pass.set(spec());
    h.frame();
    h.pass.drain(FULL);
    assert.equal(h.pass.gateMs(), MARK_FADE_MS);
    h.advance(40);
    assert.equal(h.pass.gateMs(), MARK_FADE_MS - 40);
    h.run(200);
    assert.equal(h.pass.gateMs(), 0);
    assert.equal(h.pass.active, false);
  });
}

// A flight across zoom 6 while a mark fades (the rise started, or the drain,
// with the camera still on its way): the other regime's first frame. The
// clock stands at a page a minute old.
{
  type H = ReturnType<typeof harness>;
  /** One globe frame, as the layer draws it: both passes. */
  const globeFrame = (h: H, rise = 1) => {
    h.pass.prepare(h.gl, "globe");
    for (const raised of [false, true]) {
      h.pass.drawGlobe(h.gl, h.binders, raised, rise, "fill", fillProg);
      h.pass.drawGlobe(h.gl, h.binders, raised, rise, "line", null);
    }
  };
  const draw = (h: H, regime: MarkRegime, rise = 1) =>
    regime === "merc" ? h.frame(rise) : globeFrame(h, rise);
  const other = (regime: MarkRegime): MarkRegime => (regime === "merc" ? "globe" : "merc");
  const near = (a: number | undefined, b: number, what: string) =>
    assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${what}: ${a}, expected ${b}`);

  for (const from of ["globe", "merc"] as const) {
    const to = other(from);
    test(`« together », the rise started in the ${from} regime: the ${to} regime's first frame draws the fill at its fading alpha`, () => {
      const h = harness(60_000);
      h.pass.set(spec(), 0.4, from);
      draw(h, from);
      h.pass.finish(FULL, "together");
      h.advance(150); // the line whole, the violet whole under it
      draw(h, from);
      h.pass.release(1500, FULL);
      h.advance(16);
      draw(h, from, 0.1);
      h.advance(16);
      draw(h, from, 0.2);
      const fills = h.count("drawArrays");
      const lines = h.count("drawArraysInstanced");
      // The camera crosses zoom 6, 48 ms into the fade.
      h.advance(16);
      draw(h, to, 0.3);
      const alpha = 1 - 48 / MARK_FADE_MS;
      assert.equal(h.count("drawArrays"), fills + 1); // the violet, in the new regime
      assert.equal(h.count("drawArraysInstanced"), lines + 1); // and the line
      near(h.uniform("uFillT"), fillThreshold(MARK_FILL_SHARE * alpha), "the fill's threshold");
      near(h.uniform("uAlpha"), alpha, "the line's alpha");
      assert.equal(h.pass.ownsFill(to), true);
      const s = h.pass.state()!;
      near(s.fillAlpha, alpha, "the probe's fill alpha");
      assert.ok(s.fillBytes > 0 && s.lineBytes > 0);
      // It fades on to its end there, a frame at a time, and nothing is asked off the frame.
      let last = h.uniform("uFillT")!;
      for (let i = 0; i < 4; i++) {
        h.advance(16);
        draw(h, to, 0.4);
        assert.equal(h.count("drawArrays"), fills + 2 + i);
        assert.ok(h.uniform("uFillT")! < last, "the violet keeps fading");
        last = h.uniform("uFillT")!;
      }
      for (let i = 0; i < 10; i++) {
        h.advance(16);
        draw(h, to, 0.6);
      }
      assert.equal(h.pass.active, false);
      assert.equal(h.deferred.length, 0);
    });

    test(`a drain started in the ${from} regime: the ${to} regime's first frame draws the fill and the line as they fade`, () => {
      const h = harness(60_000);
      h.pass.set(spec(), 0, from);
      draw(h, from);
      h.pass.setProgress(0.3, SHORT);
      draw(h, from);
      h.pass.drain(FULL);
      h.advance(16);
      draw(h, from);
      const fills = h.count("drawArrays");
      const lines = h.count("drawArraysInstanced");
      h.advance(24); // the camera crosses zoom 6, 40 ms into the fade
      draw(h, to);
      const alpha = 1 - 40 / MARK_FADE_MS;
      assert.equal(h.count("drawArrays"), fills + 1);
      assert.equal(h.count("drawArraysInstanced"), lines + 1);
      near(h.uniform("uFillT"), fillThreshold(MARK_FILL_SHARE * alpha), "the fill's threshold");
      near(h.uniform("uAlpha"), alpha, "the line's alpha");
      assert.equal(h.uniform("uProgress"), 0.3); // the line short of the whole boundary, as it stood
      assert.equal(h.pass.gateMs(), MARK_FADE_MS - 40); // the rise still waits for that fade
    });
  }

  test("« then »: the fill gone before the rise, a regime first drawn while the line fades gets the line alone", () => {
    const h = harness(60_000);
    h.pass.set(spec(), 0.4, "globe");
    globeFrame(h);
    h.pass.finish(FULL, "then");
    for (let i = 0; i < 14; i++) {
      h.advance(16);
      globeFrame(h);
    }
    assert.equal(h.pass.gateMs(), 0);
    assert.equal(h.pass.state()!.fillAlpha, 0);
    h.pass.release(1500, FULL);
    h.advance(16);
    globeFrame(h, 0.1);
    const fills = h.count("drawArrays");
    const lines = h.count("drawArraysInstanced");
    const uploads = h.count("bufferData");
    const fillBytes = h.pass.state()!.fillBytes;
    h.advance(16);
    h.frame(0.2); // the camera crosses zoom 6, 32 ms into the line's fade
    assert.equal(h.count("drawArrays"), fills); // no violet
    assert.equal(h.count("drawArraysInstanced"), lines + 1);
    assert.equal(h.count("bufferData"), uploads + 1); // the line's segments: no fill
    assert.equal(h.pass.state()!.fillBytes, fillBytes);
    assert.equal(h.pass.ownsFill("merc"), false);
    near(h.uniform("uAlpha"), 1 - 32 / MARK_FADE_MS, "the line's alpha");
  });

  test("a fading mark whose fill was never on screen gets none in a regime first drawn then", () => {
    // Released under « together » before any frame drew it.
    const h = harness(60_000);
    h.pass.set(spec(), 0.4, "globe");
    h.pass.finish(FULL, "together");
    h.pass.release(1500, FULL);
    h.advance(16);
    h.frame(0.1);
    assert.equal(h.count("drawArrays"), 0);
    assert.equal(h.count("drawArraysInstanced"), 1); // the line alone
    assert.equal(h.pass.state()!.fillBytes, 0);
  });

  test("« together », a large unit: the other regime's first frame fills it with a stand-in, nothing triangulated whole on the page; the worker's meshes take their place", async () => {
    const g = large();
    const whole = { globe: buildMark(g, "globe")!, merc: buildMark(g, "merc")! };
    const h = harness(60_000);
    const p = provider();
    h.pass.setProvider(p);
    h.pass.set(spec({ g }), 0.4, "globe");
    globeFrame(h);
    p.asks[0].answer(whole.globe);
    await settle();
    globeFrame(h);
    h.pass.finish(FULL, "together");
    h.advance(150);
    globeFrame(h);
    h.pass.release(1500, FULL);
    h.advance(16);
    globeFrame(h, 0.1);
    const fills = h.count("drawArrays");
    const lines = h.count("drawArraysInstanced");
    const uploads = h.count("bufferData");
    const globeBytes = h.pass.state()!.fillBytes;
    // The camera crosses zoom 6, 40 ms into the fade.
    h.advance(24);
    h.frame(0.2);
    const alpha = 1 - 40 / MARK_FADE_MS;
    assert.equal(h.count("drawArrays"), fills + 1); // the violet, in that very frame
    near(h.uniform("uFillT"), fillThreshold(MARK_FILL_SHARE * alpha), "the fill's threshold");
    assert.equal(h.count("bufferData"), uploads + 1); // the stand-in alone
    const standIn = h.pass.state()!.fillBytes - globeBytes;
    assert.ok(standIn > 0 && standIn <= 3 * MARK_STANDIN_VERTICES * 4 * 4, `${standIn} bytes`);
    assert.ok(standIn < whole.merc.fill.fill.byteLength / 2);
    assert.equal(h.pass.ownsFill("merc"), true);
    // The real meshes: asked of the worker, behind its builds — never the page's task.
    assert.deepEqual(
      p.asks.map((a) => [a.regime, a.front]),
      [
        ["globe", true],
        ["merc", false],
      ],
    );
    assert.equal(h.deferred.length, 0);
    assert.equal(h.count("drawArraysInstanced"), lines); // its line: not before they land
    h.advance(16);
    p.asks[1].answer(whole.merc);
    await settle();
    h.frame(0.3);
    assert.equal(h.count("drawArrays"), fills + 2);
    assert.equal(h.count("drawArraysInstanced"), lines + 1);
    assert.equal(h.pass.state()!.fillBytes, globeBytes + whole.merc.fill.fill.byteLength);
    near(h.uniform("uAlpha"), 1 - 56 / MARK_FADE_MS, "the line's alpha");
    assert.deepEqual(h.filled, []); // nothing joined late: no hand-over
  });

  test("« together », a large unit and no worker: the stand-in fades in the other regime, the page's task triangulates nothing", () => {
    const g = large();
    const h = harness(60_000);
    h.pass.set(spec({ g }), 0.4, "globe");
    globeFrame(h);
    h.deferred[0](); // the tap's regime: its real fill and its line, after the tap's frame
    globeFrame(h);
    h.pass.finish(FULL, "together");
    h.advance(150);
    globeFrame(h);
    h.pass.release(1500, FULL);
    h.advance(16);
    globeFrame(h, 0.1);
    const fills = h.count("drawArrays");
    const globeBytes = h.pass.state()!.fillBytes;
    h.advance(24);
    h.frame(0.2);
    assert.equal(h.count("drawArrays"), fills + 1);
    const standIn = h.pass.state()!.fillBytes - globeBytes;
    assert.ok(standIn > 0 && standIn <= 3 * MARK_STANDIN_VERTICES * 4 * 4, `${standIn} bytes`);
    assert.equal(h.deferred.length, 2);
    h.deferred[1]();
    h.advance(16);
    h.frame(0.3);
    assert.equal(h.count("drawArrays"), fills + 2); // the stand-in still, fading
    assert.equal(h.pass.state()!.fillBytes, globeBytes + standIn);
    assert.equal(h.pass.state()!.fillPlain, true);
    for (let i = 0; i < 8; i++) {
      h.advance(16);
      h.frame(0.5);
    }
    assert.equal(h.pass.active, false);
  });
}

test("the creep: a small lead over the first seconds, a tick's frame unless one was drawn, then nothing", () => {
  const h = harness();
  h.pass.set(spec({ creep: true }));
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
  assert.ok(at1s > 0 && at1s < MARK_CREEP_LEAD, `shown ${at1s}`); // with no data at all
  assert.equal(h.pass.state()!.progress.target, 0);
  // A real step moves the line by its own length, whatever the lead: the
  // real value under it, the lead on top.
  h.pass.setProgress(0.25, FULL);
  h.advance(MARK_STEP_MS);
  const stepped = h.shown();
  assert.ok(stepped >= 0.25 + at1s, `shown ${stepped}`);
  assert.ok(stepped <= 0.25 + MARK_CREEP_LEAD);
  // A map that draws frames of its own (a flight): the ticks ask for none.
  h.frame();
  before = h.repaints();
  for (let i = 0; i < 50; i++) {
    h.advance(20);
    h.frame();
  }
  assert.equal(h.repaints(), before);
  // Past the freeze: no tick left, no frame asked, the value at rest —
  // never more than the lead past the real value.
  h.advance(MARK_CREEP_FREEZE_MS);
  h.frame();
  const rest = h.shown();
  assert.ok(rest > 0.25 && rest <= 0.25 + MARK_CREEP_LEAD, `shown ${rest}`);
  before = h.repaints();
  h.advance(5000);
  h.frame();
  assert.equal(h.repaints(), before);
  assert.equal(h.shown(), rest);
  assert.equal(h.timers.size, 0);
  // A later real step: the line moves by the step, and no tick starts again.
  h.pass.setProgress(0.3, FULL);
  assert.equal(h.shown(), rest); // no jump at the step
  h.advance(MARK_STEP_MS);
  assert.ok(Math.abs(h.shown() - (rest + 0.05)) < 1e-9, `shown ${h.shown()}`);
  assert.equal(h.timers.size, 0);
  // A real value near the end is shown as it is, never pushed further.
  h.pass.setProgress(0.95, FULL);
  h.advance(MARK_STEP_MS);
  assert.equal(h.shown(), 0.95);
  // The data all in: the line goes to the end, never back.
  h.pass.finish(FULL, "then");
  assert.equal(h.shown(), 0.95);
  h.advance(MARK_STEP_MS);
  assert.equal(h.shown(), 1);
});

test("the creep under short motion: a tick four times a second at most; the lead is kept at the end", () => {
  const h = harness();
  h.pass.set(spec({ creep: true, creepTickMs: MARK_CREEP_TICK_SHORT_MS }));
  h.frame();
  const before = h.repaints();
  let frames = 0;
  for (let at = 0; at < 2000; at += 50) {
    const was = h.repaints();
    h.advance(50);
    if (h.repaints() > was) {
      h.frame();
      frames++;
    }
  }
  const asked = h.repaints() - before;
  assert.ok(asked >= 7 && asked <= 8, `${asked} frames asked in two seconds`);
  assert.equal(frames, asked);
  const at2s = h.shown();
  assert.ok(at2s > 0.03 && at2s < MARK_CREEP_LEAD, `shown ${at2s}`);
  // The first real step, a jump under short motion: by its own length.
  h.pass.setProgress(0.25, SHORT);
  assert.ok(Math.abs(h.shown() - (0.25 + at2s)) < 1e-9);
  h.pass.finish(SHORT, "then");
  assert.equal(h.shown(), 1);
  h.advance(10_000);
  assert.equal(h.timers.size, 0); // the cap's timer ran, no tick is left
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

test("a context given back: the meshes are uploaded again, the mark's timers armed again", () => {
  const h = harness();
  h.pass.set(spec(), 0.5);
  h.frame();
  assert.equal(h.count("bufferData"), 3);
  h.pass.finish(SHORT, "then");
  assert.equal(h.timers.size, 2); // the cap, and the whole line's own wait
  h.pass.onRemove(h.gl);
  assert.equal(h.timers.size, 0); // no timer once the layer is gone
  h.pass.onAdd(h.gl);
  assert.equal(h.timers.size, 2);
  h.frame();
  assert.equal(h.count("bufferData"), 6);
  assert.equal(h.emptied(), 0);
  assert.equal(h.pass.state(true)!.linked, true);
  h.advance(MARK_LINE_HOLD_CAP_MS);
  assert.equal(h.pass.active, false);
});

// ---- ac:tap-fast "hide" (the default): no line for a wait too short to be
// read, a line that shows runs at a constant speed; and the fill leaves
// against the rise's real start (the plateau's `riseEta`). Clocks start at
// a realistic page age. ----
const AGE = 60_000;
const HIDE: MarkMotion = {
  animate: true,
  stepMs: MARK_STEP_MS,
  unfillMs: MARK_UNFILL_MS,
  outMs: MARK_FADE_MS,
  lineFullMs: MARK_LINE_FULL_MS,
  frameGapMs: 0,
};
/** Short motion: the same run, a frame asked every MARK_SHORT_FRAME_MS. */
const HIDE_SHORT: MarkMotion = { ...HIDE, unfillMs: 40, frameGapMs: MARK_SHORT_FRAME_MS };
const HIDE_STILL: MarkMotion = { animate: false, stepMs: 0, unfillMs: 0, outMs: MARK_FADE_MS };
const hidden = (over: Partial<PendingMarkSpec> = {}) =>
  spec({ showAfterMs: MARK_LINE_SHOW_MS, ...over });
/** Frames every `dt` ms for `ms`, `each` called after each one. */
function frames(h: ReturnType<typeof harness>, ms: number, dt: number, each?: () => void) {
  for (let at = 0; at < ms - 1e-9; at += dt) {
    h.advance(dt);
    h.frame();
    each?.();
  }
}
const FRAME_CLOCKS = [16.7, 50];

for (const dt of FRAME_CLOCKS) {
  test(`hide, ${dt} ms frames: the data in 150 ms after the first frame — no line in any frame, to the release`, () => {
    const h = harness(AGE, { eta: null });
    h.pass.set(hidden(), 0, "merc", HIDE);
    h.frame();
    const noLine = () => {
      assert.equal(h.shown(), 0);
      assert.equal(h.count("drawArraysInstanced"), 0);
    };
    frames(h, 50, dt, noLine);
    h.pass.setProgress(0.6, HIDE);
    frames(h, 100, dt, noLine);
    h.pass.finish(HIDE, "then");
    assert.equal(h.pass.state()!.lineSkipped, true);
    frames(h, 400, dt, noLine); // past the moment the line would have been due
    assert.equal(h.pass.gateMs(true), MARK_UNFILL_MS);
    frames(h, 150, dt, noLine);
    assert.equal(h.pass.gateMs(true), 0);
    h.pass.release(1500, HIDE);
    frames(h, 300, dt, () => assert.equal(h.count("drawArraysInstanced"), 0));
    assert.equal(h.pass.active, false);
    assert.equal(h.timers.size, 0);
  });

  test(`hide, ${dt} ms frames: a line that shows starts from nothing in a frame and runs at a constant speed, never ahead of the data`, () => {
    const h = harness(AGE, { eta: null });
    h.pass.set(hidden(), 0, "merc", HIDE);
    h.pass.setProgress(0.5, HIDE); // told before the line is on: kept
    // The first frame comes 180 ms after the tap: the clock starts there.
    h.advance(180);
    h.frame();
    const seen = h.now();
    frames(h, MARK_LINE_SHOW_MS - dt, dt, () => {
      if (h.now() < seen + MARK_LINE_SHOW_MS) assert.equal(h.shown(), 0, `at ${h.now() - seen}`);
    });
    assert.equal(h.count("drawArraysInstanced"), 0);
    // Due: the next frame turns it on, at nothing.
    h.advance(dt);
    h.frame();
    assert.ok(h.now() >= seen + MARK_LINE_SHOW_MS);
    assert.equal(h.pass.state()!.lineOn, true);
    assert.equal(h.shown(), 0);
    let last = 0;
    let at10 = 0;
    let at90 = 0;
    h.pass.setProgress(1 - 1e-9, HIDE); // a whole run, the data short of all in
    const t0 = h.now();
    frames(h, 400, dt, () => {
      const v = h.shown();
      assert.ok(v - last <= dt / MARK_LINE_FULL_MS + 1e-6, `a frame added ${v - last}`);
      assert.ok(v <= 1 - 1e-9 + 1e-12);
      if (!at10 && v >= 0.1) at10 = h.now();
      if (!at90 && v >= 0.9) at90 = h.now();
      last = v;
    });
    assert.ok(at90 - at10 >= 200, `10 % to 90 % in ${at90 - at10} ms`);
    assert.ok(at90 - t0 <= MARK_LINE_FULL_MS + dt, `90 % after ${at90 - t0} ms`);
    assert.ok(h.count("drawArraysInstanced") > 0);
  });

  test(`hide, ${dt} ms frames: the frame that first shows the whole line has the whole fill; the fade starts after it`, () => {
    const h = harness(AGE, { eta: { at: AGE, landing: false } }); // the rise could start at once
    h.pass.set(hidden(), 0, "merc", HIDE);
    h.frame();
    frames(h, 250, dt);
    h.pass.setProgress(0.5, HIDE);
    frames(h, 200, dt);
    assert.ok(Math.abs(h.shown() - 0.5) < 1e-9);
    h.pass.finish(HIDE, "then");
    const end = h.now() + 0.5 * MARK_LINE_FULL_MS; // half the boundary at full speed
    let whole = 0;
    frames(h, 400, dt, () => {
      const s = h.pass.state()!;
      if (!whole) {
        assert.equal(s.fillAlpha, 1, `fill at ${s.fillAlpha}, line at ${s.progress.shown}`);
        if (s.progress.shown >= 1) whole = h.now();
      }
    });
    assert.ok(whole >= end && whole <= end + dt, `whole ${whole - end} ms after its run's end`);
    assert.equal(h.pass.state()!.unfillT0, whole);
    assert.equal(h.pass.state()!.fillAlpha, MARK_UNFILL_FLOOR); // at the floor: not cleared
    assert.equal(h.pass.gateMs(), MARK_UNFILL_FLOOR * MARK_UNFILL_MS);
  });
}

test("hide: a large unit's line turns on at nothing in the frame its mesh is ready", async () => {
  const h = harness(AGE, { eta: null });
  const p = provider();
  h.pass.setProvider(p);
  const g = large();
  h.pass.set(hidden({ g }), 0.4, "merc", HIDE);
  h.frame();
  frames(h, 300, 16.7); // due, and no segments yet
  assert.equal(h.pass.state()!.lineOn, false);
  assert.equal(h.count("drawArraysInstanced"), 0);
  p.asks[0].answer(buildMark(g, "merc"));
  await settle();
  h.frame();
  assert.equal(h.pass.state()!.lineOn, true);
  assert.equal(h.shown(), 0);
  h.advance(16.7);
  h.frame();
  assert.ok(h.shown() > 0 && h.shown() <= 16.7 / MARK_LINE_FULL_MS + 1e-9);
  frames(h, 300, 16.7);
  assert.ok(Math.abs(h.shown() - 0.4) < 1e-9);
});

test("the fade against the rise: whole until just before it, at the floor when it can start, gone 25 ms after it is cleared", () => {
  const rise = { eta: { at: AGE + 165, landing: false } as MarkRiseEta | null }; // the old plateau's sink
  const h = harness(AGE, rise);
  h.pass.set(hidden(), 0, "merc", HIDE);
  h.frame();
  h.advance(50);
  let before = h.repaints();
  h.pass.finish(HIDE, "then"); // the data in at 50 ms: no line
  assert.equal(h.repaints(), before + 1);
  const lead = (1 - MARK_UNFILL_FLOOR) * MARK_UNFILL_MS;
  assert.deepEqual(h.timersIn(), [165 - lead - 50, MARK_LINE_HOLD_CAP_MS]);
  // No frame is asked while the violet waits, whole.
  before = h.repaints();
  frames(h, 32, 16, () => assert.equal(h.pass.state()!.fillAlpha, 1));
  assert.equal(h.repaints(), before);
  assert.equal(h.pass.gateMs(), MARK_UNFILL_MS); // a query: the whole fade is still to come
  h.advance(165 - lead - 82); // the fade's start, by its timer
  assert.equal(h.repaints(), before + 1);
  assert.equal(h.pass.state()!.unfillT0, AGE + 165 - lead);
  h.advance(lead / 2);
  h.frame();
  assert.ok(Math.abs(h.pass.state()!.fillAlpha - (1 - (1 - MARK_UNFILL_FLOOR) / 2)) < 1e-9);
  h.advance(lead / 2);
  h.frame();
  assert.equal(h.now(), AGE + 165);
  assert.equal(h.pass.state()!.fillAlpha, MARK_UNFILL_FLOOR); // at the floor as the rise can start
  // The rise is late (the commit, a landing): the floor holds, no frame asked.
  before = h.repaints();
  frames(h, 320, 16, () => assert.equal(h.pass.state()!.fillAlpha, MARK_UNFILL_FLOOR));
  assert.equal(h.repaints(), before);
  // A query changes nothing.
  assert.equal(h.pass.gateMs(), MARK_UNFILL_FLOOR * MARK_UNFILL_MS);
  assert.equal(h.pass.state()!.goAt, 0);
  assert.equal(h.repaints(), before);
  // Cleared: the last quarter leaves, the gate is its 25 ms.
  assert.equal(h.pass.gateMs(true), MARK_UNFILL_FLOOR * MARK_UNFILL_MS);
  assert.equal(h.repaints(), before + 1);
  const last = MARK_UNFILL_FLOOR * MARK_UNFILL_MS;
  h.advance(last / 2);
  h.frame();
  assert.ok(Math.abs(h.pass.state()!.fillAlpha - MARK_UNFILL_FLOOR / 2) < 1e-9);
  assert.ok(Math.abs(h.pass.gateMs(true) - last / 2) < 1e-9);
  h.advance(last / 2);
  h.frame();
  assert.equal(h.pass.state()!.fillAlpha, 0);
  assert.equal(h.pass.gateMs(true), 0);
  // The rise: nothing rides the lid.
  h.pass.release(1500, HIDE);
  h.frame(0.2);
  assert.equal(h.pass.state()?.fillAlpha ?? 0, 0);
});

test("the fade against the rise: a rise whose start is not known keeps the fill whole until it is cleared", () => {
  const h = harness(AGE, { eta: null });
  h.pass.set(hidden(), 0, "merc", HIDE);
  h.frame();
  h.advance(80);
  h.pass.finish(HIDE, "then");
  assert.deepEqual(h.timersIn(), [MARK_LINE_HOLD_CAP_MS]); // no fade scheduled
  const before = h.repaints();
  frames(h, 500, 16, () => assert.equal(h.pass.state()!.fillAlpha, 1));
  assert.equal(h.repaints(), before);
  assert.equal(h.pass.gateMs(), MARK_UNFILL_MS);
  assert.equal(h.pass.state()!.unfillT0, 0);
  assert.equal(h.pass.gateMs(true), MARK_UNFILL_MS); // the whole fade, from now
  assert.equal(h.pass.state()!.unfillT0, h.now());
  h.advance(MARK_UNFILL_MS / 2);
  h.frame();
  assert.ok(Math.abs(h.pass.state()!.fillAlpha - 0.5) < 1e-9);
  h.advance(MARK_UNFILL_MS * 0.4);
  h.frame();
  assert.ok(Math.abs(h.pass.state()!.fillAlpha - 0.1) < 1e-9); // through the floor: cleared
  h.advance(MARK_UNFILL_MS * 0.1);
  assert.equal(h.pass.gateMs(true), 0);
});

test("the fade against the rise: a start put off before the fade began re-arms its timer; put off after, the floor holds", () => {
  const rise = { eta: { at: AGE + 400, landing: true } as MarkRiseEta | null }; // a landing
  const h = harness(AGE, rise);
  h.pass.set(hidden(), 0, "merc", HIDE_SHORT);
  h.frame();
  h.advance(100);
  h.pass.finish(HIDE_SHORT, "then");
  const lead = (1 - MARK_UNFILL_FLOOR) * 40;
  // A landing is told in the frame after the flight's end, half a frame
  // later on average: the fade aims there.
  const [fadeIn] = h.timersIn();
  assert.ok(Math.abs(fadeIn - (300 + 16.7 / 2 - lead)) < 1e-9, `fade in ${fadeIn}`);
  // The flight is replaced by a longer one meanwhile.
  rise.eta = { at: AGE + 700, landing: true };
  h.advance(fadeIn);
  assert.equal(h.pass.state()!.unfillT0, 0); // not begun: armed again
  const [again] = h.timersIn();
  assert.ok(Math.abs(again - 300) < 1e-9, `again in ${again}`);
  h.advance(again);
  assert.ok(h.pass.state()!.unfillT0 > 0);
  // Put off once more, after the fade began: the floor holds until cleared.
  rise.eta = { at: AGE + 1500, landing: true };
  frames(h, 600, 16);
  assert.equal(h.pass.state()!.fillAlpha, MARK_UNFILL_FLOOR);
  assert.equal(h.pass.gateMs(true), MARK_UNFILL_FLOOR * 40);
  h.advance(10);
  assert.equal(h.pass.gateMs(true), 0);
});

test("the same unit marked again while held changes nothing; another unit's mark starts over", () => {
  const rise = { eta: { at: AGE + 300, landing: false } as MarkRiseEta | null };
  const h = harness(AGE, rise);
  const s0 = hidden();
  h.pass.set(s0, 0, "merc", HIDE);
  h.frame();
  frames(h, 250, 16);
  h.pass.setProgress(0.5, HIDE);
  frames(h, 200, 16);
  h.pass.finish(HIDE, "then");
  frames(h, 180, 16); // the line whole, the fade under way
  const before = h.pass.state()!;
  assert.ok(before.unfillT0 > 0 && before.progress.shown === 1);
  const timers = h.timersIn();
  const repaints = h.repaints();
  h.pass.set({ ...s0 }, 0.2, "merc", HIDE); // tapped once more
  assert.deepEqual(h.pass.state(), before);
  assert.deepEqual(h.timersIn(), timers);
  assert.equal(h.repaints(), repaints);
  // Another unit: everything starts over.
  h.pass.set(hidden({ id: "fr:dep:38", g: square(8) }), 0, "merc", HIDE);
  const s = h.pass.state()!;
  assert.deepEqual(
    [s.id, s.finished, s.lineOn, s.lineSkipped, s.seenAt, s.wholeSeenAt, s.unfillT0, s.goAt],
    ["fr:dep:38", false, false, false, 0, 0, 0, 0],
  );
  assert.deepEqual(h.timersIn(), []);
});

test("hide under short motion: a run asks a frame every MARK_SHORT_FRAME_MS and one at its end, no more", () => {
  const h = harness(AGE, { eta: null });
  h.pass.set(hidden(), 0, "merc", HIDE_SHORT);
  h.frame();
  h.advance(MARK_LINE_SHOW_MS); // due: one repaint
  h.frame(); // on, at nothing
  h.pass.setProgress(0.5, HIDE_SHORT);
  h.frame();
  // Only the pass's own timer asks for frames from here: each one is drawn.
  const at: number[] = [];
  let before = h.repaints();
  for (let i = 0; i < 400; i++) {
    h.advance(1);
    if (h.repaints() > before) {
      at.push(h.now());
      before = h.repaints();
      h.frame();
      before = h.repaints();
    }
  }
  assert.ok(at.length >= 2 && at.length <= 4, `${at.length} frames asked`);
  for (let i = 1; i < at.length - 1; i++) {
    assert.ok(at[i] - at[i - 1] >= MARK_SHORT_FRAME_MS - 1e-9, `gap ${at[i] - at[i - 1]}`);
  }
  assert.ok(Math.abs(h.shown() - 0.5) < 1e-9); // the last one at the run's end
  assert.equal(h.timers.size, 0);
});

test("hide under reduced motion: the line appears when due at the real value, and steps", () => {
  const h = harness(AGE, { eta: { at: AGE, landing: false } });
  h.pass.set(hidden(), 0, "merc", HIDE_STILL);
  h.frame();
  h.pass.setProgress(0.3, HIDE_STILL);
  frames(h, 180, 16, () => assert.equal(h.shown(), 0));
  h.advance(40);
  h.frame();
  assert.equal(h.shown(), 0.3);
  h.pass.setProgress(0.7, HIDE_STILL);
  assert.equal(h.shown(), 0.7);
  h.pass.finish(HIDE_STILL, "then");
  h.frame();
  assert.equal(h.shown(), 1);
  assert.equal(h.pass.state()!.fillAlpha, 1);
  assert.equal(h.pass.gateMs(), MARK_REDUCED_HOLD_MS + MARK_REDUCED_GAP_MS);
  h.advance(MARK_REDUCED_HOLD_MS);
  h.frame();
  assert.equal(h.pass.state()!.fillAlpha, 0); // a plain drop, two frames before the rise
  assert.equal(h.pass.gateMs(true), MARK_REDUCED_GAP_MS);
});

test("« together » under hide: no fade before the rise, which waits for a line on screen to be shown whole", () => {
  const h = harness(AGE, { eta: { at: AGE, landing: false } });
  h.pass.set(hidden(), 0, "merc", HIDE);
  h.frame();
  frames(h, 250, 16);
  h.pass.setProgress(0.5, HIDE);
  frames(h, 200, 16);
  h.pass.finish(HIDE, "together");
  const gate = h.pass.gateMs(true);
  const half = 0.5 * MARK_LINE_FULL_MS;
  assert.ok(gate > half && gate < half + 30, `gate ${gate}`);
  frames(h, 200, 16);
  assert.equal(h.pass.gateMs(true), 0);
  assert.equal(h.pass.state()!.fillAlpha, 1);
  h.pass.release(1500, HIDE);
  h.advance(58);
  h.frame(0.3);
  const s = h.pass.state()!;
  assert.ok(s.fillAlpha > 0.4 && s.fillAlpha < 0.6); // fill and line fade on the rising lid
  assert.ok(Math.abs(s.fillAlpha - s.lineAlpha) < 1e-9);
});

test("a line that will not show is never built; a dropped line fades alone and the fill leaves by the rule", () => {
  // The data all in before the first frame: the fill alone is built.
  const fast = harness(AGE, { eta: null });
  fast.pass.set(hidden(), 0, "merc", HIDE);
  fast.pass.finish(HIDE, "then");
  fast.frame();
  assert.equal(fast.pass.state()!.lineBytes, 0);
  assert.ok(fast.pass.state()!.fillBytes > 0);
  // A large unit, no worker, its data in before its meshes: no line is built after.
  const big = harness(AGE, { eta: null });
  big.pass.set(hidden({ g: large() }), 0, "merc", HIDE);
  big.frame();
  big.pass.finish(HIDE, "then");
  big.deferred[0]();
  big.frame();
  assert.equal(big.pass.state()!.lineBytes, 0);
  // The file the line measured is given up on: the line fades where it
  // stands, the fill stays whole, then leaves once the rise is cleared.
  const h = harness(AGE, { eta: null });
  h.pass.set(hidden(), 0, "merc", HIDE);
  h.frame();
  frames(h, 250, 16);
  h.pass.setProgress(0.4, HIDE);
  frames(h, 200, 16);
  h.pass.dropLine(HIDE);
  h.advance(58);
  h.frame();
  let s = h.pass.state()!;
  assert.ok(s.lineAlpha > 0.4 && s.lineAlpha < 0.6);
  assert.ok(Math.abs(s.progress.shown - 0.4) < 1e-9);
  assert.equal(s.fillAlpha, 1);
  frames(h, 100, 16);
  assert.equal(h.pass.state()!.lineAlpha, 0);
  h.pass.finish(HIDE, "then");
  assert.equal(h.pass.gateMs(), MARK_UNFILL_MS); // no line to wait for
  assert.equal(h.pass.gateMs(true), MARK_UNFILL_MS);
  frames(h, 120, 16);
  s = h.pass.state()!;
  assert.deepEqual([s.fillAlpha, s.lineAlpha], [0, 0]);
});

test("hide: the timers a mark owes are stopped with the layer and armed again with it", () => {
  // The line not due yet.
  let h = harness(AGE, { eta: null });
  h.pass.set(hidden(), 0, "merc", HIDE);
  h.frame();
  h.advance(50);
  assert.deepEqual(h.timersIn(), [MARK_LINE_SHOW_MS - 50]);
  h.pass.onRemove(h.gl);
  assert.equal(h.timers.size, 0);
  h.pass.onAdd(h.gl);
  assert.deepEqual(h.timersIn(), [MARK_LINE_SHOW_MS - 50]);
  // The fade's start.
  h = harness(AGE, { eta: { at: AGE + 500, landing: false } });
  h.pass.set(hidden(), 0, "merc", HIDE);
  h.frame();
  h.advance(50);
  h.pass.finish(HIDE, "then");
  const owed = h.timersIn();
  assert.equal(owed.length, 2); // the fade, the cap
  h.pass.onRemove(h.gl);
  assert.equal(h.timers.size, 0);
  h.pass.onAdd(h.gl);
  assert.deepEqual(h.timersIn(), owed);
});

test("the rise cleared while the line still runs: the fill is whole in the frame that shows the whole line, then fades through", () => {
  const h = harness(AGE, { eta: { at: AGE, landing: false } });
  h.pass.set(hidden(), 0, "merc", HIDE);
  h.frame();
  frames(h, 250, 16);
  h.pass.setProgress(0.2, HIDE);
  frames(h, 120, 16);
  h.pass.finish(HIDE, "then");
  h.advance(30);
  // The commit: everything else is in, the line has most of its run left.
  const gate = h.pass.gateMs(true);
  assert.ok(gate > 0.8 * MARK_LINE_FULL_MS - 30 + MARK_UNFILL_MS, `gate ${gate}`);
  let whole = 0;
  frames(h, 400, 16, () => {
    const s = h.pass.state()!;
    if (whole) return;
    assert.equal(s.fillAlpha, 1);
    if (s.progress.shown >= 1) whole = h.now();
  });
  assert.ok(whole > 0);
  assert.equal(h.pass.state()!.unfillT0, whole);
  assert.equal(h.pass.state()!.fillAlpha, 0); // gone 100 ms after that frame
  assert.equal(h.pass.gateMs(true), 0);
});

test("the flight crosses zoom 6 while the fill fades or stands at its floor: the regime it enters draws the fill on", () => {
  const rise = { eta: { at: AGE + 165, landing: false } as MarkRiseEta | null };
  const h = harness(AGE, rise);
  const globe = () => {
    h.pass.prepare(h.gl, "globe");
    h.pass.drawGlobe(h.gl, h.binders, false, 1, "fill", fillProg);
    h.pass.drawGlobe(h.gl, h.binders, false, 1, "line", null);
  };
  h.pass.set(hidden(), 0, "globe", HIDE);
  globe(); // the tap's frames are drawn on the globe
  h.advance(60);
  h.pass.finish(HIDE, "then");
  h.advance(70); // the fade under way (it began just before the sink's end)
  globe();
  const mid = h.pass.state()!.fillAlpha;
  assert.ok(mid > MARK_UNFILL_FLOOR && mid < 1, `fill at ${mid}`);
  // The camera crosses zoom 6: the flat view's first frame builds its fill.
  let fills = h.count("drawArrays");
  h.advance(16);
  h.frame();
  assert.equal(h.count("drawArrays"), fills + 1);
  assert.equal(h.pass.ownsFill("merc"), true);
  // At the floor, the rise late: still drawn, in a regime first drawn then too.
  h.advance(200);
  fills = h.count("drawArrays");
  h.frame();
  assert.equal(h.pass.state()!.fillAlpha, MARK_UNFILL_FLOOR);
  assert.equal(h.count("drawArrays"), fills + 1);
  assert.equal(h.uniform("uFillT"), fillThreshold(MARK_UNFILL_FLOOR));
});
