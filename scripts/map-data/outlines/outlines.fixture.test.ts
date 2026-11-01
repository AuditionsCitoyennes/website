// The format contract on a toy France (CI never runs mapshaper): two régions,
// three départements, five communes, one city with two arrondissements, and
// two countries (one on both sides of ±180), already "simplified", through the
// pure pack and check; then one broken copy per gate, each failing with its
// offender named.
import assert from "node:assert/strict";
import { test } from "node:test";
import { check, type CheckResult } from "./check";
import {
  WORLD_RUNGS,
  bboxOf,
  diagM,
  unwrap,
  validateFileV1,
  type Geometry,
  type Level,
  type OutlineFileV1,
  type RootV1,
} from "./lib";
import { pack, type CountryInput, type PackUnit } from "./pack";

// A rectangle walked along a 0.5° lattice: two cells sharing an edge draw it
// with the same vertices, as Etalab's units do.
function cell(x0: number, y0: number, x1: number, y1: number): Geometry {
  const ring: [number, number][] = [];
  const walk = (ax: number, ay: number, bx: number, by: number) => {
    const n = Math.round(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) / 0.5);
    for (let i = 0; i < n; i++) ring.push([ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n]);
  };
  walk(x0, y0, x1, y0);
  walk(x1, y0, x1, y1);
  walk(x1, y1, x0, y1);
  walk(x0, y1, x0, y0);
  ring.push([x0, y0]);
  return { type: "Polygon", coordinates: [ring] };
}
const unit = (id: string, level: Level, parent: string, g: Geometry): PackUnit =>
  ({ id, name: `name of ${id}`, level, parent, g }) as const;

const regions = [
  unit("fr:reg:11", "region", "FR", cell(0, 0, 2, 1)),
  unit("fr:reg:24", "region", "FR", cell(2, 0, 3, 1)),
];
const deps = [
  unit("fr:dep:75", "dep", "fr:reg:11", cell(0, 0, 1, 1)),
  unit("fr:dep:77", "dep", "fr:reg:11", cell(1, 0, 2, 1)),
  unit("fr:dep:18", "dep", "fr:reg:24", cell(2, 0, 3, 1)),
];
const communes = [
  unit("fr:com:75001", "city", "fr:dep:75", cell(0, 0, 0.5, 1)),
  unit("fr:com:75056", "city", "fr:dep:75", cell(0.5, 0, 1, 1)),
  unit("fr:com:77001", "city", "fr:dep:77", cell(1, 0, 2, 1)),
  unit("fr:com:18001", "city", "fr:dep:18", cell(2, 0, 2.5, 1)),
  unit("fr:com:18002", "city", "fr:dep:18", cell(2.5, 0, 3, 1)),
];
const arrondissements = [
  unit("fr:com:75101", "arr", "fr:com:75056", cell(0.5, 0, 1, 0.5)),
  unit("fr:com:75102", "arr", "fr:com:75056", cell(0.5, 0.5, 1, 1)),
];
// Countries as the world runs give them: the same outline at every rung here.
// UM: Wake-like (the largest), Midway-like across ±180, Navassa-like in the
// Caribbean; unwrapped, it spans 166..285 and takes c3000.
const country = (id: string, ...parts: Geometry[]): CountryInput => {
  const g: Geometry = {
    type: "MultiPolygon",
    coordinates: parts.map((p) => p.coordinates as never),
  };
  const run = unwrap(g);
  return {
    id,
    name: `name of ${id}`,
    diagM: diagM(bboxOf(run.g)),
    runs: new Map(WORLD_RUNGS.map((m) => [m, run])),
  };
};
const countries = [
  country("FR", cell(0, 0, 3, 1)),
  country("MC", cell(7, 43.5, 7.5, 44)),
  country("UM", cell(166, 19, 167, 19.5), cell(-177.5, 28, -177, 28.5), cell(-75.5, 18, -75, 18.5)),
];
const expected = {
  regionNames: regions.map((r) => r.name),
  depCodes: ["75", "77", "18"],
  fixtureIds: [...communes, ...arrondissements].map((c) => c.id),
  countryIds: countries.map((c) => c.id),
};

