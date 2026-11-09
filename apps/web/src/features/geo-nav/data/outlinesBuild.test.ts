// The outline build a page reads (outlinesBuild.ts) against a stubbed
// localStorage, run with `node --import tsx --test` (root "test:scripts"): a
// build without the testing tools reads the lock and no key (a kept build
// changes nothing), one with them reads a kept build, else the lock's.

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as {
  __TEST_TOOLS__: boolean;
  __OUTLINES_BUILD__: string;
  localStorage?: unknown;
};
const stored: Record<string, string> = { "ac:outlines-build": "x" };
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
  return (await import(`./outlinesBuild.ts?load=${++n}`)) as typeof import("./outlinesBuild");
}

test("without the testing tools: the lock's build, no key read", async () => {
  reads = 0;
  const m = await load(false);
  assert.equal(m.outlinesBuild, "o00000000-0");
  assert.equal(reads, 0);
});

test("with the testing tools: a kept build is read, else the lock's", async () => {
  const m = await load(true);
  assert.equal(m.outlinesBuild, "x");
  delete stored["ac:outlines-build"];
  assert.equal((await load(true)).outlinesBuild, "o00000000-0");
});
