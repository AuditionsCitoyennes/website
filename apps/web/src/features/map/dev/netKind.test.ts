// The map's request kinds, run with `node --import tsx --test` (root
// "test:scripts"). Pure: no map, no Vue, no alias.

import assert from "node:assert/strict";
import { test } from "node:test";
import { netKind } from "./netKind";

const API = "http://127.0.0.1:3391";

test("every kind the map already had keeps its answer", () => {
  const cases: [string, string | null][] = [
    [`${API}/api/dem/0f3a9c/12/2101/1461`, "dem.tiles"],
    [`${API}/api/dem`, "dem.post"],
    [`${API}/api/dem/`, "dem.post"],
    [`${API}/api/dem?x=1`, "dem.post"],
    [`${API}/api/boundaries/departement/69`, "boundaries.departement"],
    [`${API}/api/boundaries/communes?codes=69123,69387`, "boundaries.communes"],
    [`${API}/api/boundaries/regions`, "boundaries.levels"],
    [`${API}/api/boundaries/metropole`, "boundaries.levels"],
    [`${API}/api/map/units`, "api.map"],
    [`${API}/api/places?level=departement`, "api.other"],
    ["https://api.mapbox.com/styles/v1/mapbox/standard", "mapbox"],
    ["http://127.0.0.1:5399/boundaries.pmtiles", "pmtiles"],
    ["http://127.0.0.1:5399/boundaries.pmtiles?v=2", "pmtiles"],
    ["http://127.0.0.1:5394/src/main.ts", null],
  ];
  for (const [url, kind] of cases) assert.equal(netKind(url), kind, url);
});

test("outline files are `outlines`, wherever they are served from", () => {
  assert.equal(netKind("/map-data/outlines/o1/root.json"), "outlines");
  assert.equal(netKind("/map-data/outlines/o1/k/fr_dep_69.json"), "outlines");
  assert.equal(netKind("/map-data/outlines/o1/u/fr_com_69123.json?v=3"), "outlines");
  assert.equal(
    netKind("https://tiles.example.org/outlines/2026-11-01/g/fr_reg_84.json"),
    "outlines",
  );
});

test("outlines are tested first, before the API kinds", () => {
  assert.equal(netKind(`${API}/api/outlines/o1/root.json`), "outlines");
});

test("a dev server's outline modules are code, not outlines", () => {
  assert.notEqual(netKind("/src/features/geo/outlines/store.ts"), "outlines");
  assert.notEqual(
    netKind("http://127.0.0.1:5394/src/features/geo/outlines/o1/root.json"),
    "outlines",
  );
  assert.equal(netKind("/map-data/outlines/o1/k/"), null);
  assert.equal(netKind("/map-data/outlines/o1/x/fr_dep_69.json"), null);
});
