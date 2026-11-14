// Where the long wait's sentence shows beside the panel's failure message
// (retryNotice.ts), run with `node --import tsx --test` (root "test:scripts"):
// never two « Réessayer » on screen at once.

import assert from "node:assert/strict";
import { test } from "node:test";
import { slowWaitPlace } from "./retryNotice";

const base = { late: true, sheetHidden: false, preview: false, panelFailure: false };

test("no late wait: nothing, whatever the panel says", () => {
  for (const sheetHidden of [false, true]) {
    for (const panelFailure of [false, true]) {
      assert.equal(slowWaitPlace({ ...base, late: false, sheetHidden, panelFailure }), "none");
    }
  }
});

test("a late wait alone: in the panel's head, or over the map when the sheet is lowered", () => {
  assert.equal(slowWaitPlace(base), "head");
  assert.equal(slowWaitPlace({ ...base, sheetHidden: true }), "floating");
  assert.equal(slowWaitPlace({ ...base, sheetHidden: true, preview: true }), "none");
});

test("the panel's failure message on screen: the long wait's sentence stays out", () => {
  assert.equal(slowWaitPlace({ ...base, panelFailure: true }), "none");
});

test("the sheet lowered hides the panel's message: the sentence shows over the map", () => {
  assert.equal(slowWaitPlace({ ...base, sheetHidden: true, panelFailure: true }), "floating");
});
