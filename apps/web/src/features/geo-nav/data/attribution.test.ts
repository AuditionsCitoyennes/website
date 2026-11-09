// The boundary credits (attribution.ts): Etalab's once the files are in,
// « Pays » only with the country files, nothing whenever no boundary is
// drawn (no files read, a session still loading or fallen back), and HTML
// that Mapbox keeps as written (https anchors, no other markup). Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { boundaryAttribution, type OutlineSession } from "./attribution";

const files = boundaryAttribution({ session: "ok", countries: false });
const world = boundaryAttribution({ session: "ok", countries: true });

test("no credit until the files are in, after a fallback, or with no files read", () => {
  const none = boundaryAttribution({ session: null, countries: false });
  assert.deepEqual(none, []);
  const sessions: OutlineSession[] = [null, "loading", "fallback"];
  for (const session of sessions) {
    for (const countries of [false, true]) {
      assert.equal(boundaryAttribution({ session, countries }), none);
    }
  }
  assert.ok(Object.isFrozen(none));
});

test("ok: Etalab and OpenStreetMap, « Pays » only with the country files", () => {
  const all = files.join(" | ");
  assert.match(all, /OpenStreetMap/);
  assert.match(all, /Etalab/);
  assert.match(all, /ODbL/);
  assert.ok(!files.some((s) => s.startsWith("Pays")));
  assert.equal(world.filter((s) => s.startsWith("Pays")).length, 1);
  assert.deepEqual(world.slice(0, files.length), files);
  assert.match(world.at(-1)!, /Overture Maps Foundation/);
});

test("no string credits the API's boundaries", () => {
  for (const s of [...files, ...world]) {
    assert.ok(!s.includes("france-geojson"), s);
    assert.ok(!s.includes("API Géo"), s);
  }
});

test("the same inputs give the same array, frozen", () => {
  assert.equal(boundaryAttribution({ session: "ok", countries: false }), files);
  assert.equal(boundaryAttribution({ session: "ok", countries: true }), world);
  for (const a of [files, world]) assert.ok(Object.isFrozen(a));
});

test("every string non-empty, French, and only https anchors as markup", () => {
  for (const s of new Set([...files, ...world])) {
    assert.ok(text(s).trim().length > 0);
    // French: the credits read « contributeurs », « Licence », « Contours »…
    assert.ok(!/\b(?:contributors|License)\b|\bSource:/.test(text(s)), s);
    const rest = s.replace(/<a href="https:\/\/[^"<>&\s]+">([^<>&]+)<\/a>/g, "$1");
    assert.ok(!/[<>&]/.test(rest), `raw markup outside an anchor: ${s}`);
  }
});

/** The text Mapbox shows for one entry: the anchors' text kept. */
function text(html: string): string {
  return html.replace(/<a href="[^"]*">([^<]*)<\/a>/g, "$1");
}
