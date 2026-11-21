// The hold's state (scopeHold.ts), run with `node --import tsx --test` (root
// "test:scripts"): which zone is held.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createScopeHold } from "./scopeHold";

test("the held zone: the scope a command landed on, held while it is the scope", () => {
  const hold = createScopeHold();
  const fr = { id: "FR" };
  const pt = { id: "PT" };
  // Nothing selected yet: nothing held, whatever the views.
  assert.equal(hold.id(), null);
  assert.equal(hold.of(fr), null);
  hold.view("FR", false, true);
  hold.derived("FR");
  assert.equal(hold.of(fr), null);
  // A tap on France: its flight lands, the landing reads France.
  hold.view("FR", true, false);
  assert.equal(hold.of(fr), fr); // held while that first view is read
  hold.derived("FR");
  assert.equal(hold.of(fr), fr);
  assert.equal(hold.of({ id: "FR" })?.id, "FR"); // the same unit of a newer tree
  // The view took the scope to Portugal: not the held zone, nothing held.
  hold.view("FR", false, true);
  hold.derived("PT");
  assert.equal(hold.id(), "FR");
  assert.equal(hold.of(pt), null);
  // Back on France: held again.
  hold.view("PT", false, true);
  hold.derived("FR");
  assert.equal(hold.of(fr), fr);
  // Another command replaces it.
  hold.view("PT", true, false);
  hold.derived("PT");
  assert.equal(hold.id(), "PT");
  assert.equal(hold.of(fr), null);
  assert.equal(hold.of(pt), pt);
});

test("the held zone is the scope the landing reads: the boot's frame, a unit the fit corrects", () => {
  const hold = createScopeHold();
  // The boot: the command is sent with the world as the scope, and lands on France.
  hold.view("world", true, false);
  assert.equal(hold.id(), "world");
  hold.derived("FR");
  assert.equal(hold.id(), "FR");
  // Taken once: what later views read is not held.
  hold.derived("PT");
  assert.equal(hold.id(), "FR");
  // A landing whose view could not be read yet (another layout, a lieu being
  // read) is taken by the next view read, unless the user moved meanwhile.
  hold.view("FR", true, false);
  hold.view("FR", false, false);
  hold.derived("fr:reg:84");
  assert.equal(hold.id(), "fr:reg:84");
  hold.view("fr:reg:84", true, false);
  hold.view("fr:reg:84", false, true);
  hold.derived("FR");
  assert.equal(hold.id(), "fr:reg:84");
});

test("a flight the user took over: the command's unit stays held, not what the view reads", () => {
  const hold = createScopeHold();
  // A tap on the Rhône, the finger on the map before the flight has landed.
  hold.view("fr:dep:69", true, true);
  assert.equal(hold.of({ id: "fr:dep:69" })?.id, "fr:dep:69");
  hold.derived("fr:reg:84"); // the view, short of the Rhône, read the région
  assert.equal(hold.id(), "fr:dep:69");
});
