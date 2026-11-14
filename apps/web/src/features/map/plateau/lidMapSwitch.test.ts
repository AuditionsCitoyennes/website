// The ac:lid-map switch (lidMapSwitch.ts) against a stubbed localStorage, run
// with `node --import tsx --test` (root "test:scripts"): the kept value,
// garbage and a throwing storage; the page's value with and without the
// testing tools (the module read again under a fresh query); a choice kept
// with a reload; the plan each choice gives each device tier and each lid
// mode; what the visible map's load does about the hidden map, and when; the
// camera a hidden map is created on.

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as {
  __TEST_TOOLS__: boolean;
  localStorage?: unknown;
  window?: unknown;
};
let stored: Record<string, string> = {};
let throwing = false;
let reloads = 0;
g.localStorage = {
  getItem(k: string) {
    if (throwing) throw new Error("blocked");
    return stored[k] ?? null;
  },
  setItem(k: string, v: string) {
    if (throwing) throw new Error("blocked");
    stored[k] = v;
  },
};
g.window = { location: { reload: () => reloads++ } };

let n = 0;
async function load(testTools: boolean) {
  g.__TEST_TOOLS__ = testTools;
  return (await import(`./lidMapSwitch.ts?load=${++n}`)) as typeof import("./lidMapSwitch");
}

test("storedLidMap: the kept value, else the default", async () => {
  const m = await load(false);
  assert.equal(m.DEFAULT_LID_MAP, "auto");
  assert.deepEqual([...m.LID_MAPS], ["auto", "boot", "first-place", "none"]);
  for (const kept of m.LID_MAPS) {
    stored = { "ac:lid-map": kept };
    assert.equal(m.storedLidMap(), kept);
  }
  for (const garbage of ["", "Boot", "first", "first_place", "aucun", " none", "late"]) {
    stored = { "ac:lid-map": garbage };
    assert.equal(m.storedLidMap(), "auto", garbage);
  }
  stored = {};
  assert.equal(m.storedLidMap(), "auto");
  throwing = true;
  assert.equal(m.storedLidMap(), "auto");
  throwing = false;
});

test("lidMap: the kept value with the testing tools, the default without", async () => {
  stored = { "ac:lid-map": "boot" };
  assert.equal((await load(true)).lidMap, "boot");
  assert.equal((await load(false)).lidMap, "auto");
  stored = {};
  assert.equal((await load(true)).lidMap, "auto");
});

test("setLidMap: kept and the page loaded again; nothing for the same choice or without the tools", async () => {
  stored = {};
  reloads = 0;
  const m = await load(true);
  m.setLidMap("auto"); // this page's choice already
  assert.equal(reloads, 0);
  assert.deepEqual(stored, {});
  m.setLidMap("none");
  assert.equal(stored["ac:lid-map"], "none");
  assert.equal(reloads, 1);
  // A blocked storage: the reload alone (the choice cannot be kept).
  throwing = true;
  m.setLidMap("boot");
  throwing = false;
  assert.equal(reloads, 2);
  assert.equal(stored["ac:lid-map"], "none");
  // A build without the testing tools has no switch.
  stored = {};
  reloads = 0;
  const prod = await load(false);
  prod.setLidMap("none");
  assert.equal(reloads, 0);
  assert.deepEqual(stored, {});
});

