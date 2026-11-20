// The boot curtain's cover (bootListSwitch.ts): the map's box alone on the
// Témoignages page, everything on the home page's card. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue component,
// no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bootCurtainCover } from "./bootListSwitch";

test("the curtain covers the map's box alone, the whole card on the home page", () => {
  assert.equal(bootCurtainCover(false), "map");
  // The home page's card has no panel to show: the whole curtain.
  assert.equal(bootCurtainCover(true), "all");
});
