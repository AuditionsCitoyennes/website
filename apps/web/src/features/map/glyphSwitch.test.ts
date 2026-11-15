// The labels' letters switch (glyphSwitch.ts): which devices draw them with
// the site's font, the plan and the map options each case gives, the wait for
// the font and the tile requests held for it, the kept mode read back from
// storage, and the face's ranges against the site's own stylesheet. Run with `node --import tsx --test`
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
  LABEL_FONT_WAIT_MS,
  LABEL_SUBSETS,
  LABEL_WEIGHTS,
  TILE_REQUEST,
  fontHoldMs,
  glyphMapOptions,
  glyphs,
  labelFontPlan,
  labelsLocal,
  settleWithin,
  storedGlyphs,
  tilesAfterFont,
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
  land(true); // the font lands after the wait: the verdict was the system's font
  assert.equal(await slow, false);
});

test("the wait with a real timer runs out", async () => {
  assert.equal(await settleWithin(new Promise<boolean>(() => {}), 5), false);
});

test("a tile's wait is what is left of the time since the first map was made", () => {
  // Asked as the map is made: the whole wait. Later: what is left. Past it: none.
  assert.equal(fontHoldMs(1000, 1000), LABEL_FONT_WAIT_MS);
  assert.equal(fontHoldMs(1000, 1400), LABEL_FONT_WAIT_MS - 400);
  assert.equal(fontHoldMs(1000, 1000 + LABEL_FONT_WAIT_MS), 0);
  assert.equal(fontHoldMs(1000, 9000), 0);
  // No map made yet: the whole wait, never more (a clock read before `madeAt` too).
  assert.equal(fontHoldMs(null, 5000), LABEL_FONT_WAIT_MS);
  assert.equal(fontHoldMs(1000, 900), LABEL_FONT_WAIT_MS);
  assert.equal(fontHoldMs(1000, 1100, 300), 200);
});

test("tile requests wait for the font, every other request goes at once", async () => {
  let settle: () => void = () => {};
  let pending: Promise<void> | null = new Promise<void>((r) => (settle = r));
  const seen: string[] = [];
  const next = (url: string, type?: string, opts?: { tag: string }) => {
    seen.push(`${type}:${url}:${opts?.tag ?? ""}`);
    return { url: `${url}?x` };
  };
  const gate = tilesAfterFont(() => pending, next);

  // The style, the sprite, a source's description: straight through, the
  // map's own answer returned as it is (not a promise).
  assert.deepEqual(gate("style.json", "Style"), { url: "style.json?x" });
  assert.deepEqual(gate("sprite.png", "SpriteImage"), { url: "sprite.png?x" });
  assert.deepEqual(gate("tiles.json", "Source"), { url: "tiles.json?x" });
  assert.deepEqual(seen, ["Style:style.json:", "SpriteImage:sprite.png:", "Source:tiles.json:"]);

  // A tile: held, with its own arguments, until the font is settled.
  const held = gate("3/4/2.pbf", TILE_REQUEST, { tag: "a" });
  assert.ok(held instanceof Promise);
  await Promise.resolve();
  assert.equal(seen.length, 3, "not sent while the font is on its way");
  settle();
  assert.deepEqual(await held, { url: "3/4/2.pbf?x" });
  assert.equal(seen[3], "Tile:3/4/2.pbf:a");

  // Settled: tiles go at once from then on, the answer no longer a promise.
  pending = null;
  assert.deepEqual(gate("3/4/3.pbf", TILE_REQUEST), { url: "3/4/3.pbf?x" });
});

test("a held tile goes even when the wait fails, and a map without its own hook answers nothing", async () => {
  const seen: string[] = [];
  const gate = tilesAfterFont(
    () => Promise.reject(new Error("no font")),
    (url: string) => void seen.push(url),
  );
  await gate("1/0/0.pbf", TILE_REQUEST);
  assert.deepEqual(seen, ["1/0/0.pbf"]);

  // No hook of its own (the lid's hidden map): `undefined`, which Mapbox
  // reads as "the URL as it is", at once or after the wait.
  const bare = tilesAfterFont(() => Promise.resolve());
  assert.equal(bare("style.json", "Style"), undefined);
  assert.equal(await bare("1/0/0.pbf", TILE_REQUEST), undefined);
});
