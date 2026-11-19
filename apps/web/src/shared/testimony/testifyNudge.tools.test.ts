// The « Témoigner » invitation's two DEV switches (testifyNudge.ts) in a build
// WITH the testing tools, run with `node --import tsx --test` (root
// "test:scripts"; its own process, so the module reads __TEST_TOOLS__ = true):
// a stored `ac:testify-nudge` / `ac:testify-look` is read at load, an unknown
// value falls back to the default, and the setters write their key.

import assert from "node:assert/strict";
import { test } from "node:test";

const store = new Map<string, string>([
  ["ac:testify-nudge", "jamais"],
  // Not a look: read as the default.
  ["ac:testify-look", "rouge"],
]);
const g = globalThis as unknown as { __TEST_TOOLS__: boolean; localStorage?: unknown };
g.__TEST_TOOLS__ = true;
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};
const nudge = await import("./testifyNudge");

/** A wall clock in the middle of a real day. */
const NOW = Date.parse("2026-11-19T10:00:00.000Z");

test("a stored switch is read at load; an unknown look falls back to the default", () => {
  assert.equal(nudge.testifyNudge.value, "jamais");
  assert.equal(nudge.testifyLook.value, nudge.DEFAULT_TESTIFY_LOOK);
  assert.equal(nudge.nudgeDue(nudge.testifyNudge.value, null, NOW), false);
});

test("the setters change the mode at once and keep it under its key", () => {
  nudge.setTestifyNudge("toujours");
  assert.equal(nudge.testifyNudge.value, "toujours");
  assert.equal(store.get("ac:testify-nudge"), "toujours");
  nudge.setTestifyLook("point");
  assert.equal(nudge.testifyLook.value, "point");
  assert.equal(store.get("ac:testify-look"), "point");
  // The device's record is not one of the switches: untouched.
  assert.equal(store.has(nudge.LAST_TESTIMONY_KEY), false);
});

test("blocked storage: the setters still change the mode for the page", () => {
  g.localStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  try {
    nudge.setTestifyNudge("auto");
    assert.equal(nudge.testifyNudge.value, "auto");
  } finally {
    delete g.localStorage;
  }
});
