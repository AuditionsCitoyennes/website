// The client relief's answer budget arms (reliefSwitch.ts) against a stubbed
// localStorage, run with `node --import tsx --test` (root "test:scripts"): the
// default, the kept count with and without the testing tools, garbage and a
// throwing storage, and the ground arm (the module read again under a fresh
// query, as reliefSwitch.prefetch.test.ts).

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as {
  __TEST_TOOLS__: boolean;
  localStorage?: unknown;
  window?: unknown;
};
let stored: Record<string, string> = {};
let throwing = false;
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
g.window = { location: { reload: () => undefined } };

let n = 0;
async function load(testTools: boolean) {
  g.__TEST_TOOLS__ = testTools;
  return (await import(`./reliefSwitch.ts?budget=${++n}`)) as typeof import("./reliefSwitch");
}

test("DEFAULT_RELIEF_BUDGET: 0, and the value of a build without the testing tools", async () => {
  stored = { "ac:relief-budget": "4" };
  const m = await load(false);
  assert.equal(m.DEFAULT_RELIEF_BUDGET, 0);
  assert.equal(m.reliefBudget, m.DEFAULT_RELIEF_BUDGET);
});

test("reliefBudget: a kept whole number with the testing tools, else the default", async () => {
  stored = { "ac:relief-budget": "4" };
  assert.equal((await load(true)).reliefBudget, 4);
  stored = { "ac:relief-budget": "0" };
  assert.equal((await load(true)).reliefBudget, 0);
  for (const garbage of ["-1", "2.5", "x", ""]) {
    stored = { "ac:relief-budget": garbage };
    const m = await load(true);
    assert.equal(m.reliefBudget, m.DEFAULT_RELIEF_BUDGET, garbage);
  }
  stored = {};
  let m = await load(true);
  assert.equal(m.reliefBudget, m.DEFAULT_RELIEF_BUDGET);
  throwing = true;
  m = await load(true);
  assert.equal(m.reliefBudget, m.DEFAULT_RELIEF_BUDGET);
  throwing = false;
});

test("storedReliefBudgetGround: the kept value, else the default", async () => {
  const m = await load(false);
  assert.equal(m.DEFAULT_RELIEF_BUDGET_GROUND, "budgeted");
  stored = { "ac:relief-budget-ground": "exempt" };
  assert.equal(m.storedReliefBudgetGround(), "exempt");
  stored = { "ac:relief-budget-ground": "budgeted" };
  assert.equal(m.storedReliefBudgetGround(), "budgeted");
  for (const garbage of ["", "Exempt", "1", "true", " exempt"]) {
    stored = { "ac:relief-budget-ground": garbage };
    assert.equal(m.storedReliefBudgetGround(), "budgeted", garbage);
  }
  stored = {};
  assert.equal(m.storedReliefBudgetGround(), "budgeted");
  throwing = true;
  assert.equal(m.storedReliefBudgetGround(), "budgeted");
  throwing = false;
});

test("reliefBudgetGround: the kept value with the testing tools only", async () => {
  stored = { "ac:relief-budget-ground": "exempt" };
  assert.equal((await load(true)).reliefBudgetGround, "exempt");
  assert.equal((await load(false)).reliefBudgetGround, "budgeted");
  throwing = true;
  assert.equal((await load(true)).reliefBudgetGround, "budgeted");
  throwing = false;
});
