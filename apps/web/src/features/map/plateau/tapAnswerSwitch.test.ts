// The answer to a tap (tapAnswerSwitch.ts): what the pending mark is made of,
// the same for every pointer, and the loading line's colour. Run with
// `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { TAP_LINE_RGB, TAP_MARK } from "./tapAnswerSwitch";

test("the mark: the fill and the line, no pill, whatever made the tap", () => {
  assert.deepEqual(TAP_MARK, { line: true, fill: true });
});

const luminance = ([r, g, b]: readonly number[]) => {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

test("the line's colour: #3514B8, the map's violet darker, not near white", () => {
  assert.deepEqual(
    TAP_LINE_RGB.map((v) => Math.round(v * 255)),
    [0x35, 0x14, 0xb8],
  );
  const lum = luminance(TAP_LINE_RGB);
  assert.ok(lum < 0.25, `luminance ${lum}`);
  // Darker than the plain violet boundary line (#7C5CFF).
  assert.ok(lum < luminance([0.486, 0.361, 1.0]));
});

test("the line's colour is a violet of the palette: blue first, green last, never red, magenta or pink", () => {
  const [r, g, b] = TAP_LINE_RGB;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  assert.equal(max, b, "blue is the largest channel");
  assert.equal(min, g, "green is the smallest channel");
  // Hue, degrees (blue is the largest channel): 240 + 60 × (r − g) / (max − min).
  const hue = 240 + (60 * (r - g)) / (max - min);
  assert.ok(hue >= 245 && hue <= 272, `hue ${hue}`);
  assert.ok((max + min) / 2 <= 0.45, "lightness");
  assert.ok(r <= 0.65 * b, `red ${r} against blue ${b}`);
});
