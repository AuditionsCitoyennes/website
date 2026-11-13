// The labels' letters switch (glyphSwitch.ts): which devices draw them with
// the site's font, the plan and the map options each case gives, the wait for
// the font, the kept mode read back from storage, and the face's ranges
// against the site's own stylesheet. Run with `node --import tsx --test`
// (root "test:scripts"). Pure: no Vue component, no DOM.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

(globalThis as unknown as { __TEST_TOOLS__: boolean }).__TEST_TOOLS__ = false;
const {
  DEFAULT_GLYPHS,
  GLYPHS,
  LABEL_FACE,
  LABEL_FAMILIES,
  LABEL_SUBSETS,
  LABEL_WEIGHTS,
  glyphMapOptions,
  glyphs,
  labelFontPlan,
  labelsLocal,
  settleWithin,
  storedGlyphs,
} = await import("./glyphSwitch");

/** A localStorage stand-in for one test, removed after it. */
function withStorage(storage: unknown, run: () => void) {
  const g = globalThis as { localStorage?: unknown };
  const had = Object.prototype.hasOwnProperty.call(g, "localStorage");
  const before = g.localStorage;
  Object.defineProperty(g, "localStorage", { value: storage, configurable: true });
  try {
    run();
  } finally {
    if (had) Object.defineProperty(g, "localStorage", { value: before, configurable: true });
    else delete g.localStorage;
  }
}
const kept = (value: string | null) => ({
  getItem: (k: string) => (k === "ac:glyphs" ? value : null),
});

test("the default is auto, and a build without the testing tools reads no storage", () => {
  assert.equal(DEFAULT_GLYPHS, "auto");
  assert.deepEqual([...GLYPHS], ["auto", "mapbox", "local"]);
  assert.equal(glyphs, "auto");
});

test("the kept mode is read back; garbage, none or a blocked storage give the default", () => {
  for (const m of GLYPHS) withStorage(kept(m), () => assert.equal(storedGlyphs(), m));
  for (const v of [null, "", "server", "LOCAL", "style"]) {
    withStorage(kept(v), () => assert.equal(storedGlyphs(), "auto"));
  }
  withStorage(
    {
      getItem: () => {
        throw new Error("blocked");
      },
    },
    () => assert.equal(storedGlyphs(), "auto"),
  );
  withStorage(undefined, () => assert.equal(storedGlyphs(), "auto"));
});

test("auto draws locally on the weak tiers only; the two others force their way", () => {
  assert.equal(labelsLocal("auto", "full"), false);
  assert.equal(labelsLocal("auto", "light"), true);
  assert.equal(labelsLocal("auto", "minimal"), true);
  for (const tier of ["full", "light", "minimal"] as const) {
    assert.equal(labelsLocal("mapbox", tier), false, tier);
    assert.equal(labelsLocal("local", tier), true, tier);
  }
});

test("the plan and the map options: today's for mapbox, the site's face or the system's", () => {
  assert.equal(labelFontPlan(false, "loaded"), "mapbox");
  assert.equal(labelFontPlan(false, "missing"), "mapbox");
  assert.equal(labelFontPlan(true, "loaded"), "site");
  assert.equal(labelFontPlan(true, "missing"), "system");
  // "mapbox" adds no option at all: the map is made exactly as before.
  assert.deepEqual(glyphMapOptions("mapbox"), {});
  assert.deepEqual(glyphMapOptions("site"), {
    localFontFamily: `"${LABEL_FACE}", system-ui, sans-serif`,
  });
  // The system's plan never names the site's face: a face landing midway
  // would mix two fonts in one name.
  assert.deepEqual(glyphMapOptions("system"), { localFontFamily: "system-ui, sans-serif" });
  assert.ok(!LABEL_FAMILIES.system.includes(LABEL_FACE));
  assert.ok(!LABEL_FAMILIES.site.includes("Source Sans"), "its own name, not the page's face");
});

test("two faces: the light-to-medium one stops under 500, the bold one is a bold face", () => {
  // The browser's matching itself was checked in a page (canvas widths: a
  // request of 500 measures as Source Sans at 450, of 900 as at 600).
  const [light, bold] = LABEL_WEIGHTS.map((w) => w.split(" ").map(Number));
  assert.equal(LABEL_WEIGHTS.length, 2);
  // Mapbox's "Light" (200) and regular (400) drawn as asked; its "Medium"
  // (500) finds nothing between 500 and itself, then the nearest under it.
  assert.equal(light[0], 200);
  assert.ok(light.at(-1)! >= 400 && light.at(-1)! < 500);
  // Its "Bold" (900) finds nothing over it, then the heaviest face: at 600 or
  // more the browser adds no synthetic bold.
  assert.equal(bold.length, 1);
  assert.ok(bold[0] >= 600 && bold[0] < 900);
});

test("the face's subsets and ranges are the site stylesheet's own", () => {
  const require = createRequire(import.meta.url);
  const css = readFileSync(require.resolve("@fontsource-variable/source-sans-3/index.css"), "utf8");
  assert.deepEqual(
    LABEL_SUBSETS.map((s) => s.subset),
    ["latin", "latin-ext"],
  );
  for (const { subset, unicodeRange } of LABEL_SUBSETS) {
    const block = new RegExp(
      `/\\* source-sans-3-${subset}-wght-normal \\*/\\s*@font-face \\{([^}]*)\\}`,
    ).exec(css);
    assert.ok(block, subset);
    assert.match(block[1], new RegExp(`files/source-sans-3-${subset}-wght-normal\\.woff2`));
    assert.equal(/unicode-range: ([^;]+);/.exec(block[1])![1], unicodeRange, subset);
  }
});

/** A timer the test fires by hand. */
function handTimer() {
  const due: (() => void)[] = [];
  return { timer: (run: () => void) => void due.push(run), fire: () => due.forEach((r) => r()) };
}

test("the wait: the load's answer when it comes first, false when the time runs out", async () => {
  const t1 = handTimer();
  const loaded = settleWithin(Promise.resolve(true), 1500, t1.timer);
  assert.equal(await loaded, true);
  t1.fire(); // too late to change anything
  assert.equal(await loaded, true);

  const t2 = handTimer();
  assert.equal(await settleWithin(Promise.resolve(false), 1500, t2.timer), false);
  const t3 = handTimer();
  assert.equal(await settleWithin(Promise.reject(new Error("404")), 1500, t3.timer), false);

  const t4 = handTimer();
  let land: (v: boolean) => void = () => {};
  const slow = settleWithin(new Promise<boolean>((r) => (land = r)), 1500, t4.timer);
  t4.fire();
  land(true); // the font lands after the wait: the map was already made without it
  assert.equal(await slow, false);
});

test("the wait with a real timer runs out", async () => {
  assert.equal(await settleWithin(new Promise<boolean>(() => {}), 5), false);
});
