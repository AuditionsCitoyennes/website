// The ac:boundary-halo switch (haloSwitch.ts) against a stubbed localStorage,
// run with `node --import tsx --test` (root "test:scripts"): the kept value,
// garbage and a throwing storage; the page's value with and without the
// testing tools (the module read again under a fresh query); a choice kept
// without a reload. Then, read as text (PlateauWallLayer imports mapbox-gl,
// which needs a page): both regimes' halo passes are skipped, not drawn
// transparent, when the switch says « Sans », the slabs' glow is not, and the
// map follows the switch only in a build with the testing tools.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  return (await import(`./haloSwitch.ts?load=${++n}`)) as typeof import("./haloSwitch");
}

test("the kept choice, else the default: today's halo", async () => {
  const m = await load(false);
  assert.equal(m.DEFAULT_BOUNDARY_HALO, "avec");
  assert.deepEqual([...m.BOUNDARY_HALOS], ["avec", "sans"]);
  for (const kept of m.BOUNDARY_HALOS) {
    stored = { "ac:boundary-halo": kept };
    assert.equal(m.storedBoundaryHalo(), kept);
  }
  for (const garbage of ["", "Sans", "sans ", "off", "0", "false"]) {
    stored = { "ac:boundary-halo": garbage };
    assert.equal(m.storedBoundaryHalo(), "avec", garbage);
  }
  stored = {};
  assert.equal(m.storedBoundaryHalo(), "avec");
  throwing = true;
  assert.equal(m.storedBoundaryHalo(), "avec");
  throwing = false;
});

test("the page's choice: the kept one with the testing tools, the default without", async () => {
  stored = { "ac:boundary-halo": "sans" };
  const tools = await load(true);
  assert.equal(tools.boundaryHalo.value, "sans");
  // A build without the testing tools reads no key and takes no choice.
  const prod = await load(false);
  assert.equal(prod.boundaryHalo.value, "avec");
  prod.setBoundaryHalo("sans");
  assert.equal(prod.boundaryHalo.value, "avec");
  assert.deepEqual(stored, { "ac:boundary-halo": "sans" });
});

test("a choice is kept and read at once, with no reload", async () => {
  stored = {};
  reloads = 0;
  const m = await load(true);
  assert.equal(m.boundaryHalo.value, "avec");
  m.setBoundaryHalo("sans");
  assert.equal(m.boundaryHalo.value, "sans");
  assert.deepEqual(stored, { "ac:boundary-halo": "sans" });
  m.setBoundaryHalo("avec");
  assert.deepEqual(stored, { "ac:boundary-halo": "avec" });
  // A blocked storage: the choice lasts for the page.
  throwing = true;
  m.setBoundaryHalo("sans");
  assert.equal(m.boundaryHalo.value, "sans");
  throwing = false;
  assert.deepEqual(stored, { "ac:boundary-halo": "avec" });
  assert.equal(reloads, 0);
});

test("haloShown: the halo draws under « Avec » only", async () => {
  const { haloShown } = await load(false);
  assert.equal(haloShown("avec"), true);
  assert.equal(haloShown("sans"), false);
});

const layer = readFileSync(new URL("../gl/PlateauWallLayer.ts", import.meta.url), "utf8");

/** The condition of the nearest `if (` before the draw at `at` that names
 *  `count` (the pass's own gate, not an upload's check inside it). */
function guardOf(src: string, at: number, count: string): string {
  let open = at;
  for (;;) {
    open = src.lastIndexOf("if (", open - 1);
    assert.ok(open >= 0, `${count}: no guard`);
    let depth = 0;
    for (let i = open + 3; i < at; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) {
        const cond = src.slice(open + 4, i);
        if (cond.includes(count)) return cond;
        break;
      }
    }
  }
}

test("both regimes skip the plateau's halo pass when it is off; the slabs keep their glow", () => {
  // The plateau's halo: one draw per regime, each behind the switch's flag.
  const draws = [...layer.matchAll(/drawArrays\(gl\.TRIANGLES, 0, this\.haloVertexCount\)/g)];
  assert.equal(draws.length, 2);
  for (const d of draws) {
    const cond = guardOf(layer, d.index, "this.haloVertexCount");
    assert.match(cond, /^\s*this\.haloOn &&/, cond);
  }
  // The slabs' glow (the same programs, their own count) is not switched.
  const slabs = [...layer.matchAll(/drawArrays\(gl\.TRIANGLES, 0, this\.slabHaloCount\)/g)];
  assert.equal(slabs.length, 2);
  for (const d of slabs) {
    assert.doesNotMatch(guardOf(layer, d.index, "this.slabHaloCount"), /haloOn/);
  }
  // The setter changes the flag and asks for one frame.
  const setter = /setHaloShown\(on: boolean\) \{([^}]*)\}/.exec(layer)![1];
  assert.match(setter, /this\.haloOn = on;/);
  assert.match(setter, /triggerRepaint\(\)/);
  assert.match(layer, /private haloOn = true;/);
});

test("the map follows the switch, in a build with the testing tools only", () => {
  const map = readFileSync(new URL("../GeoDrillMap.vue", import.meta.url), "utf8");
  assert.match(
    map,
    /if \(__TEST_TOOLS__\) plateauWall\.setHaloShown\(haloShown\(boundaryHalo\.value\)\);/,
  );
  assert.match(
    map,
    /if \(__TEST_TOOLS__\) watch\(boundaryHalo, \(v\) => plateauWall\.setHaloShown\(haloShown\(v\)\)\);/,
  );
});
