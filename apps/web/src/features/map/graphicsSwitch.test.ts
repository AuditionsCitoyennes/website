// The three switches of graphicsSwitch.ts (ac:msaa, ac:dpr, ac:frame-measure)
// against a stubbed localStorage, run with `node --import tsx --test` (root
// "test:scripts"): the page's choices with and without the testing tools (the
// module read again under a fresh query), garbage and a throwing storage; a
// choice kept and the page loaded again; the `antialias` option each choice
// gives a device, read from the device's tier; the cap each choice gives.

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
  removeItem(k: string) {
    delete stored[k];
  },
};
g.window = { location: { reload: () => reloads++ } };

// The device's tier, loaded once (a build without the testing tools: "auto").
g.__TEST_TOOLS__ = false;
const tier = await import("../../shared/device/deviceTier");

let n = 0;
async function load(testTools: boolean) {
  g.__TEST_TOOLS__ = testTools;
  return (await import(`./graphicsSwitch.ts?load=${++n}`)) as typeof import("./graphicsSwitch");
}

const METAL = "ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)";
const SWIFTSHADER =
  "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";

test("the defaults and the choices", async () => {
  const m = await load(false);
  assert.equal(m.DEFAULT_MSAA, "auto");
  assert.deepEqual([...m.MSAA_CHOICES], ["auto", "on", "off"]);
  assert.equal(m.DEFAULT_DPR, "auto");
  assert.deepEqual([...m.DPR_CHOICES], ["auto", "native", "1.5"]);
  assert.equal(m.DPR_CAP, 1.5);
  assert.equal(m.DEFAULT_FRAME_MEASURE, "on");
  assert.deepEqual([...m.FRAME_MEASURES], ["on", "off"]);
});

test("the page's choices: the kept ones with the testing tools, the defaults without", async () => {
  stored = { "ac:msaa": "off", "ac:dpr": "1.5", "ac:frame-measure": "off" };
  const kept = await load(true);
  assert.equal(kept.msaaChoice, "off");
  assert.equal(kept.dprChoice, "1.5");
  assert.equal(kept.frameMeasure, "off");
  // A build without the testing tools reads no key.
  const prod = await load(false);
  assert.equal(prod.msaaChoice, "auto");
  assert.equal(prod.dprChoice, "auto");
  assert.equal(prod.frameMeasure, "on");
  // Garbage, nothing kept, a storage that throws: the defaults.
  for (const garbage of ["", "Off", "non", "2", "1,5", " on", "true"]) {
    stored = { "ac:msaa": garbage, "ac:dpr": garbage, "ac:frame-measure": garbage };
    const m = await load(true);
    assert.equal(m.msaaChoice, "auto", garbage);
    assert.equal(m.dprChoice, "auto", garbage);
    assert.equal(m.frameMeasure, "on", garbage);
  }
  stored = {};
  throwing = true;
  const blocked = await load(true);
  assert.equal(blocked.msaaChoice, "auto");
  assert.equal(blocked.dprChoice, "auto");
  assert.equal(blocked.frameMeasure, "on");
  throwing = false;
});

test("another choice is kept and the page loaded again; the same one does nothing", async () => {
  stored = {};
  reloads = 0;
  const m = await load(true);
  m.setMsaaChoice("auto");
  m.setDprChoice("auto");
  m.setFrameMeasure("on");
  assert.equal(reloads, 0);
  assert.deepEqual(stored, {});
  m.setMsaaChoice("off");
  assert.deepEqual(stored, { "ac:msaa": "off" });
  m.setDprChoice("1.5");
  m.setFrameMeasure("off");
  assert.deepEqual(stored, { "ac:msaa": "off", "ac:dpr": "1.5", "ac:frame-measure": "off" });
  assert.equal(reloads, 3);
  // A blocked storage: the page is still loaded again.
  throwing = true;
  m.setMsaaChoice("on");
  assert.equal(reloads, 4);
  throwing = false;
  // Without the testing tools a setter does nothing.
  stored = {};
  const prod = await load(false);
  prod.setMsaaChoice("off");
  prod.setDprChoice("1.5");
  prod.setFrameMeasure("off");
  assert.equal(reloads, 4);
  assert.deepEqual(stored, {});
});

test("antialiasFor: on everywhere, except under « auto » where the graphics are slow", async () => {
  const m = await load(false);
  assert.equal(m.antialiasFor("auto", false), true);
  assert.equal(m.antialiasFor("auto", true), false);
  assert.equal(m.antialiasFor("on", false), true);
  assert.equal(m.antialiasFor("on", true), true);
  assert.equal(m.antialiasFor("off", false), false);
  assert.equal(m.antialiasFor("off", true), false);
});

test("antialiasNow: read from the device's tier under « auto », not at all when forced", async () => {
  stored = {};
  tier.forgetMeasuredStep();
  // An ordinary device: the option is `true`, as before.
  tier.noteRenderer(METAL);
  assert.equal((await load(false)).antialiasNow(), true);
  assert.equal((await load(true)).antialiasNow(), true);
  // A graphics chip the browser does not name is not a slow one.
  tier.noteRenderer(null);
  assert.equal((await load(false)).antialiasNow(), true);
  // A software renderer: off.
  tier.noteRenderer(SWIFTSHADER);
  assert.equal((await load(false)).antialiasNow(), false);
  // …unless the switch says on; and off on any device when it says off.
  stored = { "ac:msaa": "on" };
  assert.equal((await load(true)).antialiasNow(), true);
  tier.noteRenderer(METAL);
  stored = { "ac:msaa": "off" };
  assert.equal((await load(true)).antialiasNow(), false);
  // A build without the testing tools does not read the switch.
  assert.equal((await load(false)).antialiasNow(), true);
  stored = {};
});

test("antialiasNow: slow frames measured on an earlier visit, by which part was slow", async () => {
  stored = {};
  tier.noteRenderer(METAL);
  const m = await load(false);
  // Frames slow while the page's thread was free: the graphics.
  const waiting = Array.from({ length: 12 }, () => ({ ms: 60, workMs: 6 }));
  tier.forgetMeasuredStep();
  assert.deepEqual(
    { ...tier.reportFrameTimes(waiting), at: 0 },
    { tier: "light", kind: "gpu", at: 0 },
  );
  assert.equal(m.antialiasNow(), false);
  // Frames slow because the page's thread worked: the processor, the option stays.
  const working = Array.from({ length: 12 }, () => ({ ms: 60, workMs: 55 }));
  tier.forgetMeasuredStep();
  assert.equal(tier.reportFrameTimes(working)?.kind, "cpu");
  assert.equal(m.antialiasNow(), true);
  // Not told which part: read as the processor.
  tier.forgetMeasuredStep();
  assert.equal(tier.reportFrameTimes(Array.from({ length: 12 }, () => 60))?.kind, "unknown");
  assert.equal(m.antialiasNow(), true);
  tier.forgetMeasuredStep();
  stored = {};
});

test("pixelRatioCapFor: only « 1.5 » caps; « auto » never does", async () => {
  const m = await load(false);
  assert.equal(m.pixelRatioCapFor("auto"), null);
  assert.equal(m.pixelRatioCapFor("native"), null);
  assert.equal(m.pixelRatioCapFor("1.5"), 1.5);
});
