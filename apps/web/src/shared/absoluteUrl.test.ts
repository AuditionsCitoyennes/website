// The absolute base URLs handed to Mapbox (absoluteUrl.ts). Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no DOM, no alias at
// run time.

import assert from "node:assert/strict";
import { test } from "node:test";
import { absoluteBase, apiBase } from "./absoluteUrl";

const o = "http://127.0.0.1:5392";

test("an empty or root-relative base resolves against the origin", () => {
  assert.equal(absoluteBase("", "https://staging.example.org"), "https://staging.example.org");
  assert.equal(absoluteBase("/", o), "http://127.0.0.1:5392");
  assert.equal(absoluteBase("/api", o), "http://127.0.0.1:5392/api");
  assert.equal(absoluteBase("/api/", o), "http://127.0.0.1:5392/api");
});

test("the absolute dev forms come back identical", () => {
  assert.equal(absoluteBase("http://127.0.0.1:3391", o), "http://127.0.0.1:3391");
  assert.equal(absoluteBase("http://localhost:3000/", o), "http://localhost:3000");
});

test("other absolute forms are normalised, one trailing slash removed", () => {
  assert.equal(absoluteBase("http://h:80", o), "http://h");
  assert.equal(absoluteBase("HTTP://H.EXAMPLE/x/", o), "http://h.example/x");
  // Only ONE slash goes: a path that really ends in `//` keeps the other.
  assert.equal(absoluteBase("https://a.b/c//", o), "https://a.b/c/");
});

test("an unusable origin or a malformed base returns the base unchanged", () => {
  assert.doesNotThrow(() => absoluteBase("", "null"));
  assert.equal(absoluteBase("", "null"), "");
  assert.doesNotThrow(() => absoluteBase("http://[bad", o));
  assert.equal(absoluteBase("http://[bad", o), "http://[bad");
});

test("apiBase: unset is the local API, empty is the page's origin", () => {
  assert.equal(apiBase(undefined, o), "http://localhost:3000");
  assert.equal(apiBase("", o), "http://127.0.0.1:5392");
});

test("the DEM tile template is absolute, with no double slash", () => {
  const template = `${apiBase("", o)}/api/dem/v/{z}/{x}/{y}`;
  assert.equal(template, "http://127.0.0.1:5392/api/dem/v/{z}/{x}/{y}");
  assert.doesNotMatch(template.slice("http://".length), /\/\//);
});
