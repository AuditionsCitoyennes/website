// The filters as the place reads take them (map phase 1, design D2, E1, E2):
// the server's query key and parameters from the page's filter state, the text
// debounced, the place picker's tree from the server's units. Run with
// `node --import tsx --test` (root "test:scripts"). No alias, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { effectScope, nextTick, ref } from "vue";
import type { LocationGroup, PlaceLieuRow, PlaceUnitRow } from "@ac/shared";
import { buildLocationTree } from "./filters";
import { buildPlaceTree, type PlaceTreeData } from "./placeTree";
import { passesPlaceIds, placeIdsOf, useServerFilters } from "./serverFilters";

function state() {
  return {
    text: ref(""),
    topics: ref<string[]>([]),
    locations: ref<string[]>([]),
    dateFrom: ref<string | null>(null),
    dateTo: ref<string | null>(null),
    verified: ref(false),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the key and the parameters are the API's (placeFilterKey of the parsed query)", async () => {
  const s = state();
  const scope = effectScope();
  const sf = scope.run(() => useServerFilters(s, { debounceMs: 20 }))!;
  assert.equal(sf.key.value, "");
  assert.deepEqual(sf.params.value, {});
  s.verified.value = true;
  s.topics.value = ["Services publics", "Démocratie et institutions", "pas un thème"];
  s.locations.value = ["fr:dep:69", "l:0123456789abcdef", "r:Bretagne", "FR"];
  s.dateFrom.value = "2025-01-01";
  await nextTick();
  assert.equal(sf.key.value, "v1|m8320|f2025-01-01|uFR,fr:dep:69|ll:0123456789abcdef");
  assert.deepEqual(sf.params.value, {
    v: "1",
    t: "7,13",
    from: "2025-01-01",
    u: "FR,fr:dep:69",
    l: "l:0123456789abcdef",
  });
  scope.stop();
});

test("the text counts once typing pauses; emptied, at once", async () => {
  const s = state();
  const scope = effectScope();
  const sf = scope.run(() => useServerFilters(s, { debounceMs: 30 }))!;
  s.text.value = "Écol";
  await nextTick();
  assert.equal(sf.key.value, "", "not before the pause");
  s.text.value = "Écologie ";
  await wait(10);
  assert.equal(sf.key.value, "");
  await wait(40);
  assert.equal(sf.key.value, "qecologie");
  assert.deepEqual(sf.params.value, { q: "Écologie" });
  s.text.value = "";
  await nextTick();
  assert.equal(sf.key.value, "");
  scope.stop();
});

test("a text shorter than the search's minimum: not applied, and said", async () => {
  const s = state();
  const scope = effectScope();
  const sf = scope.run(() => useServerFilters(s, { debounceMs: 0, minChars: 3 }))!;
  s.text.value = "ab";
  await wait(5);
  assert.equal(sf.key.value, "");
  assert.equal(sf.textTooShort.value, true);
  assert.deepEqual(sf.params.value, {});
  s.text.value = "abc";
  await wait(5);
  assert.equal(sf.key.value, "qabc");
  // An answer said the API's minimum is higher: learnt.
  sf.noteTextIgnored("abc");
  await nextTick();
  assert.equal(sf.minChars.value, 4);
  assert.equal(sf.key.value, "");
  assert.equal(sf.textTooShort.value, true);
  scope.stop();
});

test("places: ids split, an audition's path or lieu matches", () => {
  assert.deepEqual(placeIdsOf(["fr:com:69123", "l:0123456789abcdef", "v:Lyon"]), {
    units: ["fr:com:69123"],
    lieux: ["l:0123456789abcdef"],
  });
  const g = { unitPath: ["FR", "fr:reg:84", "fr:dep:69"], lieuId: "l:0123456789abcdef" };
  assert.equal(passesPlaceIds(g, []), true);
  assert.equal(passesPlaceIds(g, ["fr:reg:84"]), true);
  assert.equal(passesPlaceIds(g, ["l:0123456789abcdef"]), true);
  assert.equal(passesPlaceIds(g, ["fr:dep:38"]), false);
  assert.equal(passesPlaceIds(null, ["fr:dep:38"]), false);
});

// ---- The place picker's tree ----------------------------------------------------

const row = (
  id: string,
  parent: string | null,
  level: string,
  name: string,
  n: number,
  rank: string,
  tie: string,
): PlaceUnitRow => ({
  id,
  parent,
  level,
  name,
  code: id.split(":").pop() ?? null,
  country: "FR",
  polygon: true,
  d: 0,
  n,
  auditions: 1,
  rank,
  tie,
  bbox: [0, 0, 0, 0],
  wrap: false,
});
const lieu = (id: string, unit: string, key: string, n: number, rank: string, tie: string) =>
  ({ id, unit, key, city: null, lat: 0, lng: 0, precision: "address", n, auditions: 1, rank, tie }) as PlaceLieuRow;

