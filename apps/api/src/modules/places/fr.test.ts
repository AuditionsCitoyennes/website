import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { FakeGeoApi, fakeEnv, installFakes } from "../../testing/fakes";

// frChain and its kin against a fake geo.api.gouv.fr, answers trimmed from
// the real ones (2026-10-26).

const cacheDir = await mkdtemp(join(tmpdir(), "ac-fr-"));
fakeEnv(cacheDir);
const geo = new FakeGeoApi();
const restore = installFakes({ geo });
after(async () => {
  restore();
  await rm(cacheDir, { recursive: true, force: true });
});

const RHONE = { code: "69", nom: "Rhône" };
const ARA = { code: "84", nom: "Auvergne-Rhône-Alpes" };
geo.communes = {
  "05166": {
    nom: "Serres",
    code: "05166",
    departement: { code: "05", nom: "Hautes-Alpes" },
    region: { code: "93", nom: "Provence-Alpes-Côte d'Azur" },
    mairie: [44.4283, 5.7146],
    centre: [44.4224, 5.7142],
  },
  "69387": {
    nom: "Lyon 7e Arrondissement",
    code: "69387",
    type: "arrondissement-municipal",
    codeParent: "69123",
    departement: RHONE,
    region: ARA,
    mairie: [45.7463, 4.8416],
    centre: [45.7321, 4.8393],
  },
  "75103": {
    nom: "Paris 3e Arrondissement",
    code: "75103",
    type: "arrondissement-municipal",
    codeParent: "75056",
    departement: { code: "75", nom: "Paris" },
    region: { code: "11", nom: "Île-de-France" },
    mairie: [48.8637, 2.3615],
    centre: [48.8629, 2.3601],
  },
  "97411": {
    nom: "Saint-Denis",
    code: "97411",
    zone: "drom",
    departement: { code: "974", nom: "La Réunion" },
    region: { code: "04", nom: "La Réunion" },
    centre: [-20.9434, 55.4444],
  },
  "97701": {
    nom: "Saint-Barthélemy",
    code: "97701",
    zone: "com",
    departement: { code: "977", nom: "Saint-Barthélemy" },
    region: { code: "977", nom: "Saint-Barthélemy" },
    centre: [17.9204, -62.8601],
  },
};
geo.departements = {
  "07": { nom: "Ardèche", code: "07", region: ARA },
  "975": {
    nom: "Saint-Pierre-et-Miquelon",
    code: "975",
    region: { code: "975", nom: "Saint-Pierre-et-Miquelon" },
  },
};
geo.regions = [
  { nom: "Bretagne", code: "53" },
  { nom: "Auvergne-Rhône-Alpes", code: "84" },
];

const fr = await import("./fr");

test("a commune: France, its région, its département, itself", async () => {
  const chain = await fr.frChain("05166");
  assert.ok(chain);
  assert.deepEqual(chain.path, ["FR", "fr:reg:93", "fr:dep:05", "fr:com:05166"]);
  assert.equal(chain.unit, "fr:com:05166");
  assert.equal(chain.localityId, "fr:com:05166");
  assert.deepEqual(chain.centre, [44.4224, 5.7142]);
  assert.deepEqual(
    chain.units.map((u) => [u.id, u.parent_id, u.level, u.name, u.code]),
    [
      ["FR", null, "country", "France", null],
      ["fr:reg:93", "FR", "region", "Provence-Alpes-Côte d'Azur", "93"],
      ["fr:dep:05", "fr:reg:93", "county", "Hautes-Alpes", "05"],
      ["fr:com:05166", "fr:dep:05", "locality", "Serres", "05166"],
    ],
  );
  for (const u of chain.units) {
    assert.equal(u.country, "FR");
    assert.equal(u.source, "insee");
    assert.equal(u.geo_release, "geoapi-2026");
  }
});

test("an arrondissement sits under its commune, labelled as the map does (Lyon 7e)", async () => {
  const chain = await fr.frChain("69387");
  assert.ok(chain);
  assert.deepEqual(chain.path, ["FR", "fr:reg:84", "fr:dep:69", "fr:com:69123", "fr:com:69387"]);
  assert.equal(chain.localityId, "fr:com:69123");
  const [, , , commune, arr] = chain.units;
  assert.deepEqual([commune.name, commune.code, commune.parent_id], ["Lyon", "69123", "fr:dep:69"]);
  assert.deepEqual([arr.name, arr.code, arr.parent_id], ["Lyon 7e", "69387", "fr:com:69123"]);
  // The arrondissement's centre is its own; its commune's is not known here.
  assert.deepEqual([arr.lat, arr.lng], [45.7321, 4.8393]);
  assert.deepEqual([commune.lat, commune.lng], [null, null]);
});

test("Paris Centre's town hall (75103) sits under Paris", async () => {
  const chain = await fr.frChain("75103");
  assert.deepEqual(chain?.path, ["FR", "fr:reg:11", "fr:dep:75", "fr:com:75056", "fr:com:75103"]);
  assert.equal(chain?.units[4].name, "Paris 3e");
});

test("overseas France is under FR: a DROM's région over its département", async () => {
  const chain = await fr.frChain("97411");
  assert.deepEqual(chain?.path, ["FR", "fr:reg:04", "fr:dep:974", "fr:com:97411"]);
  assert.deepEqual(
    chain?.units.slice(1, 3).map((u) => u.name),
    ["La Réunion", "La Réunion"],
  );
});

test("a collectivité d'outre-mer is région and département under one code", async () => {
  const chain = await fr.frChain("97701");
  assert.deepEqual(chain?.path, ["FR", "fr:reg:977", "fr:dep:977", "fr:com:97701"]);
  // And when geo.api leaves its région out, the département stands for it.
  const c = fr.frChainOfCommune({
    nom: "Saint-Pierre",
    code: "97502",
    departement: { code: "975", nom: "Saint-Pierre-et-Miquelon" },
  });
  assert.deepEqual(c?.path, ["FR", "fr:reg:975", "fr:dep:975", "fr:com:97502"]);
});

test("département and région chains, for lieux placed at that level", async () => {
  const dep = await fr.frDepartementChain("07");
  assert.deepEqual(dep?.path, ["FR", "fr:reg:84", "fr:dep:07"]);
  assert.equal(dep?.localityId, null);
  assert.equal(dep?.units[2].name, "Ardèche");
  const com = await fr.frDepartementChain("975");
  assert.deepEqual(com?.path, ["FR", "fr:reg:975", "fr:dep:975"]);
  const reg = await fr.frRegionChain("Bretagne");
  assert.deepEqual(reg?.path, ["FR", "fr:reg:53"]);
  assert.deepEqual([reg?.units[1].level, reg?.units[1].name], ["region", "Bretagne"]);
  assert.equal(await fr.frRegionChain("Atlantide"), null);
});

test("an unknown code is null (and remembered); a commune API down is a 503 PlaceError", async () => {
  assert.equal(await fr.frChain("99999"), null);
  const before = geo.calls.length;
  assert.equal(await fr.frChain("99999"), null);
  assert.equal(geo.calls.length, before, "a 404 is kept an hour");

  // Answers are kept a month: a known code is not asked again.
  await fr.frChain("05166");
  const known = geo.calls.length;
  geo.failWith = 503;
  assert.ok(await fr.frChain("05166"));
  assert.equal(geo.calls.length, known);
  await assert.rejects(fr.frChain("38509"), (e: unknown) => {
    assert.ok(e instanceof fr.PlaceError);
    assert.equal(e.status, 503);
    return true;
  });
  // Tried twice.
  assert.equal(geo.calls.length, known + 2);
  geo.failWith = null;
});
