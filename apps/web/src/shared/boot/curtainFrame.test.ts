// The loading curtain's rules (curtainFrame.ts): the camera's padding at boot,
// where the map draws France at the measured sizes, tilted and flat (pinned: a
// change to the camera's framing or to the panel's widths must be measured
// again), the outline projected on it, and the fallback's France, centred. Run with `node --import tsx --test` (root "test:scripts").
// Pure: no Vue component, no DOM.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CURTAIN_PEEK_PX,
  PANEL_BASE_PX,
  PANEL_GAP_PX,
  PHONE_SIDE_PX,
  POSTER_W,
  curtainLayout,
  flatFranceAim,
  franceAim,
  inSight,
  insetsFor,
} from "./curtainFrame";
import { projectRings } from "./curtainProject";
import { POSTER_REGIONS, POSTER_VIEWBOX } from "../ui/francePoster";
import { posterRings } from "../ui/francePosterRings";

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(2)} vs ${b.toFixed(2)}`);

test("the camera's padding at boot: card, desktop panel, phone sheet", () => {
  assert.deepEqual(
    [PANEL_BASE_PX, PANEL_GAP_PX, PHONE_SIDE_PX, CURTAIN_PEEK_PX],
    [480, 40, 36, 70],
  );
  assert.deepEqual(insetsFor({ desktop: true, preview: true, peekPx: 70 }), {
    top: 24,
    right: 24,
    bottom: 24,
    left: 24,
  });
  assert.deepEqual(insetsFor({ desktop: true, preview: false, peekPx: 70 }), {
    top: 60,
    right: 520,
    bottom: 60,
    left: 60,
  });
  assert.deepEqual(insetsFor({ desktop: false, preview: false, peekPx: 104 }), {
    top: 30,
    right: 36,
    bottom: 124,
    left: 36,
  });
});

test("the camera's boot framing is insetsFor's (card, desktop, lowered sheet)", () => {
  // usePanelLayout's mapPadding returns insetsFor in those three cases, so the
  // curtain's France and the map's cannot be framed apart.
  const src = readFileSync(
    new URL("../../features/geo-nav/panel/usePanelLayout.ts", import.meta.url),
    "utf8",
  );
  const body = src.slice(src.indexOf("const mapPadding = computed("));
  const calls = body.slice(0, body.indexOf("\n  });")).match(/return insetsFor\(\{[^}]*\}\)/g);
  assert.deepEqual(calls, [
    "return insetsFor({ preview: true, desktop: false, peekPx: 0 })",
    "return insetsFor({ preview: false, desktop: true, peekPx: 0 })",
    "return insetsFor({ preview: false, desktop: false, peekPx: sheet.peekPx.value })",
  ]);
});

/** The live map's France, settled at 45° (the poster's outline through
 *  map.project, dev 828c15d, 2026-11-23): the map's box [w, h] and the
 *  outline's bounding box [x, y, w, h] in it. */
const MEASURED: readonly (readonly [string, number, number, readonly number[]])[] = [
  ["phone 360×740", 360, 740, [91.5, 272.8, 200.5, 132.7]],
  ["phone 412×915", 412, 915, [101.1, 348, 237.1, 157.2]],
  ["tablet 820×1180", 820, 1180, [191, 391.9, 508.2, 331.4]],
  ["desktop 1280×720", 1280, 653.53, [221.4, 179.3, 456.1, 289.4]],
  ["desktop 1440×900", 1440, 833.53, [256.6, 234.5, 562.3, 357.7]],
  ["desktop 1920×1080", 1920, 1013.53, [380.9, 237.4, 867, 544]],
];
/** The same, flat: the map at the curtain's first leaving frame under full
 *  motion (`ac:tier=full`, pitch 0, before the entrance's tilt; lane on dev
 *  828c15d's camera, 2026-11-23). */
const MEASURED_FLAT: readonly (readonly [string, number, number, readonly number[]])[] = [
  ["phone 360×740", 360, 740, [83.4, 240.1, 209.9, 197.3]],
  ["phone 390×844", 390, 844, [88.3, 281.7, 231.7, 217.9]],
  ["phone 412×915", 412, 915, [92, 309.6, 247.8, 232.9]],
  ["tablet 820×1180", 820, 1180, [158.3, 299.4, 546.1, 513.4]],
  ["desktop 1280×720", 1280, 653.53, [211.6, 121, 430.1, 404.3]],
  ["desktop 1440×900", 1440, 833.53, [224.7, 141.5, 575, 540.6]],
  ["desktop 1920×1080", 1920, 1013.53, [397.7, 162.5, 720.1, 676.9]],
];
const rings = POSTER_REGIONS.flatMap((r) => posterRings(r.d));
const bboxOf = (pts: readonly (readonly number[])[]) => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
};
const layoutAt = (w: number, h: number, motion: "full" | "short") =>
  curtainLayout({ w, h, desktop: w >= 900, preview: false, peekPx: CURTAIN_PEEK_PX, motion });

test("the aim is the map's France at every measured size", () => {
  for (const [name, w, h, [x, y, bw, bh]] of MEASURED) {
    const view = inSight(w, h, insetsFor({ desktop: w >= 900, preview: false, peekPx: 70 }));
    const aim = franceAim(view, h);
    near(aim.width, bw, 0.5, `${name} width`);
    near(aim.x, x + bw / 2, 0.6, `${name} centre x`);
    near(aim.y, y + bh / 2, 0.6, `${name} centre y`);
  }
});

test("the flat aim is the flat map's France at every measured size", () => {
  for (const [name, w, h, [x, y, bw, bh]] of MEASURED_FLAT) {
    const view = inSight(w, h, insetsFor({ desktop: w >= 900, preview: false, peekPx: 70 }));
    const aim = flatFranceAim(view, h);
    near(aim.width, bw, 0.5, `${name} width`);
    near(aim.x, x + bw / 2, 0.6, `${name} centre x`);
    near(aim.y, y + bh / 2, 0.6, `${name} centre y`);
  }
});

test("the curtain draws France as the map is shown: flat under full motion, tilted under short", () => {
  for (const [name, w, h, box] of MEASURED_FLAT) {
    const carte = layoutAt(w, h, "full").poster;
    assert.ok(carte.flat, `${name} flat`);
    const got = bboxOf(projectRings(rings, carte).flat());
    for (let k = 0; k < 4; k++) near(got[k], box[k], 1, `${name} flat bbox[${k}]`);
  }
  for (const [name, w, h, box] of MEASURED) {
    const carte = layoutAt(w, h, "short").poster;
    assert.ok(!carte.flat, `${name} tilted`);
    const got = bboxOf(projectRings(rings, carte).flat());
    for (let k = 0; k < 4; k++) near(got[k], box[k], 1, `${name} tilted bbox[${k}]`);
  }
});

test("the fallback's France: as the curtain draws it, its box on the box's centre", () => {
  const sizes: readonly (readonly [number, number])[] = [
    [360, 740],
    [390, 844],
    [412, 915],
    [820, 1180],
    [1280, 653.53],
    [1440, 833.53],
    [1920, 1013.53],
  ];
  for (const [w, h] of sizes)
    for (const motion of ["full", "short"] as const) {
      const name = `${w}×${h} ${motion}`;
      const boot = layoutAt(w, h, motion).poster;
      const mid = curtainLayout({
        w,
        h,
        desktop: w >= 900,
        preview: false,
        peekPx: CURTAIN_PEEK_PX,
        motion,
        centred: true,
      }).poster;
      assert.equal(mid.flat, boot.flat, name);
      const [bx, by, bw, bh] = bboxOf(projectRings(rings, boot).flat());
      const [x, y, mw, mh] = bboxOf(projectRings(rings, mid).flat());
      // The same size and shape, moved whole…
      near(mw, bw, 0.01, `${name} width`);
      near(mh, bh, 0.01, `${name} height`);
      // …its box's centre on the box's.
      near(x + mw / 2, w / 2, 0.01, `${name} centre x`);
      near(y + mh / 2, h / 2, 0.01, `${name} centre y`);
      // Not where the boot framed it, beside the panel or above the strip.
      assert.ok(Math.abs(bx + bw / 2 - w / 2) + Math.abs(by + bh / 2 - h / 2) > 5, name);
    }
});

test("the flat globe keeps the map's shape: France as high as the map draws it", () => {
  // The globe seen from above draws France 0.94 as high as wide; the
  // Mercator drawing is 0.98: a flat box of the drawing would stray ~3 % at
  // the north and the south.
  for (const [name, w, h, box] of MEASURED_FLAT) {
    const carte = layoutAt(w, h, "full").poster;
    const [, , bw, bh] = bboxOf(projectRings(rings, carte).flat());
    near(bh / bw, box[3] / box[2], 0.002, `${name} aspect`);
  }
  const view = { left: 0, top: 0, width: 300, height: 600 };
  assert.deepEqual(
    projectRings(rings, { view, boxH: 700, aim: { x: 0, y: 0, width: 0 }, flat: true }),
    [],
  );
});

test("the poster's outline is read in its own viewBox's units", () => {
  assert.match(POSTER_VIEWBOX, new RegExp(`^0 0 ${POSTER_W} `));
  const [x, , bw] = bboxOf(rings.flat());
  assert.ok(x >= 0 && x + bw <= POSTER_W);
});

test("both stages lay the curtain out alike: the words in the part France is framed in", () => {
  for (const motion of ["full", "short"] as const)
    for (const [w, h] of [
      [360, 740],
      [390, 844],
      [820, 1180],
      [1440, 833.53],
    ]) {
      const base = { w, h, desktop: w >= 900, preview: false, peekPx: 70, motion };
      assert.deepEqual(curtainLayout(base).say, inSight(w, h, insetsFor(base)));
    }
});
