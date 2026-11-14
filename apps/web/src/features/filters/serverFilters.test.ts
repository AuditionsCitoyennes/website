// The filters as the place reads take them (map phase 1, design D2, E1, E2):
// the server's query key and parameters from the page's filter state, the text
// debounced, the place picker's tree from the server's units. Run with
// `node --import tsx --test` (root "test:scripts"). No alias, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { effectScope, nextTick, ref } from "vue";
import type { LocationGroup, PlaceLieuRow, PlaceUnitRow } from "@ac/shared";
import { buildLocationTree } from "./filters";
import type { LocNode } from "@/shared/ui/select/treeNode";
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

/** The text's pause runs on this clock, never on real time: `pass(ms)` lets
 *  the watchers run, moves the clock on and fires what came due, in order. */
function clock() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set(fn: () => void, ms: number) {
        due.set(++seq, { at: now + ms, fn });
        return seq;
      },
      clear(timer: unknown) {
        due.delete(timer as number);
      },
    },
    async pass(ms: number) {
      await nextTick(); // the change just made reaches its watcher: the pause is armed
      const end = now + ms;
      for (;;) {
        const next = [...due.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
      await nextTick();
    },
    /** Pauses armed and not yet run. */
    armed: () => due.size,
  };
}

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
  const c = clock();
  const sf = scope.run(() => useServerFilters(s, { debounceMs: 30, timers: c.timers }))!;
  s.text.value = "Écol";
  await nextTick();
  assert.equal(sf.key.value, "", "not before the pause");
  s.text.value = "Écologie ";
  await c.pass(10);
  assert.equal(sf.key.value, "");
  await c.pass(19);
  assert.equal(sf.key.value, "", "the pause counts from the last keystroke");
  await c.pass(1);
  assert.equal(sf.key.value, "qecologie");
  assert.equal(c.armed(), 0);
  assert.deepEqual(sf.params.value, { q: "Écologie" });
  s.text.value = "";
  await nextTick();
  assert.equal(sf.key.value, "");
  scope.stop();
});

test("a text shorter than the search's minimum: not applied, and said", async () => {
  const s = state();
  const scope = effectScope();
  const c = clock();
  const sf = scope.run(() =>
    useServerFilters(s, { debounceMs: 0, minChars: 3, timers: c.timers }),
  )!;
  s.text.value = "ab";
  await c.pass(0);
  assert.equal(sf.key.value, "");
  assert.equal(sf.textTooShort.value, true);
  assert.deepEqual(sf.params.value, {});
  s.text.value = "abc";
  await c.pass(0);
  assert.equal(sf.key.value, "qabc");
  // An answer said the API's minimum is higher: learnt.
  sf.noteTextIgnored("abc");
  await nextTick();
  assert.equal(sf.minChars.value, 4);
  assert.equal(sf.key.value, "");
  assert.equal(sf.textTooShort.value, true);
  scope.stop();
});

test("the API's minimum, when its answer gives it, is taken in one step", async () => {
  const s = state();
  const scope = effectScope();
  const c = clock();
  const sf = scope.run(() => useServerFilters(s, { debounceMs: 0, timers: c.timers }))!;
  s.text.value = "é";
  await c.pass(0);
  assert.equal(sf.key.value, "qe");
  sf.noteTextIgnored("e", 3);
  await nextTick();
  assert.equal(sf.minChars.value, 3);
  assert.equal(sf.key.value, "");
  s.text.value = "éc";
  await c.pass(0);
  assert.equal(sf.key.value, "", "no request for a text known to be too short");
  s.text.value = "éco";
  await c.pass(0);
  assert.equal(sf.key.value, "qeco");
  scope.stop();
});

