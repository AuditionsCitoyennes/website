// The format contract on a toy France (CI never runs mapshaper): two régions,
// three départements, five communes, one city with two arrondissements,
// already "simplified", through the pure pack and check; then one broken copy
// per gate, each failing with its offender named.
import assert from "node:assert/strict";
import { test } from "node:test";
import { check, type CheckResult } from "./check";
import { validateFileV1, type Geometry, type Level, type OutlineFileV1, type RootV1 } from "./lib";
import { pack, type PackUnit } from "./pack";

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
const expected = {
  regionNames: regions.map((r) => r.name),
  depCodes: ["75", "77", "18"],
  fixtureIds: [...communes, ...arrondissements].map((c) => c.id),
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
    "k/FR.json",
    "k/fr_com_75056.json",
    ...["fr_dep_18", "fr_dep_75", "fr_dep_77", "fr_reg_11", "fr_reg_24"].map((x) => `k/${x}.json`),
    "root.json",
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
  const tiers = "{e50:{tolM:0,source:etalab-50m},fr1000:{tolM:1000,source:etalab-50m}}";
  assert.equal(json(root.tiers), tiers);
  const fr = "{id:FR,parent:null,level:country,name:France,bbox:[0,0,3,1],center:[0.5,1.5]";
  assert.equal(json(root.units[0]), `${fr},st:fr1000,k:1,u:0,g:0}`);
  assert.equal(root.units.length, 6);
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