function build(): Map<string, unknown> {
  const { files } = pack({
    build: "o20261102-1",
    fr: { tolM: 1000, self: cell(0, 0, 3, 1), regions },
    regions,
    regionSelves: new Map(regions.map((r) => [r.id, r.g])),
    deps,
    communes,
    arrondissements,
    families: new Map(),
    countries,
  });
  // A deep copy the broken cases may change.
  return new Map([...files].map(([p, f]) => [p, JSON.parse(JSON.stringify(f))]));
}
const run = (files: Map<string, unknown>, more: Partial<typeof expected> = {}): CheckResult =>
  check(files, {
    regionRefs: new Map(regions.map((r) => [r.id, r.g])),
    expected: { ...expected, ...more },
  });
const failed = (res: CheckResult, gate: string): string[] => {
  const g = res.gates.find((x) => x.name.startsWith(gate));
  assert.ok(g && !g.ok, `gate ${gate} should fail`);
  return g.offenders;
};
const k = (files: Map<string, unknown>, p: string) => files.get(p) as OutlineFileV1 & { kind: "k" };

test("the toy France packs into format v1 and passes every gate", () => {
  const files = build();
  assert.deepEqual([...files.keys()].sort(), [
    ...["FR", "MC", "UM"].map((x) => `g/${x}.json`),
    "k/FR.json",
    "k/fr_com_75056.json",
    ...["fr_dep_18", "fr_dep_75", "fr_dep_77", "fr_reg_11", "fr_reg_24"].map((x) => `k/${x}.json`),
    "root.json",
    "u/MC.json",
    "u/UM.json",
    ...["fr_dep_18", "fr_dep_75", "fr_dep_77", "fr_reg_11", "fr_reg_24"].map((x) => `u/${x}.json`),
  ]);
  const dep = k(files, "k/fr_dep_75.json");
  const json = (v: unknown) => JSON.stringify(v).replaceAll('"', "");
  assert.equal(Object.keys(dep).join(), "v,build,kind,id,tier,tolM,self,units");
  assert.equal(Object.keys(dep.self).join(), "id,bbox,center,n,g");
  assert.equal(Object.keys(dep.units[0]).join(), "id,name,level,k,u,bbox,center,n,g");
  assert.equal(
    json(dep.units.map((u) => [u.id, u.k, u.u])),
    "[[fr:com:75001,0,0],[fr:com:75056,1,0]]",
  );
  for (const [p, f] of files) if (p !== "root.json") assert.ok(validateFileV1(f).ok, p);
  const root = files.get("root.json") as RootV1;
  const overture = (m: number) => `{tolM:${m},source:overture}`;
  const tiers = `{e50:{tolM:0,source:etalab-50m},fr1000:{tolM:1000,source:etalab-50m},w3000:${overture(3000)},c15:${overture(15)},c3000:${overture(3000)}}`;
  assert.equal(json(root.tiers), tiers);
  const fr = "{id:FR,parent:null,level:country,name:France,bbox:[0,0,3,1],center:[0.5,1.5]";
  assert.equal(json(root.units[0]), `${fr},st:fr1000,k:1,u:0,g:1}`);
  assert.equal(root.units.length, 8);
  const um = root.units.find((r) => r.id === "UM")!;
  const umRow =
    "{id:UM,parent:null,level:country,name:name of UM,bbox:[166,18,285,28.5],center:[19.25,166.5]";
  assert.equal(json(um), `${umRow},st:c3000,k:0,u:1,g:1,wrap:1}`);
  assert.equal(root.units.find((r) => r.id === "MC")?.st, "c15");
  const [u, g] = ["u/UM.json", "g/UM.json"].map((x) => files.get(x) as OutlineFileV1);
  assert.equal(Object.keys(u).join(), "v,build,kind,id,tier,tolM,self,wrap");
  assert.equal(JSON.stringify(u.self.g), JSON.stringify(g.self.g));
  const res = run(files);
  assert.equal(res.gates.filter((g) => !g.ok).length, 0, JSON.stringify(res.gates));
  assert.equal(res.parents.length, 7);
  assert.ok(res.parents.every((p) => p.segmentsEqual && p.sharedPct === 100));
});

test("gate 1 names a parent whose edge leaves its children's lines", () => {
  const files = build();
  const ring = k(files, "k/fr_dep_75.json").self.g.coordinates[0] as [number, number][];
  ring[1] = [ring[1][0], ring[1][1] - 0.001];
  assert.ok(failed(run(files), "1").some((o) => o.startsWith("k/fr_dep_75.json")));
});

