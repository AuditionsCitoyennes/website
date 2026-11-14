// The ac:rise and ac:rise-order switches (riseSwitch.ts) against a stubbed
// localStorage, run with `node --import tsx --test` (root "test:scripts"): the
// kept values, garbage and a throwing storage; the page's values with and
// without the testing tools (the module read again under a fresh query); a
// choice kept without a reload; when a rise starts for each order and tier.

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
  return (await import(`./riseSwitch.ts?load=${++n}`)) as typeof import("./riseSwitch");
}

test("the kept mode and order, else the defaults: today's rise", async () => {
  const m = await load(false);
  assert.equal(m.DEFAULT_RISE_MODE, "steps");
  assert.equal(m.DEFAULT_RISE_ORDER, "auto");
  assert.deepEqual([...m.RISE_MODES], ["steps", "transition"]);
  assert.deepEqual([...m.RISE_ORDERS], ["auto", "flight", "after"]);
  for (const kept of m.RISE_MODES) {
    stored = { "ac:rise": kept };
    assert.equal(m.storedRiseMode(), kept);
  }
  for (const kept of m.RISE_ORDERS) {
    stored = { "ac:rise-order": kept };
    assert.equal(m.storedRiseOrder(), kept);
  }
  for (const garbage of ["", "Steps", "transition ", "on", "after", "1"]) {
    stored = { "ac:rise": garbage };
    assert.equal(m.storedRiseMode(), "steps", garbage);
  }
  for (const garbage of ["", "Auto", "before", "steps", " after", "0"]) {
    stored = { "ac:rise-order": garbage };
    assert.equal(m.storedRiseOrder(), "auto", garbage);
  }
  // Each key is its own: the other's value is not read.
  stored = { "ac:rise": "after", "ac:rise-order": "transition" };
  assert.equal(m.storedRiseMode(), "steps");
  assert.equal(m.storedRiseOrder(), "auto");
  stored = {};
  assert.equal(m.storedRiseMode(), "steps");
  assert.equal(m.storedRiseOrder(), "auto");
  throwing = true;
  assert.equal(m.storedRiseMode(), "steps");
  assert.equal(m.storedRiseOrder(), "auto");
  throwing = false;
});

test("the page's choices: the kept ones with the testing tools, the defaults without", async () => {
  stored = { "ac:rise": "transition", "ac:rise-order": "after" };
  const tools = await load(true);
  assert.equal(tools.riseMode.value, "transition");
  assert.equal(tools.riseOrder.value, "after");
  // A build without the testing tools reads no key and takes no choice.
  const prod = await load(false);
  assert.equal(prod.riseMode.value, "steps");
  assert.equal(prod.riseOrder.value, "auto");
  prod.setRiseMode("transition");
  prod.setRiseOrder("flight");
  assert.equal(prod.riseMode.value, "steps");
  assert.equal(prod.riseOrder.value, "auto");
  assert.deepEqual(stored, { "ac:rise": "transition", "ac:rise-order": "after" });
});

test("a choice is kept and read at once, with no reload", async () => {
  stored = {};
  reloads = 0;
  const m = await load(true);
  assert.equal(m.riseMode.value, "steps");
  assert.equal(m.riseOrder.value, "auto");
  m.setRiseMode("transition");
  m.setRiseOrder("after");
  assert.equal(m.riseMode.value, "transition");
  assert.equal(m.riseOrder.value, "after");
  assert.deepEqual(stored, { "ac:rise": "transition", "ac:rise-order": "after" });
  m.setRiseMode("steps");
  m.setRiseOrder("flight");
  assert.deepEqual(stored, { "ac:rise": "steps", "ac:rise-order": "flight" });
  // A blocked storage: the choice lasts for the page.
  throwing = true;
  m.setRiseMode("transition");
  m.setRiseOrder("auto");
  assert.equal(m.riseMode.value, "transition");
  assert.equal(m.riseOrder.value, "auto");
  throwing = false;
  assert.deepEqual(stored, { "ac:rise": "steps", "ac:rise-order": "flight" });
  assert.equal(reloads, 0);
});

test("riseStartFor: a forced order whatever the tier, auto after the flight on a weak device only", async () => {
  const { riseStartFor, LAND_WAIT_CAP_MS } = await load(false);
  for (const tier of ["full", "light", "minimal"] as const) {
    assert.equal(riseStartFor("flight", tier), "flight", tier);
    assert.equal(riseStartFor("after", tier), "after", tier);
  }
  assert.equal(riseStartFor("auto", "full"), "flight");
  assert.equal(riseStartFor("auto", "light"), "after");
  assert.equal(riseStartFor("auto", "minimal"), "after");
  // Longer than the longest flight (an arc: 3 s), and never a long wait.
  assert.ok(LAND_WAIT_CAP_MS > 3000 && LAND_WAIT_CAP_MS <= 5000);
});
