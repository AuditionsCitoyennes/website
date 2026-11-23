// The footer's rule (footerShown.ts) against vue-router's own locations: the
// first navigation still pending, the map page (the old analyses address
// redirected to it), the other pages and the catch-all. Run with
// `node --import tsx --test` (root "test:scripts"). No component, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryHistory, createRouter, START_LOCATION } from "vue-router";
import { ROUTE } from "../shared/routes";
import { footerShown } from "./footerShown";

const page = {};
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: ROUTE.home.path, component: page },
    { path: ROUTE.temoignages.path, component: page },
    { path: "/analyses", redirect: ROUTE.temoignages.path },
    { path: ROUTE.legalNotice.path, component: page },
    { path: ROUTE.notFound.path, component: page },
  ],
});

test("no footer while the first page is not known yet", () => {
  assert.equal(START_LOCATION.matched.length, 0);
  assert.equal(footerShown(START_LOCATION), false);
  assert.equal(footerShown({ matched: [], path: "/" }), false);
});

test("no footer under the map page, the old analyses address included", async () => {
  assert.equal(footerShown(router.resolve(ROUTE.temoignages.path)), false);
  await router.push("/analyses");
  assert.equal(router.currentRoute.value.path, ROUTE.temoignages.path);
  assert.equal(footerShown(router.currentRoute.value), false);
});

test("the footer under every other page, the not-found page included", () => {
  for (const path of [ROUTE.home.path, ROUTE.legalNotice.path, "/nope/deeper"]) {
    assert.equal(footerShown(router.resolve(path)), true, path);
  }
});
