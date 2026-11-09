// What the donations pay for (content.ts), run with `node --import tsx --test`
// (root "test:scripts"): a build without the analyses (__ANALYSES__) lists the
// three other costs, one with them adds « Les analyses » last, its text as is.

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as { __ANALYSES__: boolean };

let n = 0;
async function load(analyses: boolean) {
  g.__ANALYSES__ = analyses;
  return (await import(`./content.ts?load=${++n}`)) as typeof import("./content");
}

const SHARED = ["L'hébergement", "La carte", "Les emails"];

test("without the analyses: three costs, none of them the analyses", async () => {
  const { COSTS } = await load(false);
  assert.deepEqual(
    COSTS.map((c) => c.title),
    SHARED,
  );
});

test("with the analyses: the same three, then « Les analyses »", async () => {
  const off = (await load(false)).COSTS;
  const { COSTS } = await load(true);
  assert.deepEqual(
    COSTS.map((c) => c.title),
    [...SHARED, "Les analyses"],
  );
  assert.equal(COSTS[3]?.text, "Les synthèses de ce qui se dit dans chaque territoire.");
  assert.deepEqual(COSTS.slice(0, 3), off);
});