test("gate 2 names an id@tier drawn twice with different bytes", () => {
  const files = build();
  const ring = (files.get("u/fr_dep_77.json") as OutlineFileV1).self.g.coordinates[0] as number[][];
  ring.splice(0, ring.length, ...ring.slice(1), ring[1]); // the same ring from its next vertex
  assert.ok(failed(run(files), "2").some((o) => o.startsWith("fr:dep:77@e50")));
});

test("gate 3 names a self over 20,000 vertices", () => {
  const files = build();
  const f = files.get("u/fr_dep_18.json") as OutlineFileV1;
  const ring = Array.from({ length: 20_001 }, (_, i): [number, number] => [2 + i / 1e5, i % 2]);
  ring.push(ring[0]);
  f.self.g = { type: "Polygon", coordinates: [ring] };
  f.self.n = 20_002;
  assert.ok(failed(run(files), "3").includes("u/fr_dep_18.json: self of 20002 vertices > 20000"));
});

test("gate 4 names a fixture unit with no outline", () => {
  const offenders = failed(run(build(), { fixtureIds: ["fr:com:75056", "fr:com:99999"] }), "4");
  assert.deepEqual(offenders, ["fixture unit fr:com:99999 absent"]);
});

test("gate 5 names a dangling flag and an undeclared file", () => {
  const files = build();
  files.delete("u/fr_dep_18.json");
  const city: Record<string, unknown> = { ...k(files, "k/fr_com_75056.json"), kind: "u" };
  delete city.units;
  files.set("u/fr_com_75056.json", city);
  const offenders = failed(run(files), "5");
  assert.ok(offenders.includes("row fr:dep:18: u=1 but u/fr_dep_18.json is missing"));
  assert.ok(offenders.includes("u/fr_com_75056.json: declared by no row or entry"));
});

test("gate 6 names an invalid ring", () => {
  const files = build();
  const arr = k(files, "k/fr_com_75056.json").units[1];
  (arr.g.coordinates[0] as number[][]).pop();
  const offenders = failed(run(files), "6");
  assert.ok(offenders.includes("k/fr_com_75056.json fr:com:75102: polygon 0 ring 0: not closed"));
});

test("a country over 20,000 vertices at 3000 m fails the pack, named", () => {
  const ring = Array.from({ length: 20_001 }, (_, i): [number, number] => [10 + i / 1e5, i % 2]);
  ring.push(ring[0]);
  const heavy = country("XX", { type: "Polygon", coordinates: [ring] });
  const fr = { tolM: 1000, self: cell(0, 0, 3, 1), regions: [] };
  const none = {
    regions: [],
    regionSelves: new Map(),
    deps: [],
    communes: [],
    arrondissements: [],
  };
  assert.throws(
    () => pack({ build: "o20261102-1", fr, ...none, families: new Map(), countries: [heavy] }),
    /countries over 20000 vertices at 3000 m: XX \(20002 at 3000 m\)/,
  );
});

test("gate 2 names a c3000 country whose u/ differs from its g/", () => {
  const files = build();
  const ring = (files.get("g/UM.json") as OutlineFileV1).self.g.coordinates[0][0] as number[][];
  ring.splice(0, ring.length, ...ring.slice(1), ring[1]); // the same ring from its next vertex
  assert.ok(
    failed(run(files), "2").includes("UM: u/UM.json at c3000 differs from its g/ at w3000"),
  );
});

test("gate 4 names a country of the world input with no row", () => {
  const offenders = failed(run(build(), { countryIds: ["MC", "ZZ"] }), "4");
  assert.deepEqual(offenders, ["country ZZ absent"]);
});

test("gate 5 names a missing g/ file and a wrap flag its file lacks", () => {
  const files = build();
  files.delete("g/MC.json");
  delete (files.get("u/UM.json") as OutlineFileV1).wrap;
  const offenders = failed(run(files), "5");
  assert.ok(offenders.includes("row MC: g=1 but g/MC.json is missing"));
  assert.ok(offenders.includes("row UM: wrap 1 but u/ has 0"));
});

test("gate 6 names a longitude past 180 without wrap", () => {
  const files = build();
  for (const p of ["u/UM.json", "g/UM.json"]) delete (files.get(p) as OutlineFileV1).wrap;
  delete (files.get("root.json") as RootV1).units.find((r) => r.id === "UM")!.wrap;
  assert.ok(failed(run(files), "6").includes("u/UM.json UM: polygon 1 ring 0: longitude 182.5"));
});
