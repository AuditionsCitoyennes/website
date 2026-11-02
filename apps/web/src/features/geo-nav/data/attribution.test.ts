// The boundary credits (attribution.ts): the API's wording whenever the API's
// boundaries are what is drawn (api, a files session still loading or fallen
// back), Etalab's once the files are in, « Pays » only with the country files,
// and HTML that Mapbox keeps as written (https anchors, no other markup). Run
// with `node --import tsx --test` (root "test:scripts"). Pure: no Vue, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { boundaryAttribution, type OutlineSession } from "./attribution";

const api = boundaryAttribution({ mode: "api", session: null, countries: false });
const files = boundaryAttribution({ mode: "fichiers", session: "ok", countries: false });
const world = boundaryAttribution({ mode: "fichiers", session: "ok", countries: true });

test("api: the france-geojson line verbatim, then the Géo API's communes", () => {
  assert.ok(api.length >= 2);
  assert.equal(
    text(api[0]!),
    "Source : IGN — Admin Express COG 2018, via france-geojson (Grégoire David) — Licence Ouverte",
  );
  assert.match(text(api[1]!), /^Communes : API Géo/);
  assert.ok(!api.some((s) => s.includes("COG 2018") && s.startsWith("Communes")));
  assert.ok(!api.some((s) => s.includes("Etalab")));
  assert.ok(!api.some((s) => s.startsWith("Pays")));
});

test("the API's wording until the files are in, and after a fallback", () => {
  const sessions: OutlineSession[] = [null, "idle", "loading", "fallback"];
  for (const session of sessions) {
    for (const countries of [false, true]) {
      assert.equal(boundaryAttribution({ mode: "fichiers", session, countries }), api);
    }
  }
  // api mode never reads a session, whatever is passed
  for (const session of ["ok", "loading", "fallback"] as const) {
    assert.equal(boundaryAttribution({ mode: "api", session, countries: true }), api);
  }
});

test("fichiers + ok: Etalab and OpenStreetMap, « Pays » only with the country files", () => {
  assert.notEqual(files, api);
  const all = files.join(" | ");
  assert.match(all, /OpenStreetMap/);
  assert.match(all, /Etalab/);
  assert.match(all, /ODbL/);
  assert.ok(!files.some((s) => s.startsWith("Pays")));
  assert.equal(world.filter((s) => s.startsWith("Pays")).length, 1);
  assert.deepEqual(world.slice(0, files.length), files);
  assert.match(world.at(-1)!, /Overture Maps Foundation/);
});

test("the same inputs give the same array, frozen", () => {
  assert.equal(boundaryAttribution({ mode: "api", session: null, countries: false }), api);
  assert.equal(boundaryAttribution({ mode: "fichiers", session: "ok", countries: false }), files);
  assert.equal(boundaryAttribution({ mode: "fichiers", session: "ok", countries: true }), world);
  for (const a of [api, files, world]) assert.ok(Object.isFrozen(a));
});

test("every string non-empty, French, and only https anchors as markup", () => {
  for (const s of new Set([...api, ...files, ...world])) {
    assert.ok(text(s).trim().length > 0);
    // French: the credits read « contributeurs », « Licence », « Communes »…
    assert.ok(!/\b(contributors|License|Source:)\b/.test(text(s)), s);
    const rest = s.replace(/<a href="https:\/\/[^"<>&\s]+">([^<>&]+)<\/a>/g, "$1");
    assert.ok(!/[<>&]/.test(rest), `raw markup outside an anchor: ${s}`);
  }
});

/** The text Mapbox shows for one entry: the anchors' text kept. */
function text(html: string): string {
  return html.replace(/<a href="[^"]*">([^<]*)<\/a>/g, "$1");
}
