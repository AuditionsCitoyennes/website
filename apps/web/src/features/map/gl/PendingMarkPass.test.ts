// The pending mark's pass (PendingMarkPass.ts), on a recording stand-in for
// the WebGL context: a held mark asks for ONE frame however many are drawn
// (a still map with a mark held stays idle), the fade asks for frames only
// until it ends, a newer mark replaces the older, a commit re-anchors the
// mark on the new lid, each regime's set is built once. Run with
// `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { PendingMarkPass, type PendingMarkSpec } from "./PendingMarkPass";
import { MARK_FADE_MS, type MarkGeometry } from "./pendingMark";
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
const spec = (over: Partial<PendingMarkSpec> = {}): PendingMarkSpec => ({
  id: "fr:dep:69",
  g: square(4),
  stroke: true,
  fill: true,
  raised: false,
  lidM: 0,
  ...over,
});

/** A context that records the calls made on it and answers nothing. */
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
              return {};
            },
    },
  ) as unknown as WebGL2RenderingContext;
  const count = (name: string) => calls.filter((c) => c.name === name).length;
  return { gl, calls, count };
}

/** A program whose locations are all there (the hover fill's, for the flat fill). */
const prog = { prog: {}, attr: { aPos: 0, aDist: 1 }, uni: {} } as unknown as GlProg;
const MATRIX = new Float64Array(16);

/** The clock the pass reads, by hand. */
function clock() {
  const real = performance.now;
  let t = 1000;
  performance.now = () => t;
  return {
    advance: (ms: number) => (t += ms),
    restore: () => (performance.now = real),
  };
}

function harness() {
  let repaints = 0;
  const pass = new PendingMarkPass(() => repaints++);
  const { gl, calls, count } = fakeGl();
  /** One mercator frame: the fill's moment, then the stroke's. */
  const frame = (scale = 1) => {
    pass.drawMercator(gl, MATRIX, scale, "fill", prog);
    pass.drawMercator(gl, MATRIX, scale, "stroke", null);
  };
  return { pass, gl, calls, count, frame, repaints: () => repaints };
}

test("a held mark asks for one frame, and none for as long as it is drawn", () => {
  const { pass, frame, repaints, count } = harness();
  pass.set(spec());
  assert.equal(repaints(), 1);
  assert.equal(pass.active, true);
  assert.equal(pass.id, "fr:dep:69");
  for (let i = 0; i < 200; i++) frame();
  assert.equal(repaints(), 1); // a still map with a mark held stays idle
  assert.equal(count("drawArrays"), 200); // the fill, each frame
  assert.equal(count("bufferData"), 2); // its set built and uploaded once
});

test("the fade asks for frames only until it ends, then the mark is gone", () => {
  const c = clock();
  try {
    const { pass, frame, repaints, count } = harness();
    pass.set(spec());
    frame();
    pass.commit(1500, true);
    assert.equal(repaints(), 2); // the set, the commit
    assert.equal(pass.state()?.fading, true);
    assert.equal(pass.state()?.raised, true);
    let frames = 0;
    // A frame every 16 ms for a second: the pass asks for the next one only while fading.
    for (let i = 0; i < 60; i++) {
      c.advance(16);
      const before = repaints();
      frame();
      if (repaints() > before) frames++;
    }
    assert.ok(frames >= 5 && frames <= Math.ceil(MARK_FADE_MS / 16), `${frames} frames asked`);
    assert.equal(pass.active, false);
    const drawn = count("drawArrays");
    const asked = repaints();
    for (let i = 0; i < 50; i++) frame();
    assert.equal(count("drawArrays"), drawn); // nothing left to draw
    assert.equal(repaints(), asked); // and no frame asked for
  } finally {
    c.restore();
  }
});

test("reduced motion: the commit switches the mark off at once", () => {
  const { pass, frame, repaints, count } = harness();
  pass.set(spec());
  frame();
  pass.commit(1500, false);
  assert.equal(pass.active, false);
  assert.equal(repaints(), 2);
  const drawn = count("drawArrays");
  frame();
  assert.equal(count("drawArrays"), drawn);
  assert.equal(repaints(), 2);
});

test("the last tap wins: a newer mark replaces the older in one repaint", () => {
  const { pass, frame, repaints, count } = harness();
  pass.set(spec({ id: "a" }));
  frame();
  pass.set(spec({ id: "b", g: square(8) }));
  assert.equal(pass.id, "b");
  assert.equal(repaints(), 2);
  frame();
  assert.equal(count("bufferData"), 4); // b's set built for its first frame
});

test("a commit re-anchors the mark: its set is built again, on the lid", () => {
  const c = clock();
  try {
    const { pass, frame, calls } = harness();
    pass.set(spec());
    frame();
    const ground = (calls.find((x) => x.name === "bufferData")!.args[1] as Float32Array)[2];
    pass.commit(2000, true);
    c.advance(10);
    frame();
    const uploads = calls.filter((x) => x.name === "bufferData");
    assert.equal(uploads.length, 4);
    const lid = (uploads[2].args[1] as Float32Array)[2];
    assert.ok(lid > ground * 100, "the stroke stands at lid height");
    // Raised: the depth test off for its draw; ground: on.
    assert.ok(calls.some((x) => x.name === "disable" && x.args[0] === "DEPTH_TEST"));
  } finally {
    c.restore();
  }
});

test("the mark never writes depth, and hands the frame back tested and written", () => {
  const { pass, frame, calls } = harness();
  pass.set(spec());
  frame();
  const masks = calls.filter((x) => x.name === "depthMask").map((x) => x.args[0]);
  assert.deepEqual(masks, [false, true]);
  assert.deepEqual(calls.at(-1), { name: "enable", args: ["DEPTH_TEST"] });
});

test("clear: no mark, one repaint; a second clear asks for nothing", () => {
  const { pass, frame, repaints, count } = harness();
  pass.set(spec());
  pass.clear();
  assert.equal(repaints(), 2);
  pass.clear();
  assert.equal(repaints(), 2);
  frame();
  assert.equal(count("drawArrays"), 0);
  assert.equal(pass.state(), null);
});

test("nothing asked for: no mark at all", () => {
  const { pass } = harness();
  pass.set(spec({ stroke: false, fill: false }));
  assert.equal(pass.active, false);
});

test("a geometry no builder reads: given up, never retried, never thrown", () => {
  const { pass, frame, count } = harness();
  pass.set(spec({ g: { type: "Polygon", coordinates: [] } }));
  for (let i = 0; i < 5; i++) frame();
  assert.equal(count("drawArrays"), 0);
  assert.equal(count("bufferData"), 0);
});

test("the globe draws a mark in its own pass only: ground before the walls, raised after", () => {
  const { pass, gl, count } = harness();
  const binders = { setCommon: () => {}, bindTriple: () => {} };
  pass.set(spec({ raised: false }));
  pass.drawGlobe(gl, binders, true, "fill", prog);
  assert.equal(count("drawArrays"), 0);
  pass.drawGlobe(gl, binders, false, "fill", prog);
  assert.equal(count("drawArrays"), 1);
  pass.set(spec({ raised: true, lidM: 1000 }));
  pass.drawGlobe(gl, binders, false, "fill", prog);
  assert.equal(count("drawArrays"), 1);
  pass.drawGlobe(gl, binders, true, "fill", prog);
  assert.equal(count("drawArrays"), 2);
});
