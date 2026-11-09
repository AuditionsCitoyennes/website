// The location combobox's BAN request and filter (banSuggestions.ts): one
// request without a `type`, then only precise results — a house number, a
// street or a lieu-dit with a commune code and a point — in BAN's order, five
// at most. Fixtures have the shape of BAN's answers. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BAN_SHOWN, banSearchUrl, isPickType, preciseSuggestions } from "./banSuggestions";

const at = (lng: number, lat: number) => ({ coordinates: [lng, lat] as [number, number] });
const feature = (id: string, type: string, citycode?: string, point = true) => ({
  ...(point ? { geometry: at(4.88, 45.77) } : {}),
  properties: { id, type, ...(citycode ? { citycode } : {}) },
});

test("banSearchUrl: the query encoded, ten results asked, no type filter", () => {
  const url = banSearchUrl("Place d'Armes");
  assert.equal(url, "https://api-adresse.data.gouv.fr/search/?q=Place%20d'Armes&limit=10");
  assert.equal(new URL(url).searchParams.get("q"), "Place d'Armes");
  assert.equal(new URL(url).searchParams.has("type"), false);
});

test("preciseSuggestions: drops communes and incomplete results, keeps BAN's order, five at most", () => {
  const features = [
    feature("villeurbanne", "municipality", "69266"),
    feature("cours-emile-zola", "street", "69266"),
    feature("parc-jorge-semprun", "locality", "69266"),
    feature("no-citycode", "street"),
    feature("12-rue-racine", "housenumber", "69266"),
    feature("no-point", "street", "69266", false),
    feature("rue-leon-blum", "street", "69266"),
    feature("place-lazare-goujon", "street", "69266"),
    feature("rue-de-lyon", "street", "59350"),
    feature("square-gendron", "locality", "69266"),
  ];
  const kept = preciseSuggestions(features).map((f) => f.properties.id);
  assert.deepEqual(kept, [
    "cours-emile-zola",
    "parc-jorge-semprun",
    "12-rue-racine",
    "rue-leon-blum",
    "place-lazare-goujon",
  ]);
  assert.equal(kept.length, BAN_SHOWN);
});

test("preciseSuggestions: only communes → nothing to offer", () => {
  const features = [
    feature("lyon", "municipality", "69123"),
    feature("bron", "municipality", "69029"),
  ];
  assert.deepEqual(preciseSuggestions(features), []);
  assert.deepEqual(preciseSuggestions([]), []);
});

test("isPickType: house numbers, streets and lieux-dits; never a commune", () => {
  assert.equal(isPickType("municipality"), false);
  assert.equal(isPickType("street"), true);
  assert.equal(isPickType("housenumber"), true);
  assert.equal(isPickType("locality"), true);
  assert.equal(isPickType(undefined), false);
});
