// The server's tree against the corpus' (map phase 1, design E2): the same
// groups, summed as place_counts sums them, must make the same tree — counts,
// labels, levels, centres, boxes, codes and the children's order — and a unit
// whose children are not known yet stops the scope's walk. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue, no alias.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LocationGroup, PlaceLieuRow, PlaceUnitRow } from "@ac/shared";
import { buildGeoHierarchy } from "./hierarchy";
import { scopeForView } from "./scope";
import { buildTreeFromUnits, byServerOrder, WORLD, type UnitTreeData } from "./treeFromUnits";
import type { GeoUnit } from "./types";

/** geo_units as the fixtures need them. */
const UNITS: Record<
  string,
  { parent: string | null; level: string; name: string; code: string | null }
> = {
  FR: { parent: null, level: "country", name: "France", code: null },
  "fr:reg:84": { parent: "FR", level: "region", name: "Auvergne-Rhône-Alpes", code: "84" },
  "fr:reg:03": { parent: "FR", level: "region", name: "Guyane", code: "03" },
  "fr:dep:69": { parent: "fr:reg:84", level: "county", name: "Rhône", code: "69" },
  "fr:dep:38": { parent: "fr:reg:84", level: "county", name: "Isère", code: "38" },
  "fr:dep:973": { parent: "fr:reg:03", level: "county", name: "Guyane", code: "973" },
  "fr:com:69123": { parent: "fr:dep:69", level: "locality", name: "Lyon", code: "69123" },
  "fr:com:69387": { parent: "fr:com:69123", level: "locality", name: "Lyon 7e", code: "69387" },
  "fr:com:69381": { parent: "fr:com:69123", level: "locality", name: "Lyon 1er", code: "69381" },
  "fr:com:69266": { parent: "fr:dep:69", level: "locality", name: "Villeurbanne", code: "69266" },
  "fr:com:38185": { parent: "fr:dep:38", level: "locality", name: "Grenoble", code: "38185" },
  "fr:com:97302": { parent: "fr:dep:973", level: "locality", name: "Cayenne", code: "97302" },
};

let auditionSeq = 0;
/** A group as /api/map serves it, its auditions newest first. */
function group(
  canonicalName: string,
  path: string[],
  coordinates: [number, number],
  counts: [date: string, n: number][],
): LocationGroup {
  const leaf = path[path.length - 1];
  const com = path.find((u) => u.startsWith("fr:com:") && UNITS[u].parent?.startsWith("fr:dep:"));
  const arr = path.find((u) => u.startsWith("fr:com:") && UNITS[u].parent?.startsWith("fr:com:"));
  const dep = path.find((u) => u.startsWith("fr:dep:"));
  const auditions = counts
    .map(([date, n]) => ({
      id: `00000000-0000-4000-8000-${String(++auditionSeq).padStart(12, "0")}`,
      title: `Audition ${auditionSeq}`,
      date,
      location: canonicalName,
      testimony_count: n,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1));
  return {
    canonicalName,
    coordinates,
    auditions,
    totalTestimonies: counts.reduce((s, [, n]) => s + n, 0),
    city: com ? UNITS[com].name : null,
    citycode: arr ? UNITS[arr].code : com ? UNITS[com].code : null,
    arrondissement: arr ? UNITS[arr].name : null,
    departementCode: dep ? UNITS[dep].code : null,
    departementName: dep ? UNITS[dep].name : null,
    region: UNITS[path[1]].name,
    unitPath: path,
    lieuId: `l:${leaf}|${canonicalName}`,
  };
}

const GROUPS: LocationGroup[] = [
  group(
    "Place Jean Macé, Lyon",
    ["FR", "fr:reg:84", "fr:dep:69", "fr:com:69123", "fr:com:69387"],
    [45.745, 4.842],
    [
      ["2026-09-01", 3],
      ["2026-05-02", 1],
    ],
  ),
  group(
    "Marché Jean Macé, Lyon 7",
    ["FR", "fr:reg:84", "fr:dep:69", "fr:com:69123", "fr:com:69387"],
    [45.7463, 4.8422],
    [["2026-08-01", 4]],
  ),
  group(
    "Place des Terreaux, Lyon",
    ["FR", "fr:reg:84", "fr:dep:69", "fr:com:69123", "fr:com:69381"],
    [45.7674, 4.8336],
    [["2026-08-01", 4]],
  ),
  group(
    "Place Grandclément, Villeurbanne",
    ["FR", "fr:reg:84", "fr:dep:69", "fr:com:69266"],
    [45.7579, 4.8874],
    [["2026-10-01", 8]],
  ),
  group(
    "Marché des Gratte-Ciel, Villeurbanne",
    ["FR", "fr:reg:84", "fr:dep:69", "fr:com:69266"],
    [45.7676, 4.8799],
    [["2026-10-01", 8]],
  ),
  group(
    "Place Grenette, Grenoble",
    ["FR", "fr:reg:84", "fr:dep:38", "fr:com:38185"],
    [45.191, 5.7276],
    [["2026-06-25", 5]],
  ),
  group("Isère", ["FR", "fr:reg:84", "fr:dep:38"], [45.3, 5.5], [["2026-01-01", 2]]),
  group(
    "Cayenne",
    ["FR", "fr:reg:03", "fr:dep:973", "fr:com:97302"],
    [4.9252, -52.3116],
    [["2025-09-08", 4]],
  ),
];

/** /api/map's order: by each lieu's newest audition (date desc, id). */
function mapOrder(groups: LocationGroup[]): LocationGroup[] {
  const key = (g: LocationGroup) => g.auditions[0];
  return [...groups].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return x.date !== y.date ? (x.date < y.date ? 1 : -1) : x.id < y.id ? -1 : 1;
  });
}

