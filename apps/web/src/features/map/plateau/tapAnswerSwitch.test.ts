// The answer to a tap, its switches' pure part (tapAnswerSwitch.ts): what the
// pending mark is made of under each mode, the same for every pointer, the
// line's colours, and the defaults of a build without the testing tools. Run
// with `node --import tsx --test` (root "test:scripts"). The module is
// loaded as a build without the testing tools: storage unread.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

(globalThis as unknown as { __TEST_TOOLS__: boolean }).__TEST_TOOLS__ = false;
const tap = await import("./tapAnswerSwitch");

test("line: the fill, the line and the pill, whatever made the tap", () => {
  assert.deepEqual(tap.tapMarkFor("line"), { line: true, fill: true, pill: true });
  assert.equal(tap.tapMarkFor.length, 1); // no pointer type: one behaviour
});

test("off: no mark at all", () => {
  assert.deepEqual(tap.tapMarkFor("off"), { line: false, fill: false, pill: false });
});

test("a mode kept by an earlier build is not a mode: it falls to the default", () => {
  assert.deepEqual([...tap.TAP_ANSWER_MODES], ["line", "off"]);
  for (const old of ["auto", "stroke", "fill"]) {
    assert.equal((tap.TAP_ANSWER_MODES as readonly string[]).includes(old), false, old);
  }
  // The read is `stored(key, the allowed list, the default)`: anything else is the default.
  const src = readFileSync(new URL("./tapAnswerSwitch.ts", import.meta.url), "utf8");
  assert.match(src, /stored\("ac:tap-answer", TAP_ANSWER_MODES, DEFAULT_TAP_ANSWER\)/);
});

test("the line's colours: three, none near white, each darker than the plain violet boundary line", () => {
  assert.deepEqual([...tap.TAP_LINE_COLORS], ["magenta", "violet", "indigo"]);
  const luminance = ([r, g, b]: readonly number[]) => {
    const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const lum = tap.TAP_LINE_COLORS.map((c) => luminance(tap.TAP_LINE_RGB[c]));
  for (const l of lum) assert.ok(l < 0.25, `luminance ${l}`);
  // The plain violet boundary line (#7C5CFF): every candidate is darker than
  // it; indigo, the darkest, reads against it by lightness alone (3:1).
  const violet = luminance([0.486, 0.361, 1.0]);
  for (const l of lum) assert.ok(l < violet, `luminance ${l}`);
  assert.equal(Math.min(...lum), lum[2]);
  assert.ok((violet + 0.05) / (lum[2] + 0.05) >= 3);
  // The default stands out by its hue: more red than blue, where the fill
  // and the boundary lines are blue first.
  const [r, , b] = tap.TAP_LINE_RGB[tap.DEFAULT_TAP_LINE];
  assert.ok(r > b);
});

test("a build without the testing tools keeps the defaults and ignores the setters", () => {
  assert.equal(tap.DEFAULT_TAP_ANSWER, "line");
  assert.equal(tap.DEFAULT_TAP_LINE, "magenta");
  assert.equal(tap.DEFAULT_TAP_STEPS, "steps");
  assert.equal(tap.DEFAULT_TAP_END, "then");
  assert.equal(tap.DEFAULT_TAP_FRAME, "same");
  tap.setTapAnswerMode("off");
  tap.setTapLineColor("indigo");
  tap.setTapStepsMode("creep");
  tap.setTapEndMode("together");
  tap.setTapFrameMode("own");
  assert.equal(tap.tapAnswerMode.value, "line");
  assert.equal(tap.tapLineColor.value, "magenta");
  assert.equal(tap.tapStepsMode.value, "steps");
  assert.equal(tap.tapEndMode.value, "then");
  assert.equal(tap.tapFrameMode.value, "same");
  assert.deepEqual([...tap.TAP_STEPS_MODES], ["steps", "creep"]);
  assert.deepEqual([...tap.TAP_END_MODES], ["then", "together"]);
  assert.deepEqual([...tap.TAP_FRAME_MODES], ["same", "own"]);
});