function data(): PlaceTreeData {
  const rows = [
    row("FR", null, "country", "France", 12, "2026-09-01", "a"),
    row("fr:reg:84", "FR", "region", "Auvergne-Rhône-Alpes", 12, "2026-09-01", "a"),
    row("fr:dep:69", "fr:reg:84", "county", "Rhône", 12, "2026-09-01", "a"),
    row("fr:com:69123", "fr:dep:69", "locality", "Lyon", 7, "2026-09-01", "a"),
    row("fr:com:69387", "fr:com:69123", "locality", "Lyon 7e", 4, "2026-09-01", "a"),
    row("fr:com:69381", "fr:com:69123", "locality", "Lyon 1er", 3, "2026-08-01", "c"),
    row("fr:com:69266", "fr:dep:69", "locality", "Villeurbanne", 5, "2026-07-01", "d"),
  ];
  const lieux = [
    lieu("l:a", "fr:com:69387", "Place Jean Macé, Lyon", 4, "2026-09-01", "a"),
    lieu("l:c", "fr:com:69381", "Place des Terreaux, Lyon", 3, "2026-08-01", "c"),
    lieu("l:d", "fr:com:69266", "Place Grandclément, Villeurbanne", 5, "2026-07-01", "d"),
  ];
  const units = new Map<string, { row: PlaceUnitRow | null; childIds: string[]; lieuIds: string[] }>();
  units.set("world", { row: null, childIds: ["FR"], lieuIds: [] });
  for (const r of rows) {
    units.set(r.id, {
      row: r,
      childIds: rows.filter((c) => c.parent === r.id).map((c) => c.id),
      lieuIds: lieux.filter((l) => l.unit === r.id).map((l) => l.id),
    });
  }
  return { units, lieux: new Map(lieux.map((l) => [l.id, l])) };
}

test("the place picker's tree: one country, its régions first; arrondissements flattened", () => {
  const tree = buildPlaceTree(data());
  const strip = (n: { label: string; hint?: string; count?: number; token: string; children?: unknown[] }): unknown => ({
    token: n.token,
    label: n.label,
    hint: n.hint ?? null,
    count: n.count,
    children: (n.children as never[] | undefined)?.map(strip) ?? null,
  });
  assert.deepEqual(tree.map(strip), [
    {
      token: "fr:reg:84",
      label: "Auvergne-Rhône-Alpes",
      hint: null,
      count: 12,
      children: [
        {
          token: "fr:dep:69",
          label: "Rhône",
          hint: "69",
          count: 12,
          children: [
            {
              token: "fr:com:69123",
              label: "Lyon",
              hint: null,
              count: 7,
              children: [
                { token: "l:a", label: "Place Jean Macé, Lyon", hint: null, count: 4, children: null },
                { token: "l:c", label: "Place des Terreaux, Lyon", hint: null, count: 3, children: null },
              ],
            },
            {
              token: "fr:com:69266",
              label: "Villeurbanne",
              hint: null,
              count: 5,
              children: [
                { token: "l:d", label: "Place Grandclément, Villeurbanne", hint: null, count: 5, children: null },
              ],
            },
          ],
        },
      ],
    },
  ]);
  // "avec arrondissements": a level of their own.
  const withArr = buildPlaceTree(data(), { arrondissements: true });
  const lyon = withArr[0].children![0].children![0];
  assert.deepEqual(
    lyon.children!.map((c) => c.label),
    ["Lyon 7e", "Lyon 1er"],
  );
});

test("the place picker's tree matches the corpus' (labels, hints, counts, order)", () => {
  const groups: LocationGroup[] = [
    { canonicalName: "Place Jean Macé, Lyon", coordinates: [0, 0], auditions: [], totalTestimonies: 4, city: "Lyon", departementCode: "69", departementName: "Rhône", region: "Auvergne-Rhône-Alpes" },
    { canonicalName: "Place des Terreaux, Lyon", coordinates: [0, 0], auditions: [], totalTestimonies: 3, city: "Lyon", departementCode: "69", departementName: "Rhône", region: "Auvergne-Rhône-Alpes" },
    { canonicalName: "Place Grandclément, Villeurbanne", coordinates: [0, 0], auditions: [], totalTestimonies: 5, city: "Villeurbanne", departementCode: "69", departementName: "Rhône", region: "Auvergne-Rhône-Alpes" },
  ];
  const corpus = buildLocationTree(groups.map((g) => ({ area: g, weight: g.totalTestimonies })));
  const strip = (n: { label: string; hint?: string; count?: number; children?: unknown[] }): unknown => ({
    label: n.label,
    hint: n.hint ?? null,
    count: n.count,
    children: (n.children as never[] | undefined)?.map(strip) ?? null,
  });
  assert.deepEqual(buildPlaceTree(data()).map(strip), corpus.map(strip));
});