/** The groups summed as place_counts sums them: every unit and lieu, whole. */
function serverData(
  groups: LocationGroup[],
  loaded: (id: string) => boolean = () => true,
): UnitTreeData {
  const lieux = new Map<string, PlaceLieuRow>();
  for (const g of groups) {
    const newest = g.auditions[0];
    lieux.set(g.lieuId!, {
      id: g.lieuId!,
      unit: g.unitPath![g.unitPath!.length - 1],
      key: g.canonicalName,
      city: g.city ?? null,
      lat: g.coordinates[0],
      lng: g.coordinates[1],
      precision: "address",
      n: g.totalTestimonies,
      auditions: g.auditions.length,
      rank: newest.date!,
      tie: newest.id,
    });
  }
  const rows = new Map<string, PlaceUnitRow>();
  for (const id of Object.keys(UNITS)) {
    const mine = groups.filter((g) => g.unitPath!.includes(id)).map((g) => lieux.get(g.lieuId!)!);
    if (!mine.length) continue;
    const first = [...mine].sort(byServerOrder)[0];
    const lats = mine.map((l) => l.lat);
    const lngs = mine.map((l) => l.lng);
    const u = UNITS[id];
    rows.set(id, {
      id,
      parent: u.parent,
      level: u.level,
      name: u.name,
      code: u.code,
      country: "FR",
      polygon: true,
      d: 0,
      n: mine.reduce((s, l) => s + l.n, 0),
      auditions: mine.reduce((s, l) => s + l.auditions, 0),
      rank: first.rank,
      tie: first.tie,
      bbox: [Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs)],
      wrap: false,
    });
  }
  const units = new Map<
    string,
    UnitTreeData["units"] extends ReadonlyMap<string, infer E> ? E : never
  >();
  for (const id of [WORLD, ...rows.keys()]) {
    const childIds = [...rows.values()].filter((r) => (r.parent ?? WORLD) === id).map((r) => r.id);
    const lieuIds = [...lieux.values()].filter((l) => l.unit === id).map((l) => l.id);
    units.set(id, { row: rows.get(id) ?? null, childIds, lieuIds, loaded: loaded(id) });
  }
  return { units, lieux };
}