test("lidMapFor: auto follows the tier, a forced choice does not, the lid mode comes first", async () => {
  const { lidMapFor } = await load(false);
  // "auto": no hidden map on the minimal tier only.
  assert.equal(lidMapFor("auto", "full"), "first-place");
  assert.equal(lidMapFor("auto", "light"), "first-place");
  assert.equal(lidMapFor("auto", "minimal"), "none");
  // A forced choice, whatever the tier: "boot" is the hidden map as before.
  for (const tier of ["full", "light", "minimal"] as const) {
    assert.equal(lidMapFor("boot", tier), "boot");
    assert.equal(lidMapFor("first-place", tier), "first-place");
    assert.equal(lidMapFor("none", tier), "none");
  }
  // ac:lid on "aucun": never a hidden map.
  for (const choice of ["auto", "boot", "first-place", "none"] as const) {
    assert.equal(lidMapFor(choice, "full", "aucun"), "none");
  }
  // ac:lid on "ancien": the lid as before, so created as in "boot" — unless none.
  assert.equal(lidMapFor("auto", "full", "ancien"), "boot");
  assert.equal(lidMapFor("first-place", "light", "ancien"), "boot");
  assert.equal(lidMapFor("boot", "full", "ancien"), "boot");
  assert.equal(lidMapFor("auto", "minimal", "ancien"), "none");
  assert.equal(lidMapFor("none", "full", "ancien"), "none");
  // "ecran" is the default mode.
  assert.equal(lidMapFor("auto", "full", "ecran"), lidMapFor("auto", "full"));
});

const FR = { minLat: 41.3, maxLat: 51.1, minLng: -5.2, maxLng: 9.6 };
const FRAMED = { minLat: 41, maxLat: 51.5, minLng: -5.5, maxLng: 10 };

test("usablePlace: a finite rectangle with an area, inside the latitudes", async () => {
  const { usablePlace } = await load(false);
  assert.equal(usablePlace(FR), true);
  assert.equal(usablePlace(null), false);
  assert.equal(usablePlace(undefined), false);
  assert.equal(usablePlace({ ...FR, maxLat: FR.minLat }), false); // a line
  assert.equal(usablePlace({ ...FR, minLng: 12 }), false); // inside out
  assert.equal(usablePlace({ ...FR, maxLng: NaN }), false);
  assert.equal(usablePlace({ ...FR, minLat: -Infinity }), false);
  assert.equal(usablePlace({ ...FR, maxLat: 91 }), false);
  // Past ±180 is a rectangle like another (an outline may reach there).
  assert.equal(usablePlace({ minLat: -20, maxLat: -10, minLng: 170, maxLng: 190 }), true);
});

test("warmupAtLoad: the world at boot, the first place when one is known, nothing otherwise", async () => {
  const { warmupAtLoad } = await load(false);
  // "boot": always, on the world, whatever is known.
  assert.deepEqual(warmupAtLoad("boot", FR, FRAMED), { place: null });
  assert.deepEqual(warmupAtLoad("boot", null, null), { place: null });
  // "first-place": the outline's rectangle first, else the one the camera frames.
  assert.deepEqual(warmupAtLoad("first-place", FR, FRAMED), { place: FR });
  assert.deepEqual(warmupAtLoad("first-place", null, FRAMED), { place: FRAMED });
  assert.deepEqual(warmupAtLoad("first-place", { ...FR, maxLat: NaN }, FRAMED), { place: FRAMED });
  // No place known at the load: no hidden map until the first shot.
  assert.equal(warmupAtLoad("first-place", null, null), null);
  assert.equal(warmupAtLoad("first-place", undefined, { ...FRAMED, minLng: 20 }), null);
  // "none": never.
  assert.equal(warmupAtLoad("none", FR, FRAMED), null);
});

test("warmupMoment: the world at the load, a place at the load unless the load's command moved the visible map", async () => {
  const { warmupMoment, warmupAtLoad } = await load(false);
  // "boot" (and the lid as before, whose plan is "boot"): at the load, moved or not.
  assert.equal(warmupMoment(warmupAtLoad("boot", FR, FRAMED)!, false), "load");
  assert.equal(warmupMoment(warmupAtLoad("boot", FR, FRAMED)!, true), "load");
  // A place: at the load when the view is the one whose tiles are in, else at the first idle.
  assert.equal(warmupMoment(warmupAtLoad("first-place", FR, FRAMED)!, false), "load");
  assert.equal(warmupMoment(warmupAtLoad("first-place", null, FRAMED)!, true), "idle");
});

