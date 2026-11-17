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

test("the line's colours: three of the map's violets, none near white, each darker than the plain violet boundary line", () => {
  assert.deepEqual([...tap.TAP_LINE_COLORS], ["deep", "indigo", "site"]);
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
  assert.equal(Math.min(...lum), lum[1]);
  assert.ok((violet + 0.05) / (lum[1] + 0.05) >= 3);
});

test("every line colour is a violet of the palette: blue first, green last, never red, magenta or pink", () => {
  for (const c of tap.TAP_LINE_COLORS) {
    const [r, g, b] = tap.TAP_LINE_RGB[c];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    assert.equal(max, b, `${c}: blue is the largest channel`);
    assert.equal(min, g, `${c}: green is the smallest channel`);
    // Hue, degrees (blue is the largest channel): 240 + 60 × (r − g) / (max − min).
    const hue = 240 + (60 * (r - g)) / (max - min);
    assert.ok(hue >= 245 && hue <= 272, `${c}: hue ${hue}`);
    const lightness = (max + min) / 2;
    assert.ok(lightness <= 0.45, `${c}: lightness ${lightness}`);
    assert.ok(r <= 0.65 * b, `${c}: red ${r} against blue ${b}`);
  }
});

test("a line colour kept by an earlier build reads as the default", () => {
  for (const old of ["magenta", "violet", "red", "pink"]) {
    assert.equal((tap.TAP_LINE_COLORS as readonly string[]).includes(old), false, old);
  }
  assert.equal(tap.DEFAULT_TAP_LINE, "deep");
  const src = readFileSync(new URL("./tapAnswerSwitch.ts", import.meta.url), "utf8");
  assert.match(src, /stored\("ac:tap-line", TAP_LINE_COLORS, DEFAULT_TAP_LINE\)/);
  assert.doesNotMatch(src, /BE1480|0\.745, 0\.078, 0\.502/i);
});

test("a build without the testing tools keeps the defaults and ignores the setters", () => {
  assert.equal(tap.DEFAULT_TAP_ANSWER, "line");
  assert.equal(tap.DEFAULT_TAP_LINE, "deep");
  assert.equal(tap.DEFAULT_TAP_STEPS, "steps");
  assert.equal(tap.DEFAULT_TAP_END, "then");
  assert.equal(tap.DEFAULT_TAP_FRAME, "same");
  tap.setTapAnswerMode("off");
  tap.setTapLineColor("indigo");
  tap.setTapStepsMode("creep");
  tap.setTapEndMode("together");
  tap.setTapFrameMode("own");
  assert.equal(tap.tapAnswerMode.value, "line");
  assert.equal(tap.tapLineColor.value, "deep");
  assert.equal(tap.tapStepsMode.value, "steps");
  assert.equal(tap.tapEndMode.value, "then");
  assert.equal(tap.tapFrameMode.value, "same");
  assert.deepEqual([...tap.TAP_STEPS_MODES], ["steps", "creep"]);
  assert.deepEqual([...tap.TAP_END_MODES], ["then", "together"]);
  assert.deepEqual([...tap.TAP_FRAME_MODES], ["same", "own"]);
});
