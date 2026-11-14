// The ac:motion switch (motion.ts) against stubbed globals, run with
// `node --import tsx --test` (root "test:scripts"): the kept value, garbage
// and a throwing storage; the page's choice with and without the testing
// tools (the module read again under a fresh query); a choice kept without a
// reload; the motion each choice gives each device tier and system setting;
// the system setting read from matchMedia, false where it cannot be asked;
// the motion now from the navigator's hints; a move's time under each motion.

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
/** The system's reduced-motion setting, as matchMedia answers it. */
let reduced = false;
let asked: string[] = [];
const win = {
  location: { reload: () => reloads++ },
  matchMedia: (query: string) => {
    asked.push(query);
    return { matches: reduced };
  },
};
g.window = win;
const nav = (hints: Record<string, unknown>) =>
  Object.defineProperty(globalThis, "navigator", { value: hints, configurable: true });
nav({ deviceMemory: 8, hardwareConcurrency: 10 });

let n = 0;
async function load(testTools: boolean) {
  g.__TEST_TOOLS__ = testTools;
  return (await import(`./motion.ts?load=${++n}`)) as typeof import("./motion");
}

test("storedMotion: the kept value, else the default", async () => {
  const m = await load(false);
  assert.equal(m.DEFAULT_MOTION, "auto");
  assert.deepEqual([...m.MOTION_CHOICES], ["auto", "full", "short"]);
  for (const kept of ["auto", "full", "short"]) {
    stored = { "ac:motion": kept };
    assert.equal(m.storedMotion(), kept);
  }
  for (const garbage of ["", "Short", "court", "on", " short", "light", "reduce"]) {
    stored = { "ac:motion": garbage };
    assert.equal(m.storedMotion(), "auto", garbage);
  }
  stored = {};
  assert.equal(m.storedMotion(), "auto");
  throwing = true;
  assert.equal(m.storedMotion(), "auto");
  throwing = false;
});

test("the page's choice: the kept one with the testing tools, the default without", async () => {
  stored = { "ac:motion": "short" };
  assert.equal((await load(true)).motionChoice.value, "short");
  // A build without the testing tools reads no key and takes no choice.
  const prod = await load(false);
  assert.equal(prod.motionChoice.value, "auto");
  prod.setMotionChoice("full");
  assert.equal(prod.motionChoice.value, "auto");
  assert.equal(stored["ac:motion"], "short");
});

test("a choice is kept and read at once, with no reload", async () => {
  stored = {};
  reloads = 0;
  reduced = false;
  const m = await load(true);
  assert.equal(m.motionChoice.value, "auto");
  assert.equal(m.motionNow(), "full");
  m.setMotionChoice("short");
  assert.equal(m.motionChoice.value, "short");
  assert.equal(stored["ac:motion"], "short");
  assert.equal(m.motionNow(), "short");
  m.setMotionChoice("full");
  assert.equal(stored["ac:motion"], "full");
  assert.equal(m.motionNow(), "full");
  // A blocked storage: the choice lasts for the page.
  throwing = true;
  m.setMotionChoice("auto");
  assert.equal(m.motionChoice.value, "auto");
  throwing = false;
  assert.equal(stored["ac:motion"], "full");
  assert.equal(reloads, 0);
});

test("motionFor: a forced choice whatever the device; auto short for reduced motion or a weak tier", async () => {
  const { motionFor } = await load(false);
  for (const tier of ["full", "light", "minimal"] as const) {
    for (const less of [false, true]) {
      assert.equal(motionFor("full", tier, less), "full", `${tier} ${less}`);
      assert.equal(motionFor("short", tier, less), "short", `${tier} ${less}`);
    }
  }
  assert.equal(motionFor("auto", "full", false), "full");
  assert.equal(motionFor("auto", "full", true), "short");
  assert.equal(motionFor("auto", "light", false), "short");
  assert.equal(motionFor("auto", "minimal", false), "short");
  assert.equal(motionFor("auto", "light", true), "short");
  assert.equal(motionFor("auto", "minimal", true), "short");
});

test("prefersReducedMotion: matchMedia's answer, false where it cannot be asked", async () => {
  const { prefersReducedMotion } = await load(false);
  asked = [];
  reduced = true;
  assert.equal(prefersReducedMotion(), true);
  reduced = false;
  assert.equal(prefersReducedMotion(), false);
  assert.deepEqual(asked, ["(prefers-reduced-motion: reduce)", "(prefers-reduced-motion: reduce)"]);
  // No matchMedia (an old webview), a matchMedia that throws, no window at all.
  reduced = true;
  g.window = { location: win.location };
  assert.equal(prefersReducedMotion(), false);
  g.window = {
    matchMedia: () => {
      throw new Error("no");
    },
  };
  assert.equal(prefersReducedMotion(), false);
  delete g.window;
  assert.equal(prefersReducedMotion(), false);
  g.window = win;
  reduced = false;
});

test("motionNow under auto: the system setting and the device's tier of the moment", async () => {
  stored = {};
  const m = await load(true);
  reduced = false;
  nav({ deviceMemory: 8, hardwareConcurrency: 10 });
  assert.equal(m.motionNow(), "full");
  // The system setting changes while the page is open: read at each use.
  reduced = true;
  assert.equal(m.motionNow(), "short");
  reduced = false;
  assert.equal(m.motionNow(), "full");
  // A device with little memory is "light": short, whatever the system says.
  nav({ deviceMemory: 2, hardwareConcurrency: 8 });
  assert.equal(m.motionNow(), "short");
  // …unless the switch says full.
  m.setMotionChoice("full");
  assert.equal(m.motionNow(), "full");
  reduced = true;
  assert.equal(m.motionNow(), "full");
  reduced = false;
  nav({ deviceMemory: 8, hardwareConcurrency: 10 });
});

test("motionMs: the whole time under full, its short share under short", async () => {
  const { motionMs, SHORT_MOTION_SHARE } = await load(false);
  assert.equal(SHORT_MOTION_SHARE, 0.4);
  assert.equal(motionMs(300, "full"), 300);
  assert.equal(motionMs(150, "full"), 150);
  // The plateau's rise and sink (usePlateau RISE_MS, SINK_MS).
  assert.equal(motionMs(300, "short"), 120);
  assert.equal(motionMs(150, "short"), 60);
  assert.equal(motionMs(0, "short"), 0);
  assert.equal(motionMs(1, "short"), 1);
  assert.equal(Number.isInteger(motionMs(333, "short")), true);
});