test("tilesInSight, tilesMoved: a view adjusted over the same tiles has not moved, one on other tiles has", async () => {
  const { tilesInSight, tilesMoved } = await load(false);
  // France on a phone, zoom 3.4: columns 3 and 4, rows 2 and 3 of level 3.
  const fr = { zoom: 3.4, minLat: 37, maxLat: 55, minLng: -8, maxLng: 12 };
  assert.equal(tilesInSight(fr), "3/3/4/2/3");
  // The same place fitted again, a little tighter: the same tiles.
  const again = { zoom: 3.55, minLat: 38, maxLat: 54.5, minLng: -7, maxLng: 11 };
  assert.equal(tilesInSight(again), "3/3/4/2/3");
  assert.equal(tilesMoved(fr, again), false);
  assert.equal(tilesMoved(fr, { ...fr }), false);
  // Another level, or a rectangle reaching another column: other tiles.
  assert.equal(tilesMoved({ ...fr, zoom: 4.5 }, fr), true);
  assert.equal(tilesMoved(fr, { ...fr, maxLng: 46 }), true);
  assert.equal(tilesMoved(fr, { ...fr, minLat: -10 }), true);
  // The whole world at zoom 0: one tile, the rows kept inside the level.
  assert.equal(
    tilesInSight({ zoom: 0.3, minLat: -89, maxLat: 89, minLng: -170, maxLng: 170 }),
    "0/0/0/0/0",
  );
  // A view that cannot be read counts as moved.
  assert.equal(tilesInSight(null), null);
  assert.equal(tilesInSight({ ...fr, zoom: NaN }), null);
  assert.equal(tilesMoved(null, fr), true);
  assert.equal(tilesMoved(fr, null), true);
  assert.equal(tilesMoved(null, null), true);
});

test("cameraOver: the centre and the zoom that frame a rectangle in a square map, its margin left free", async () => {
  const { cameraOver } = await load(false);
  // The whole mercator world in 512 px: zoom 0, centred; in 1024 px: zoom 1.
  const world = { minLat: -85.051129, maxLat: 85.051129, minLng: -180, maxLng: 180 };
  const w0 = cameraOver(world, 512, 0);
  assert.ok(Math.abs(w0.zoom) < 1e-6);
  assert.ok(Math.abs(w0.center[0]) < 1e-9 && Math.abs(w0.center[1]) < 1e-9);
  assert.ok(Math.abs(cameraOver(world, 1024, 0).zoom - 1) < 1e-6);
  // A margin leaves less room: 8 px on each side lowers the zoom by log2(1024 / 1008).
  assert.ok(Math.abs(cameraOver(world, 1024, 8).zoom - (1 - Math.log2(1024 / 1008))) < 1e-6);
  const fr = cameraOver(FR, 512, 8);
  const frNoPad = cameraOver(FR, 512, 0);
  assert.ok(Math.abs(frNoPad.zoom - fr.zoom - Math.log2(512 / 496)) < 1e-9);
  // France: wider in mercator y than in x at these latitudes? The longer side decides.
  const x = (9.6 + 5.2) / 360;
  const y = (lat: number) =>
    0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);
  const span = Math.max(x, y(41.3) - y(51.1));
  assert.ok(Math.abs(fr.zoom - Math.log2(496 / (512 * span))) < 1e-9);
  // The centre: the middle in longitude, the mercator middle in latitude (north of the plain mean).
  assert.ok(Math.abs(fr.center[0] - 2.2) < 1e-9);
  assert.ok(fr.center[1] > (41.3 + 51.1) / 2 && fr.center[1] < 46.6);
  assert.ok(Math.abs(y(fr.center[1]) - (y(41.3) + y(51.1)) / 2) < 1e-9);
  // A rectangle past ±180 is centred where it is; a tiny one stops at zoom 22; a huge map at 0 at least.
  assert.ok(
    Math.abs(
      cameraOver({ minLat: -20, maxLat: -10, minLng: 170, maxLng: 190 }, 512, 8).center[0] - 180,
    ) < 1e-9,
  );
  assert.equal(
    cameraOver({ minLat: 45, maxLat: 45.0000001, minLng: 4, maxLng: 4.0000001 }, 1024, 8).zoom,
    22,
  );
  assert.equal(cameraOver(world, 64, 8).zoom, 0);
});