/** Every field the map and the panel read, the ids left aside. */
function shape(u: GeoUnit): unknown {
  return {
    levelKey: u.levelKey,
    label: u.label,
    depth: u.depth,
    count: u.count,
    center: u.center,
    bounds: u.bounds,
    heightClass: u.heightClass,
    insee: u.insee ?? null,
    canonical: u.canonical ?? null,
    country: u.geoRef?.country ?? null,
    level: u.geoRef?.level ?? null,
    nom: u.geoRef?.nom ?? null,
    // The corpus knows no région's code (the map's groups carry its name).
    code: u.levelKey === "region" ? null : (u.geoRef?.code ?? null),
    children: u.children.map(shape),
  };
}

test("the server's tree is the corpus' tree, unit for unit and in the same order", () => {
  const groups = mapOrder(GROUPS);
  const corpus = buildGeoHierarchy(groups).root;
  const server = buildTreeFromUnits(serverData(groups)).root;
  assert.deepEqual(shape(server), shape(corpus));
});

test("levels, ids, codes and France's frame", () => {
  const { index } = buildTreeFromUnits(serverData(mapOrder(GROUPS)));
  const fr = index.get("FR")!;
  assert.equal(fr.levelKey, "country");
  assert.deepEqual(fr.geoRef, { country: "FR", level: "country", code: "FR", nom: "France" });
  assert.deepEqual(fr.bounds, { minLat: 41.3, maxLat: 51.1, minLng: -5.2, maxLng: 9.6 });
  assert.equal(index.get("fr:reg:84")!.levelKey, "region");
  assert.equal(index.get("fr:dep:69")!.levelKey, "dep");
  assert.equal(index.get("fr:dep:69")!.heightClass, "half");
  const lyon = index.get("fr:com:69123")!;
  assert.equal(lyon.levelKey, "city");
  assert.equal(lyon.insee, "69123");
  const lyon7 = index.get("fr:com:69387")!;
  assert.equal(lyon7.levelKey, "arr");
  assert.equal(lyon7.insee, "69387");
  assert.deepEqual(lyon7.ancestors, ["world", "FR", "fr:reg:84", "fr:dep:69", "fr:com:69123"]);
  const mace = index.get("l:fr:com:69387|Place Jean Macé, Lyon")!;
  assert.equal(mace.levelKey, "place");
  assert.equal(mace.label, "Place Jean Macé");
  assert.equal(mace.canonical, "Place Jean Macé, Lyon");
  assert.equal(mace.parentId, "fr:com:69387");
  // A lieu at its département's level, beside the communes.
  const isere = index.get("fr:dep:38")!;
  assert.deepEqual(
    isere.children.map((c) => c.label),
    ["Grenoble", "Isère"],
  );
});

test("ties: testimonies, then the newest audition's date, then its id", () => {
  const { index } = buildTreeFromUnits(serverData(mapOrder(GROUPS)));
  const villeurbanne = index.get("fr:com:69266")!;
  // 8 testimonies each, on the same day: the newest audition's id decides.
  const order = villeurbanne.children.map((c) => c.label);
  const corpus = buildGeoHierarchy(mapOrder(GROUPS)).index;
  const corpusVilleurbanne = [...corpus.values()].find((u) => u.label === "Villeurbanne")!;
  assert.deepEqual(
    order,
    corpusVilleurbanne.children.map((c) => c.label),
  );
  assert.equal(order.length, 2);
});

test("a unit whose children are not known yet: pending, and the scope stops above it", () => {
  const data = serverData(mapOrder(GROUPS), (id) => id !== "fr:dep:69");
  const { root, index } = buildTreeFromUnits(data);
  const rhone = index.get("fr:dep:69")!;
  assert.equal(rhone.childrenPending, true);
  assert.deepEqual(rhone.children, []);
  assert.equal(index.get("fr:dep:38")!.childrenPending, undefined);
  // A view on Lyon, close: the walk reaches the Rhône and goes no further.
  const view = { minLat: 45.7, maxLat: 45.8, minLng: 4.78, maxLng: 4.92 };
  const prefer = new Set(["world", "FR", "fr:reg:84", "fr:dep:69"]);
  assert.equal(scopeForView(root, view, prefer).id, "fr:dep:69");
});

