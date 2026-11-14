// The ac:lid-map switch (lidMapSwitch.ts) against a stubbed localStorage, run
// with `node --import tsx --test` (root "test:scripts"): the kept value,
// garbage and a throwing storage; the page's value with and without the
// testing tools (the module read again under a fresh query); a choice kept
// with a reload; the plan each choice gives each device tier and each lid
// mode; what the visible map's load does about the hidden map.

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
