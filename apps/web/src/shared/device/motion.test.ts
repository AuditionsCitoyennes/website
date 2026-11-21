// How much the page moves (motion.ts) against stubbed globals, run with
// `node --import tsx --test` (root "test:scripts"): the motion each device
// tier and system setting gives; the system setting read from matchMedia,
// false where it cannot be asked; the motion now from the navigator's hints;
// a move's time under each motion.

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as {
  __TEST_TOOLS__: boolean;
  localStorage?: unknown;
  window?: unknown;
};
g.localStorage = { getItem: () => null, setItem: () => {} };
/** The system's reduced-motion setting, as matchMedia answers it. */
let reduced = false;
let asked: string[] = [];
const win = {
  location: { reload: () => {} },
  matchMedia: (query: string) => {
    asked.push(query);
    // Live, as a MediaQueryList's is.
    return {
      get matches() {
        return reduced;
      },
    };
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

test("motionFor: short for reduced motion or a weak tier", async () => {
  const { motionFor } = await load(false);
  assert.equal(motionFor("full", false), "full");
  assert.equal(motionFor("full", true), "short");
  assert.equal(motionFor("light", false), "short");
  assert.equal(motionFor("minimal", false), "short");
  assert.equal(motionFor("light", true), "short");
  assert.equal(motionFor("minimal", true), "short");
});

test("prefersReducedMotion: the query's live answer, asked once per window, false where it cannot be asked", async () => {
  const { prefersReducedMotion } = await load(false);
  asked = [];
  reduced = true;
  assert.equal(prefersReducedMotion(), true);
  reduced = false;
  assert.equal(prefersReducedMotion(), false);
  reduced = true;
  assert.equal(prefersReducedMotion(), true);
  assert.deepEqual(asked, ["(prefers-reduced-motion: reduce)"]);
  // No matchMedia (an old webview), a matchMedia that throws, no window at all.
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
  // The first window again: its query is still the one asked.
  g.window = win;
  assert.equal(prefersReducedMotion(), true);
  reduced = false;
  assert.equal(prefersReducedMotion(), false);
  assert.deepEqual(asked, ["(prefers-reduced-motion: reduce)"]);
  // Another window is asked anew.
  const other = { matchMedia: () => ({ matches: true }) };
  g.window = other;
  assert.equal(prefersReducedMotion(), true);
  g.window = win;
  assert.equal(prefersReducedMotion(), false);
  assert.equal(asked.length, 2);
});

test("motionNow: the system setting and the device's tier of the moment", async () => {
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
