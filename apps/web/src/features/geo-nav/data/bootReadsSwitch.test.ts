// Which reads of the map page wait (bootReadsSwitch.ts), run with
// `node --import tsx --test` (root "test:scripts"): when the Filtres dialog's
// data is wanted, and how many testimony pages are asked ahead on each link.

import assert from "node:assert/strict";
import { test } from "node:test";
import { filtersDataWanted, linkSpared, prefetchCount } from "./bootReadsSwitch";

test("the dialog's data: at its opening; else once the tree is shown and the idle wait passed", () => {
  const s = (opened: boolean, idle: boolean, treeShown: boolean) => ({ opened, idle, treeShown });
  assert.equal(filtersDataWanted(s(true, false, false)), true);
  assert.equal(filtersDataWanted(s(false, false, false)), false);
  assert.equal(filtersDataWanted(s(false, false, true)), false);
  assert.equal(filtersDataWanted(s(false, true, false)), false);
  assert.equal(filtersDataWanted(s(false, true, true)), true);
});

test("pages asked ahead: three, one on a spared link", () => {
  assert.equal(prefetchCount(undefined), 3, "no connection API (Safari, Firefox)");
  assert.equal(prefetchCount({ effectiveType: "4g" }), 3);
  assert.equal(prefetchCount({ effectiveType: "3g" }), 1);
  assert.equal(prefetchCount({ effectiveType: "2g" }), 1);
  assert.equal(prefetchCount({ effectiveType: "slow-2g" }), 1);
  assert.equal(prefetchCount({ saveData: true, effectiveType: "4g" }), 1);
  assert.equal(linkSpared(null), false);
  assert.equal(linkSpared({ saveData: false }), false);
});
