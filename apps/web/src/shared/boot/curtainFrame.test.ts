// The loading curtain's rules (curtainFrame.ts): the camera's padding at boot,
// where the map draws France at the measured sizes (pinned: a change to the
// camera's framing or to the panel's widths must be measured again), the
// tilted and flat posters on it, today's places under "avant", and one layout
// for both stages. Run with `node --import tsx --test` (root "test:scripts").
// Pure: no Vue component, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CURTAIN_PEEK_PX,
  PANEL_BASE_PX,
  PANEL_GAP_PX,
  PHONE_SIDE_PX,
  POSTER_H,
  POSTER_OUTLINE,
  POSTER_W,
  curtainLayout,
  flatPosterRect,
  franceAim,
  inSight,
  insetsFor,
  type CurtainLayout,
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

/** The live map's France (the poster's outline through map.project, dev
 *  828c15d, 2026-11-23): the map's box [w, h] and the outline's bounding box
 *  [x, y, w, h] in it. */
const MEASURED: readonly (readonly [string, number, number, readonly number[]])[] = [
  ["phone 360×740", 360, 740, [91.5, 272.8, 200.5, 132.7]],
  ["phone 412×915", 412, 915, [101.1, 348, 237.1, 157.2]],
  ["tablet 820×1180", 820, 1180, [191, 391.9, 508.2, 331.4]],
  ["desktop 1280×720", 1280, 653.53, [221.4, 179.3, 456.1, 289.4]],
  ["desktop 1440×900", 1440, 833.53, [256.6, 234.5, 562.3, 357.7]],
  ["desktop 1920×1080", 1920, 1013.53, [380.9, 237.4, 867, 544]],
];
const rings = POSTER_REGIONS.flatMap((r) => posterRings(r.d));
const bboxOf = (pts: readonly (readonly number[])[]) => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
};
const layoutAt = (w: number, h: number, mode: "carte" | "plat") =>
  curtainLayout({
    w,
    h,
    desktop: w >= 900,
    preview: false,
    peekPx: CURTAIN_PEEK_PX,
    mode,
    from: { stage: "stage" },
  });

test("the aim is the map's France at every measured size", () => {
  for (const [name, w, h, [x, y, bw, bh]] of MEASURED) {
    const view = inSight(w, h, insetsFor({ desktop: w >= 900, preview: false, peekPx: 70 }));
    const aim = franceAim(view, h);
    near(aim.width, bw, 0.5, `${name} width`);
    near(aim.x, x + bw / 2, 0.6, `${name} centre x`);
    near(aim.y, y + bh / 2, 0.6, `${name} centre y`);
  }
});

test("the tilted poster lies on the map's France, the flat one on its width and centre", () => {
  for (const [name, w, h, box] of MEASURED) {
    const carte = layoutAt(w, h, "carte").poster;
    assert.equal(carte.kind, "carte");
    if (carte.kind !== "carte") continue;
    const got = bboxOf(projectRings(rings, carte).flat());
    for (let k = 0; k < 4; k++) near(got[k], box[k], 1, `${name} tilted bbox[${k}]`);

    const flat = layoutAt(w, h, "plat").poster;
    assert.equal(flat.kind, "rect");
    if (flat.kind !== "rect") continue;
    const unit = flat.rect.width / POSTER_W;
    near(flat.rect.height, POSTER_H * unit, 1e-9, `${name} flat aspect`);
    near((POSTER_OUTLINE.right - POSTER_OUTLINE.left) * unit, box[2], 0.5, `${name} flat width`);
    near(
      flat.rect.left + ((POSTER_OUTLINE.left + POSTER_OUTLINE.right) / 2) * unit,
      box[0] + box[2] / 2,
      0.6,
      `${name} flat centre`,
    );
  }
});

test("the poster's outline fills the box the rules read", () => {
  assert.equal(POSTER_VIEWBOX, `0 0 ${POSTER_W} ${POSTER_H}`);
  const [x, y, bw, bh] = bboxOf(rings.flat());
  assert.deepEqual(
    [x, y, x + bw, y + bh],
    [POSTER_OUTLINE.left, POSTER_OUTLINE.top, POSTER_OUTLINE.right, POSTER_OUTLINE.bottom],
  );
  assert.equal(flatPosterRect({ x: 0, y: 0, width: 0 }).width, 0);
});

test("both stages lay the curtain out alike, whatever the boot curtain's live measures", () => {
  for (const mode of ["carte", "plat"] as const)
    for (const [w, h] of [
      [360, 740],
      [390, 844],
      [820, 1180],
      [1440, 833.53],
    ]) {
      const base = { w, h, desktop: w >= 900, preview: false, peekPx: 70, mode };
      const a: CurtainLayout = curtainLayout({ ...base, from: { stage: "stage" } });
      const b = curtainLayout({
        ...base,
        from: { stage: "geo", mapOnly: true, sheet: w < 900, cover: 480, peek: 72, held: true },
      });
      assert.deepEqual(a, b);
      // The words in the part France is framed in.
      assert.deepEqual(a.say, inSight(w, h, insetsFor(base)));
    }
});

test("« avant »: each stage's places before", () => {
  const stage = curtainLayout({
    w: 1440,
    h: 833.5,
    desktop: true,
    preview: false,
    peekPx: 70,
    mode: "avant",
    from: { stage: "stage" },
  });
  assert.equal(stage.poster.kind, "rect");
  if (stage.poster.kind === "rect") {
    const r = stage.poster.rect;
    near(r.left, 144, 1e-9, "left");
    near(r.top, 83.35, 1e-9, "top");
    near(r.width, 1152, 1e-9, "width");
    near(r.height, 666.8, 1e-9, "height");
  }
  assert.deepEqual(stage.say, { left: 0, top: 0, width: 1440, height: 833.5 });
  const desk = curtainLayout({
    w: 1440,
    h: 833.5,
    desktop: true,
    preview: false,
    peekPx: 70,
    mode: "avant",
    from: { stage: "geo", mapOnly: true, sheet: false, cover: 480, peek: 72, held: true },
  });
  assert.equal(desk.poster.kind === "rect" && desk.poster.rect.width, 1152 - 480);
  assert.equal(desk.say.width, 960);
  const phone = (held: boolean) =>
    curtainLayout({
      w: 360,
      h: 740,
      desktop: false,
      preview: false,
      peekPx: 70,
      mode: "avant",
      from: { stage: "geo", mapOnly: true, sheet: true, cover: 0, peek: 70, held },
    });
  const held = phone(true).poster;
  assert.equal(held.kind === "rect" && held.rect.height, 592 - 70);
  assert.equal(phone(true).say.height, 740);
  assert.equal(phone(false).say.height, 670);
  // The card: the whole box, as StageLoading.
  const card = curtainLayout({
    w: 600,
    h: 400,
    desktop: true,
    preview: true,
    peekPx: 70,
    mode: "avant",
    from: { stage: "geo", mapOnly: false, sheet: false, cover: 0, peek: 72, held: false },
  });
  assert.deepEqual(
    card,
    curtainLayout({
      ...{ w: 600, h: 400, desktop: true, preview: true, peekPx: 70, mode: "avant" },
      from: { stage: "stage" },
    }),
  );
});
