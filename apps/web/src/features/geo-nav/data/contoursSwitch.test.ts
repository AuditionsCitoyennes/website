// The outlines' source switch (contoursSwitch.ts) against a stubbed
// localStorage, run with `node --import tsx --test` (root "test:scripts"): the
// default, a build without the testing tools (no key read: a kept "api" or
// another build changes nothing), and one with them ("api" stays selectable).

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as {
  __TEST_TOOLS__: boolean;
  __OUTLINES_BUILD__: string;
  localStorage?: unknown;
};
const stored: Record<string, string> = { "ac:contours": "api", "ac:outlines-build": "x" };
let reads = 0;
g.__OUTLINES_BUILD__ = "o00000000-0";
g.localStorage = {
  getItem(k: string) {
    reads++;
    return stored[k] ?? null;
  },
};

let n = 0;
async function load(testTools: boolean) {
  g.__TEST_TOOLS__ = testTools;
  return (await import(`./contoursSwitch.ts?load=${++n}`)) as typeof import("./contoursSwitch");
}

test("without the testing tools: the files, the lock's build, no key read", async () => {
  reads = 0;
  const m = await load(false);
  assert.equal(m.DEFAULT_CONTOURS_MODE, "fichiers");
  assert.equal(m.contoursMode, "fichiers");
  assert.equal(m.outlinesBuild, "o00000000-0");
  assert.equal(reads, 0);
});

test("with the testing tools: a kept mode and build are read", async () => {
  const m = await load(true);
  assert.equal(m.contoursMode, "api");
  assert.equal(m.outlinesBuild, "x");
});
