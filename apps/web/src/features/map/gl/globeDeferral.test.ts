// The plateau's deferred globe set (globeDeferral.ts, ac:mesh=merc): which
// builds may wait, and the generations that keep a held build from landing
// over a newer mesh. Run with `node --import tsx --test` (root
// "test:scripts"). Pure: no DOM, no alias at run time.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GLOBE_PASS_DELAY_MS,
  LAZY_GLOBE_MIN_ZCANON,
  LAZY_GLOBE_MIN_ZOOM,
  createGlobeDeferral,
  globeSetMode,
} from "./globeDeferral";

test("the constants: a canonical zoom of 8 (a flat fit zoom of 7), a camera at 6.5, half a second after idle", () => {
  assert.equal(LAZY_GLOBE_MIN_ZCANON, 8);
  assert.equal(LAZY_GLOBE_MIN_ZOOM, 6.5);
  assert.equal(GLOBE_PASS_DELAY_MS, 500);
});

test("lazy only for a deep fit applied with the camera clear of the globe", () => {
  // [zCanon, zoom at the build, mode]
  const table: [number, number, "eager" | "lazy"][] = [
    [5, 4.8, "eager"], // France
    [7, 6.25, "eager"], // Auvergne-Rhône-Alpes
    [7, 9, "eager"], // a canonical zoom of 7 waits for nothing, wherever the camera is
    [8, 6.49, "eager"], // just under the camera's bar
    [8, 6.5, "lazy"], // on it
    [8, 6.79, "lazy"], // Provence-Alpes-Côte d'Azur at rest
    [9, 6.25, "eager"], // Auvergne-Rhône-Alpes → Rhône: built while the camera leaves 6.25
    [9, 4.8, "eager"], // France → anything
    [9, 8.71, "lazy"], // Rhône at rest
    [13, 12, "lazy"], // a commune
  ];
  for (const [zCanon, zoom, mode] of table) {
    assert.equal(globeSetMode(zCanon, zoom), mode, `zCanon ${zCanon}, zoom ${zoom}`);
  }
});

test("a lazy build's inputs are claimed by its own generation only", () => {
  const d = createGlobeDeferral<string>();
  const g = d.begin("rhone");
  assert.equal(d.current, g);
  assert.equal(d.claim(g - 1), null);
  assert.equal(d.claim(g), "rhone");
  assert.equal(d.claim(g), "rhone", "a claim alone does not consume them");
});

test("a newer setGeometry invalidates a pending build", () => {
  const d = createGlobeDeferral<string>();
  const g1 = d.begin("rhone");
  const g2 = d.begin("lyon");
  assert.equal(d.claim(g1), null);
  assert.equal(d.claim(g2), "lyon");
});

test("a teardown (an eager call with nothing held) invalidates a pending build", () => {
  const d = createGlobeDeferral<string>();
  const g = d.begin("rhone");
  const teardown = d.begin();
  assert.equal(d.claim(g), null);
  assert.equal(d.claim(teardown), null);
});

test("an eager call after a lazy one cancels it", () => {
  const d = createGlobeDeferral<string>();
  const lazy = d.begin("paca");
  const eager = d.begin(null);
  assert.equal(d.claim(lazy), null);
  assert.equal(d.claim(eager), null);
});

test("a late build (the first globe frame) marks the generation built: the idle pass then no-ops", () => {
  const d = createGlobeDeferral<string>();
  const g = d.begin("rhone");
  assert.equal(d.claim(g), "rhone"); // renderGlobe's ensureGlobe
  d.markBuilt(g);
  assert.equal(d.claim(g), null); // the idle pass, later
});

test("markBuilt of a stale generation leaves the newer one held", () => {
  const d = createGlobeDeferral<string>();
  const g1 = d.begin("rhone");
  const g2 = d.begin("lyon");
  d.markBuilt(g1);
  assert.equal(d.claim(g2), "lyon");
});

test("cancel (the layer removed) drops what is held", () => {
  const d = createGlobeDeferral<string>();
  const g = d.begin("bdr");
  d.cancel();
  assert.equal(d.claim(g), null);
  const g2 = d.begin("bdr");
  assert.equal(d.claim(g2), "bdr", "a later lazy call holds again");
});

test("a build that answers later is asked for once per generation", () => {
  const d = createGlobeDeferral<string>();
  const g = d.begin("rhone");
  assert.equal(d.asking(g), false);
  assert.equal(d.ask(g), "rhone");
  assert.equal(d.asking(g), true);
  assert.equal(d.ask(g), null, "in flight: not asked twice");
  // The page may still claim it (a globe frame that does not wait): it is then built.
  assert.equal(d.claim(g), "rhone");
  d.markBuilt(g);
  assert.equal(d.asking(g), false, "built meanwhile: the answer is no longer wanted");
  assert.equal(d.claim(g), null);
});

test("an ask of a stale, built, cancelled or eager generation gets nothing", () => {
  const d = createGlobeDeferral<string>();
  const g1 = d.begin("rhone");
  const g2 = d.begin("lyon");
  assert.equal(d.ask(g1), null);
  assert.equal(d.asking(g1), false);
  assert.equal(d.ask(g2), "lyon");
  const g3 = d.begin("bdr");
  assert.equal(d.asking(g2), false, "a newer mesh: the old ask is not wanted");
  d.markBuilt(g3);
  assert.equal(d.ask(g3), null);
  const g4 = d.begin("paca");
  d.cancel();
  assert.equal(d.ask(g4), null);
  assert.equal(d.asking(g4), false);
  const eager = d.begin();
  assert.equal(d.ask(eager), null);
});

test("an ask that came back empty is not asked again: the generation stays claimable", () => {
  const d = createGlobeDeferral<string>();
  const g = d.begin("rhone");
  assert.equal(d.noAnswer(g), false, "nothing in flight");
  assert.equal(d.ask(g), "rhone");
  assert.equal(d.noAnswer(g), true);
  assert.equal(d.asking(g), false);
  assert.equal(d.ask(g), null, "never asked twice: no loop of asks from the frames");
  assert.equal(d.claim(g), "rhone", "the page builds it");
  assert.equal(d.noAnswer(g), false);
  // The next generation is asked for afresh.
  const g2 = d.begin("lyon");
  assert.equal(d.ask(g2), "lyon");
  assert.equal(d.noAnswer(g), false, "a stale answer changes nothing");
  assert.equal(d.asking(g2), true);
});
