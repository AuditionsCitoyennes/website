// The four switches of threadSwitch.ts against a stubbed localStorage, run
// with `node --import tsx --test` (root "test:scripts"): the kept value,
// garbage and a throwing storage; the page's value with and without the
// testing tools (the module read again under a fresh query); a choice kept
// without a reload; what each « Globe » and « Gris » choice asks on each
// device tier.

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
  return (await import(`./threadSwitch.ts?load=${++n}`)) as typeof import("./threadSwitch");
}

type Mod = Awaited<ReturnType<typeof load>>;
/** Each switch: its key, its choices and default, its ref and its setter. */
const SWITCHES = [
  {
    key: "ac:lines-mesh",
    choices: ["worker", "page"],
    fallback: "worker",
    now: (m: Mod) => m.linesMesh.value,
    set: (m: Mod, v: string) => m.setLinesMesh(v as never),
    listed: (m: Mod) => [m.LINES_MESHES, m.DEFAULT_LINES_MESH] as const,
  },
  {
    key: "ac:globe-late",
    choices: ["auto", "page", "wait"],
    fallback: "auto",
    now: (m: Mod) => m.globeLate.value,
    set: (m: Mod, v: string) => m.setGlobeLate(v as never),
    listed: (m: Mod) => [m.GLOBE_LATES, m.DEFAULT_GLOBE_LATE] as const,
  },
  {
    key: "ac:tint-cut",
    choices: ["auto", "worker", "page"],
    fallback: "auto",
    now: (m: Mod) => m.tintCut.value,
    set: (m: Mod, v: string) => m.setTintCut(v as never),
    listed: (m: Mod) => [m.TINT_CUTS, m.DEFAULT_TINT_CUT] as const,
  },
  {
    key: "ac:pins-rebuild",
    choices: ["next", "now"],
    fallback: "next",
    now: (m: Mod) => m.pinsRebuild.value,
    set: (m: Mod, v: string) => m.setPinsRebuild(v as never),
    listed: (m: Mod) => [m.PINS_REBUILDS, m.DEFAULT_PINS_REBUILD] as const,
  },
] as const;

test("each switch lists its choices and its default", async () => {
  const m = await load(false);
  for (const s of SWITCHES) {
    const [choices, fallback] = s.listed(m);
    assert.deepEqual([...choices], [...s.choices], s.key);
    assert.equal(fallback, s.fallback, s.key);
  }
});

test("the page's choice: the kept one with the testing tools, the default without", async () => {
  for (const s of SWITCHES) {
    for (const kept of s.choices) {
      stored = { [s.key]: kept };
      assert.equal(s.now(await load(true)), kept, `${s.key}=${kept}`);
      // A build without the testing tools reads no key.
      assert.equal(s.now(await load(false)), s.fallback, `${s.key}=${kept}, no tools`);
    }
    for (const garbage of ["", "Page", " page", "on", "1", "ancien"]) {
      stored = { [s.key]: garbage };
      assert.equal(s.now(await load(true)), s.fallback, `${s.key}=${garbage}`);
    }
    stored = {};
    assert.equal(s.now(await load(true)), s.fallback, s.key);
    throwing = true;
    assert.equal(s.now(await load(true)), s.fallback, `${s.key}, storage blocked`);
    throwing = false;
  }
});

test("a choice is kept and read at once, without a reload", async () => {
  for (const s of SWITCHES) {
    stored = {};
    reloads = 0;
    const m = await load(true);
    const other = s.choices.find((c) => c !== s.fallback)!;
    s.set(m, other);
    assert.equal(s.now(m), other, s.key);
    assert.equal(stored[s.key], other, s.key);
    assert.equal(reloads, 0, s.key);
    // Storage blocked: the choice lasts for this page.
    throwing = true;
    s.set(m, s.fallback);
    assert.equal(s.now(m), s.fallback, s.key);
    throwing = false;
    assert.equal(stored[s.key], other, s.key);
    // Without the testing tools the setter does nothing.
    stored = {};
    const prod = await load(false);
    s.set(prod, other);
    assert.equal(s.now(prod), s.fallback, s.key);
    assert.deepEqual(stored, {}, s.key);
  }
});

test("« Globe »: what each choice asks of a deferred globe set, by device tier", async () => {
  const { lateGlobeFor } = await load(false);
  for (const tier of ["full", "light", "minimal"] as const) {
    // As before: the worker asked at the map's idle, a globe frame builds on the page.
    assert.deepEqual(lateGlobeFor("page", tier), { ahead: false, wait: false });
    assert.deepEqual(lateGlobeFor("wait", tier), { ahead: true, wait: true });
  }
  // The locked design's device builds on the page rather than draw a frame without the plateau.
  assert.deepEqual(lateGlobeFor("auto", "full"), { ahead: true, wait: false });
  assert.deepEqual(lateGlobeFor("auto", "light"), { ahead: true, wait: true });
  assert.deepEqual(lateGlobeFor("auto", "minimal"), { ahead: true, wait: true });
});

test("« Gris »: who cuts the grey sheet, by choice and device tier", async () => {
  const { tintCutFor } = await load(false);
  for (const tier of ["full", "light", "minimal"] as const) {
    assert.equal(tintCutFor("page", tier), "page");
    assert.equal(tintCutFor("worker", tier), "worker");
  }
  // Where the page's thread is fast the cut takes less than the worker's round trip.
  assert.equal(tintCutFor("auto", "full"), "page");
  assert.equal(tintCutFor("auto", "light"), "worker");
  assert.equal(tintCutFor("auto", "minimal"), "worker");
});
