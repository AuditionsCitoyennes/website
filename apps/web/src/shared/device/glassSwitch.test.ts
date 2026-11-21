// The glass rule (glassSwitch.ts), run with `node --import tsx --test` (root
// "test:scripts"): a blur on the full tier alone, and the attribute <html>
// gets.

import assert from "node:assert/strict";
import { test } from "node:test";
import { glassAttribute, glassBlurs } from "./glassSwitch";

const TIERS = ["full", "light", "minimal"] as const;

test("the glass blurs on a full device only", () => {
  assert.deepEqual(
    TIERS.map((t) => glassBlurs(t)),
    [true, false, false],
  );
});

test("the attribute is « plein » exactly when the glass does not blur", () => {
  for (const t of TIERS) assert.equal(glassAttribute(t), glassBlurs(t) ? null : "plein", t);
});