test("while a text waits for typing to pause, the other filters wait with it", async () => {
  const s = state();
  const scope = effectScope();
  const c = clock();
  const sf = scope.run(() => useServerFilters(s, { debounceMs: 30, timers: c.timers }))!;
  s.topics.value = ["Services publics"];
  await nextTick();
  const themed = sf.key.value;
  assert.notEqual(themed, "");
  // In one change: a text typed, the theme taken off. The key never empties
  // on the way (list mode would go off and on).
  s.text.value = "école";
  s.topics.value = [];
  await nextTick();
  assert.equal(sf.key.value, themed, "held");
  await c.pass(10);
  s.verified.value = true; // another change while the text waits
  await nextTick();
  assert.equal(sf.key.value, themed, "still held");
  await c.pass(19);
  assert.equal(sf.key.value, themed, "the text's pause is not started over");
  await c.pass(1);
  assert.equal(sf.key.value, "v1|qecole", "all of it at once");
  // No text waiting: at once.
  s.verified.value = false;
  await nextTick();
  assert.equal(sf.key.value, "qecole");
  scope.stop();
});

test("more than 50 places: the first 50 picked, every other filter kept", async () => {
  const s = state();
  const scope = effectScope();
  const c = clock();
  const sf = scope.run(() => useServerFilters(s, { debounceMs: 0, timers: c.timers }))!;
  const lieux = Array.from(
    { length: 51 },
    (_, i) => `l:${(0xabc0000000000000n + BigInt(i)).toString(16)}`,
  );
  s.verified.value = true;
  s.dateFrom.value = "2026-01-01";
  s.locations.value = lieux;
  await nextTick();
  assert.deepEqual(sf.filters.value.lieux, lieux.slice(0, 50));
  assert.equal(sf.filters.value.verified, true);
  assert.equal(sf.filters.value.from, "2026-01-01");
  assert.ok(sf.key.value.startsWith("v1|f2026-01-01|ll:"));
  assert.equal(sf.params.value.l.split(",").length, 50);
  // A text the API would refuse (a NUL): left out, the rest kept.
  s.text.value = "a\u0000b";
  await c.pass(0);
  assert.ok(sf.key.value.startsWith("v1|f2026-01-01|ll:"));
  assert.equal(sf.params.value.q, undefined);
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
  ({
    id,
    unit,
    key,
    city: null,
    lat: 0,
    lng: 0,
    precision: "address",
    n,
    auditions: 1,
    rank,
    tie,
  }) as PlaceLieuRow;

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
  const units = new Map<
    string,
    { row: PlaceUnitRow | null; childIds: string[]; lieuIds: string[]; loaded: boolean }
  >();
  units.set("world", { row: null, childIds: ["FR"], lieuIds: [], loaded: true });
  for (const r of rows) {
    units.set(r.id, {
      row: r,
      childIds: rows.filter((c) => c.parent === r.id).map((c) => c.id),
      lieuIds: lieux.filter((l) => l.unit === r.id).map((l) => l.id),
      loaded: true,
    });
  }
  return { units, lieux: new Map(lieux.map((l) => [l.id, l])) };
}

/** data() as a lazy read leaves it: these units' children and lieux unknown
 *  (and the lieux under them never read). */
function partial(unloaded: string[]): PlaceTreeData {
  const whole = data();
  const units = new Map(
    [...whole.units].map(([id, e]) =>
      unloaded.includes(id)
        ? [id, { row: e.row, loaded: false }]
        : [id, { ...e, loaded: true as boolean }],
    ),
  );
  const lieux = new Map([...whole.lieux].filter(([, l]) => !unloaded.includes(l.unit)));
  return { units, lieux };
}

test("the place picker's tree: one country, its régions first; arrondissements flattened", () => {
  const tree = buildPlaceTree(data());
  const strip = (n: {
    label: string;
    hint?: string;
    count?: number;
    token: string;
    children?: unknown[];
  }): unknown => ({
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
                {
                  token: "l:a",
                  label: "Place Jean Macé, Lyon",
                  hint: null,
                  count: 4,
                  children: null,
                },
                {
                  token: "l:c",
                  label: "Place des Terreaux, Lyon",
                  hint: null,
                  count: 3,
                  children: null,
                },
              ],
            },
            {
              token: "fr:com:69266",
              label: "Villeurbanne",
              hint: null,
              count: 5,
              children: [
                {
                  token: "l:d",
                  label: "Place Grandclément, Villeurbanne",
                  hint: null,
                  count: 5,
                  children: null,
                },
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
    {
      canonicalName: "Place Jean Macé, Lyon",
      coordinates: [0, 0],
      auditions: [],
      totalTestimonies: 4,
      city: "Lyon",
      departementCode: "69",
      departementName: "Rhône",
      region: "Auvergne-Rhône-Alpes",
    },
    {
      canonicalName: "Place des Terreaux, Lyon",
      coordinates: [0, 0],
      auditions: [],
      totalTestimonies: 3,
      city: "Lyon",
      departementCode: "69",
      departementName: "Rhône",
      region: "Auvergne-Rhône-Alpes",
    },
    {
      canonicalName: "Place Grandclément, Villeurbanne",
      coordinates: [0, 0],
      auditions: [],
      totalTestimonies: 5,
      city: "Villeurbanne",
      departementCode: "69",
      departementName: "Rhône",
      region: "Auvergne-Rhône-Alpes",
    },
  ];
  const corpus = buildLocationTree(groups.map((g) => ({ area: g, weight: g.totalTestimonies })));
  const strip = (n: {
    label: string;
    hint?: string;
    count?: number;
    children?: unknown[];
  }): unknown => ({
    label: n.label,
    hint: n.hint ?? null,
    count: n.count,
    children: (n.children as never[] | undefined)?.map(strip) ?? null,
  });
  assert.deepEqual(buildPlaceTree(data()).map(strip), corpus.map(strip));
});

test("the place picker's tree read lazily: a unit whose children are not loaded is lazy, childless", () => {
  // The world's answer at depth 2: France loaded, its régions not.
  const tree = buildPlaceTree(
    partial([
      "fr:reg:84",
      "fr:dep:69",
      "fr:com:69123",
      "fr:com:69387",
      "fr:com:69381",
      "fr:com:69266",
    ]),
  );
  assert.deepEqual(
    tree.map((n) => ({ token: n.token, count: n.count, lazy: n.lazy, children: n.children })),
    [{ token: "fr:reg:84", count: 12, lazy: "idle", children: undefined }],
  );
  // Where its children stand, as the store says.
  const asked = buildPlaceTree(
    partial([
      "fr:reg:84",
      "fr:dep:69",
      "fr:com:69123",
      "fr:com:69387",
      "fr:com:69381",
      "fr:com:69266",
    ]),
    { arrondissements: false, statusOf: (id) => (id === "fr:reg:84" ? "loading" : null) },
  );
  assert.equal(asked[0].lazy, "loading");
  const failed = buildPlaceTree(partial(["fr:reg:84"]), {
    arrondissements: false,
    statusOf: () => "failed",
  });
  assert.equal(failed[0].lazy, "failed");
});

test("the place picker's tree read lazily: a commune's unloaded arrondissements make it lazy when flattened", () => {
  // Lyon known from its département's answer, its arrondissements not.
  const sans = buildPlaceTree(partial(["fr:com:69387", "fr:com:69381"]));
  const lyon = sans[0].children![0].children![0];
  assert.equal(lyon.label, "Lyon");
  assert.equal(lyon.lazy, "idle", "its lieux are its arrondissements'");
  assert.equal(lyon.children, undefined);
  const villeurbanne = sans[0].children![0].children![1];
  assert.equal(villeurbanne.lazy, undefined);
  assert.deepEqual(
    villeurbanne.children!.map((c) => c.token),
    ["l:d"],
  );
  // "avec arrondissements": Lyon is known, its arrondissements are lazy.
  const avec = buildPlaceTree(partial(["fr:com:69387", "fr:com:69381"]), {
    arrondissements: true,
  });
  const lyonAvec = avec[0].children![0].children![0];
  assert.equal(lyonAvec.lazy, undefined);
  assert.deepEqual(
    lyonAvec.children!.map((c) => [c.label, c.lazy]),
    [
      ["Lyon 7e", "idle"],
      ["Lyon 1er", "idle"],
    ],
  );
});

/** data() with Guyane: a région over the département of its name, Cayenne
 *  in it; `unloaded` as partial() reads them. */
function withGuyane(unloaded: string[] = []): PlaceTreeData {
  const base = partial(unloaded);
  const rows = [
    row("fr:reg:03", "FR", "region", "Guyane", 2, "2025-09-08", "g"),
    row("fr:dep:973", "fr:reg:03", "county", "Guyane", 2, "2025-09-08", "g"),
    row("fr:com:97302", "fr:dep:973", "locality", "Cayenne", 2, "2025-09-08", "g"),
  ];
  const cayenne = lieu("l:g", "fr:com:97302", "Place des Palmistes, Cayenne", 2, "2025-09-08", "g");
  const units = new Map(base.units);
  const fr = units.get("FR")!;
  units.set("FR", { ...fr, childIds: [...(fr.childIds ?? []), "fr:reg:03"] });
  for (const r of rows) {
    const known = !unloaded.includes(r.id);
    const childIds = rows.filter((c) => c.parent === r.id).map((c) => c.id);
    const lieuIds = r.id === "fr:com:97302" ? ["l:g"] : [];
    units.set(
      r.id,
      known ? { row: r, childIds, lieuIds, loaded: true } : { row: r, loaded: false },
    );
  }
  const lieux = new Map(base.lieux);
  if (!unloaded.includes("fr:com:97302")) lieux.set("l:g", cayenne);
  return { units, lieux };
}

test("the place picker lists an overseas territory once: its région, its communes under it", () => {
  const nodes = (ns: LocNode[]): LocNode[] => ns.flatMap((n) => [n, ...nodes(n.children ?? [])]);
  for (const arrondissements of [false, true]) {
    const tree = buildPlaceTree(withGuyane(), { arrondissements });
    const guyane = tree.find((n) => n.label === "Guyane")!;
    assert.equal(guyane.token, "fr:reg:03");
    assert.equal(guyane.count, 2);
    assert.deepEqual(
      guyane.children!.map((c) => [c.token, c.label]),
      [["fr:com:97302", "Cayenne"]],
    );
    assert.equal(nodes(tree).filter((n) => n.label === "Guyane").length, 1);
    assert.equal(
      nodes(tree).some((n) => n.hint === "973"),
      false,
    );
    // The metropolitan subtree is unchanged.
    assert.deepEqual(tree[0], buildPlaceTree(data(), { arrondissements })[0]);
  }
  // As the corpus' tree (the Filtres picker on the corpus, the admin list's):
  // labels, hints, counts and order.
  const area = (canonicalName: string, n: number, more: Partial<LocationGroup>) => ({
    area: {
      canonicalName,
      coordinates: [0, 0] as [number, number],
      auditions: [],
      totalTestimonies: n,
      ...more,
    },
    weight: n,
  });
  const rhone = { departementCode: "69", departementName: "Rhône", region: "Auvergne-Rhône-Alpes" };
  const corpus = buildLocationTree([
    area("Place Jean Macé, Lyon", 4, { city: "Lyon", ...rhone }),
    area("Place des Terreaux, Lyon", 3, { city: "Lyon", ...rhone }),
    area("Place Grandclément, Villeurbanne", 5, { city: "Villeurbanne", ...rhone }),
    area("Place des Palmistes, Cayenne", 2, {
      city: "Cayenne",
      departementCode: "973",
      departementName: "Guyane",
      region: "Guyane",
    }),
  ]);
  const strip = (n: LocNode): unknown => ({
    label: n.label,
    hint: n.hint ?? null,
    count: n.count,
    children: n.children?.map(strip) ?? null,
  });
  assert.deepEqual(buildPlaceTree(withGuyane()).map(strip), corpus.map(strip));
  // Read lazily: the région known from France's answer, its département not.
  const lazy = buildPlaceTree(withGuyane(["fr:dep:973", "fr:com:97302"])).find(
    (n) => n.token === "fr:reg:03",
  )!;
  assert.equal(lazy.lazy, "idle");
  assert.equal(lazy.children, undefined);
});

test("the place picker's whole tree has no lazy node", () => {
  const some = (nodes: LocNode[]): boolean =>
    nodes.some((n) => n.lazy !== undefined || some(n.children ?? []));
  assert.equal(some(buildPlaceTree(data())), false);
  assert.equal(some(buildPlaceTree(data(), { arrondissements: true })), false);
});
