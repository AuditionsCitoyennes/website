// The format contract on a toy France (CI never runs mapshaper): two régions,
// three départements, five communes, one city with two arrondissements,
// already "simplified", through the pure pack.
import assert from "node:assert/strict";
import { test } from "node:test";
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
const k = (files: Map<string, unknown>, p: string) => files.get(p) as OutlineFileV1 & { kind: "k" };

test("the toy France packs into format v1", () => {
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
});