test("the world before its answer: no children, pending", () => {
  const { root } = buildTreeFromUnits({ units: new Map(), lieux: new Map() });
  assert.equal(root.id, "world");
  assert.equal(root.childrenPending, true);
  assert.deepEqual(root.children, []);
});

test("a lieu known from a list only: under its unit, or the deepest unit the tree holds", () => {
  const groups = mapOrder(GROUPS);
  const lyon7 = ["FR", "fr:reg:84", "fr:dep:69", "fr:com:69123", "fr:com:69387"];
  const stub = {
    id: "l:0123456789abcdef",
    key: "Square Delfosse, Lyon",
    unit: "fr:com:69387",
    path: lyon7,
    lat: 45.74,
    lng: 4.84,
    city: "Lyon",
    n: 3,
  };
  // Its unit is in the tree, its lieux not known yet: last among its
  // children, labelled and placed.
  const whole = serverData(groups, (id) => id !== "fr:com:69387");
  const { index } = buildTreeFromUnits({ ...whole, stubs: new Map([[stub.id, stub]]) });
  const u = index.get(stub.id)!;
  assert.equal(u.levelKey, "place");
  assert.equal(u.label, "Square Delfosse");
  assert.equal(u.canonical, stub.key);
  assert.deepEqual(u.center, [45.74, 4.84]);
  assert.equal(u.count, 3);
  assert.equal(u.insee, "69387");
  assert.equal(u.parentId, "fr:com:69387");
  assert.deepEqual(u.ancestors, ["world", ...lyon7]);
  const parent = index.get("fr:com:69387")!;
  assert.equal(parent.children[parent.children.length - 1], u);
  // Counts are the server's: a stub adds nothing to its unit's.
  assert.equal(parent.count, buildTreeFromUnits(whole).index.get("fr:com:69387")!.count);

  // The Rhône's children not known yet: under the Rhône, the deepest held.
  const lazy = serverData(groups, (id) => id !== "fr:dep:69" && id !== "fr:com:69387");
  const pending = buildTreeFromUnits({ ...lazy, stubs: new Map([[stub.id, stub]]) }).index;
  assert.equal(pending.get(stub.id)!.parentId, "fr:dep:69");
  assert.equal(pending.get(stub.id)!.insee, undefined);
  assert.equal(pending.get("fr:dep:69")!.childrenPending, true);

  // Nothing of its path held (the world not answered yet): under the world.
  const empty = buildTreeFromUnits({
    units: new Map(),
    lieux: new Map(),
    stubs: new Map([[stub.id, stub]]),
  });
  assert.equal(empty.index.get(stub.id)!.parentId, "world");
});

test("a stub gives way to the lieu's own row", () => {
  const groups = mapOrder(GROUPS);
  const data = serverData(groups);
  const real = [...data.lieux.values()][0];
  const stub = {
    id: real.id,
    key: "Another name",
    unit: real.unit,
    path: ["FR"],
    lat: 0,
    lng: 0,
    city: null,
    n: 0,
  };
  const withStub = buildTreeFromUnits({ ...data, stubs: new Map([[stub.id, stub]]) });
  const plain = buildTreeFromUnits(data);
  assert.deepEqual(shape(withStub.root), shape(plain.root));
  assert.equal(withStub.index.get(real.id)!.canonical, real.key);
});

test("a stub whose unit's lieux are known without it is gone: it does not match", () => {
  const groups = mapOrder(GROUPS);
  const lyon7 = ["FR", "fr:reg:84", "fr:dep:69", "fr:com:69123", "fr:com:69387"];
  const stub = {
    id: "l:0123456789abcdef",
    key: "Square Delfosse, Lyon",
    unit: "fr:com:69387",
    path: lyon7,
    lat: 45.74,
    lng: 4.84,
    city: "Lyon",
    n: 3,
  };
  const data = serverData(groups);
  const withStub = buildTreeFromUnits({ ...data, stubs: new Map([[stub.id, stub]]) });
  assert.equal(withStub.index.has(stub.id), false);
  assert.deepEqual(shape(withStub.root), shape(buildTreeFromUnits(data).root));
});
