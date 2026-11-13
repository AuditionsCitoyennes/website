// The ac:relief-ground switch (groundSwitch.ts) against a stubbed
// localStorage, run with `node --import tsx --test` (root "test:scripts"): the
// kept value, garbage and a throwing storage; the page's value with and
// without the testing tools (the module read again under a fresh query); a
// choice kept without a reload; the ground each choice gives each device
// tier; the renderer's name read from a context.

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
  return (await import(`./groundSwitch.ts?load=${++n}`)) as typeof import("./groundSwitch");
}

test("storedReliefGround: the kept value, else the default", async () => {
  const m = await load(false);
  assert.equal(m.DEFAULT_RELIEF_GROUND, "auto");
  assert.deepEqual([...m.RELIEF_GROUNDS], ["auto", "relief", "flat"]);
  for (const kept of ["auto", "relief", "flat"]) {
    stored = { "ac:relief-ground": kept };
    assert.equal(m.storedReliefGround(), kept);
  }
  for (const garbage of ["", "Flat", "plat", "on", " flat", "full"]) {
    stored = { "ac:relief-ground": garbage };
    assert.equal(m.storedReliefGround(), "auto", garbage);
  }
  stored = {};
  assert.equal(m.storedReliefGround(), "auto");
  throwing = true;
  assert.equal(m.storedReliefGround(), "auto");
  throwing = false;
});

test("the page's choice: the kept one with the testing tools, the default without", async () => {
  stored = { "ac:relief-ground": "flat" };
  assert.equal((await load(true)).reliefGround.value, "flat");
  // A build without the testing tools reads no key and takes no choice.
  const prod = await load(false);
  assert.equal(prod.reliefGround.value, "auto");
  prod.setReliefGround("relief");
  assert.equal(prod.reliefGround.value, "auto");
  assert.equal(stored["ac:relief-ground"], "flat");
});

test("a choice is kept and read at once, with no reload", async () => {
  stored = {};
  reloads = 0;
  const m = await load(true);
  assert.equal(m.reliefGround.value, "auto");
  m.setReliefGround("flat");
  assert.equal(m.reliefGround.value, "flat");
  assert.equal(stored["ac:relief-ground"], "flat");
  m.setReliefGround("relief");
  assert.equal(m.reliefGround.value, "relief");
  assert.equal(stored["ac:relief-ground"], "relief");
  // A blocked storage: the choice lasts for the page.
  throwing = true;
  m.setReliefGround("auto");
  assert.equal(m.reliefGround.value, "auto");
  throwing = false;
  assert.equal(stored["ac:relief-ground"], "relief");
  assert.equal(reloads, 0);
});

test("groundFor: a forced choice whatever the tier, auto flat on a weak device only", async () => {
  const { groundFor } = await load(false);
  for (const tier of ["full", "light", "minimal"] as const) {
    assert.equal(groundFor("relief", tier), "relief", tier);
    assert.equal(groundFor("flat", tier), "flat", tier);
  }
  assert.equal(groundFor("auto", "full"), "relief");
  assert.equal(groundFor("auto", "light"), "flat");
  assert.equal(groundFor("auto", "minimal"), "flat");
});

test("rendererOf: the unmasked name, else the plain one, else null", async () => {
  const { rendererOf } = await load(false);
  const RENDERER = 0x1f01;
  const UNMASKED = 0x9246;
  const gl = (ext: boolean, names: Record<number, unknown>) =>
    ({
      RENDERER,
      getExtension: (name: string) =>
        ext && name === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: UNMASKED } : null,
      getParameter: (p: number) => names[p],
    }) as unknown as WebGLRenderingContext;
  assert.equal(
    rendererOf(gl(true, { [UNMASKED]: "ANGLE (Google, SwiftShader)", [RENDERER]: "WebKit WebGL" })),
    "ANGLE (Google, SwiftShader)",
  );
  assert.equal(rendererOf(gl(false, { [RENDERER]: "Apple GPU" })), "Apple GPU");
  assert.equal(rendererOf(gl(true, { [UNMASKED]: "" })), null);
  assert.equal(rendererOf(gl(false, {})), null);
  assert.equal(rendererOf(null), null);
  const lost = {
    RENDERER,
    getExtension: () => {
      throw new Error("context lost");
    },
    getParameter: () => null,
  } as unknown as WebGLRenderingContext;
  assert.equal(rendererOf(lost), null);
});
