import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fakeEnv } from "../../testing/fakes";
import type { BanFeature, BanSearch } from "../geo/match";
import type { FrChain } from "./fr";
import type { PlaceDeps, Placement, StoredPlace } from "./placeLieu";

// placeLieu, every branch, with the outside world stubbed: BAN answers as in
// match.test.ts, the commune API by a table, the database by a function.

const cacheDir = await mkdtemp(join(tmpdir(), "ac-place-lieu-"));
fakeEnv(cacheDir);
after(() => rm(cacheDir, { recursive: true, force: true }));

const { getKnownCoordinates } = await import("@ac/shared");
const { locate } = await import("../geo/match");
const { frChainOfCommune } = await import("./fr");
const { placeLieu, rulesHash, RetryLater, settleCandidates, distanceKm } =
  await import("./placeLieu");
const { PlaceError } = await import("./fr");

function commune(
  name: string,
  citycode: string,
  context: string,
  population: number,
  coords: [number, number] = [45, 5],
): BanFeature {
  return {
    coords,
    score: 0.93,
    type: "municipality",
    name,
    city: name,
    citycode,
    postcode: null,
    context,
    population,
  };
}

const RHONE = "69, Rhône, Auvergne-Rhône-Alpes";
const HAUTES_ALPES = "05, Hautes-Alpes, Provence-Alpes-Côte d'Azur";
const MUNICIPALITIES: Record<string, BanFeature[]> = {
  "Saint-Denis": [
    commune("Saint-Denis", "97411", "974, La Réunion", 155634),
    commune("Saint-Denis", "93066", "93, Seine-Saint-Denis, Île-de-France", 149077),
    commune("Saint-Denis", "11339", "11, Aude, Occitanie", 523),
  ],
  Serres: [
    commune("Serres", "05166", HAUTES_ALPES, 1298, [44.4224, 5.7142]),
    commune("Serres", "54502", "54, Meurthe-et-Moselle, Grand Est", 254),
    commune("Serres", "11377", "11, Aude, Occitanie", 89),
  ],
  Embrun: [commune("Embrun", "05046", HAUTES_ALPES, 6000, [44.5638, 6.4958])],
  Bron: [commune("Bron", "69029", RHONE, 41000, [45.7386, 4.9134])],
  Villeurbanne: [commune("Villeurbanne", "69266", RHONE, 150000, [45.7707, 4.8846])],
  Ribiers: [],
};
const ban: BanSearch = async (q, opts) => (opts?.municipality ? (MUNICIPALITIES[q] ?? []) : []);

/** A commune's chain, as frChain gives it, from the BAN fixture's names. */
function chainOf(code: string, name: string, dep: [string, string], reg: [string, string]) {
  return frChainOfCommune({
    nom: name,
    code,
    departement: { code: dep[0], nom: dep[1] },
    region: { code: reg[0], nom: reg[1] },
    centre: { type: "Point", coordinates: [5, 45] },
  });
}
const PACA: [string, string] = ["93", "Provence-Alpes-Côte d'Azur"];
const CHAINS: Record<string, FrChain | null> = {
  "05166": chainOf("05166", "Serres", ["05", "Hautes-Alpes"], PACA),
  "05046": chainOf("05046", "Embrun", ["05", "Hautes-Alpes"], PACA),
  "93066": chainOf("93066", "Saint-Denis", ["93", "Seine-Saint-Denis"], ["11", "Île-de-France"]),
  "69029": frChainOfCommune({
    nom: "Bron",
    code: "69029",
    departement: { code: "69", nom: "Rhône" },
    region: { code: "84", nom: "Auvergne-Rhône-Alpes" },
    centre: { type: "Point", coordinates: [4.9134, 45.7386] },
  }),
  "69266": frChainOfCommune({
    nom: "Villeurbanne",
    code: "69266",
    departement: { code: "69", nom: "Rhône" },
    region: { code: "84", nom: "Auvergne-Rhône-Alpes" },
    centre: { type: "Point", coordinates: [4.8846, 45.7707] },
  }),
};

interface Calls {
  locate: string[];
  commune: string[];
  reuse: string[];
  support: number;
}

function deps(over: Partial<PlaceDeps> = {}): { deps: Partial<PlaceDeps>; calls: Calls } {
  const calls: Calls = { locate: [], commune: [], reuse: [], support: 0 };
  return {
    calls,
    deps: {
      locate: async (key) => {
        calls.locate.push(key);
        return locate(key, ban);
      },
      commune: async (code) => {
        calls.commune.push(code);
        return CHAINS[code] ?? null;
      },
      departement: async (code) =>
        code === "05"
          ? {
              ...CHAINS["05166"]!,
              units: CHAINS["05166"]!.units.slice(0, 3),
              path: CHAINS["05166"]!.path.slice(0, 3),
              unit: "fr:dep:05",
              localityId: null,
              centre: null,
            }
          : null,
      region: async () => null,
      reuse: async (key) => {
        calls.reuse.push(key);
        return null;
      },
      support: async () => {
        calls.support++;
        return new Map();
      },
      ...over,
    },
  };
}

function placed(p: Placement | "retry"): Placement {
  assert.notEqual(p, "retry");
  return p as Placement;
}

test("a generic text is on no point, and asks nobody", async () => {
  const { deps: d, calls } = deps();
  const p = placed(await placeLieu("France", { deps: d }));
  assert.equal(p.columns.place_precision, "unplaced");
  assert.equal(p.columns.place_path, null);
  assert.equal(p.columns.lieu_key, "France");
  assert.equal(p.columns.placed_location, "France");
  assert.equal(p.columns.placed_rules, rulesHash());
  assert.deepEqual(p.units, []);
  assert.deepEqual(calls, { locate: [], commune: [], reuse: [], support: 0 });
});

test("a commune by its name: its chain, BAN's point, precision commune", async () => {
  const { deps: d, calls } = deps();
  const p = placed(await placeLieu("Embrun", { deps: d }));
  assert.deepEqual(p.columns.place_path, ["FR", "fr:reg:93", "fr:dep:05", "fr:com:05046"]);
  assert.equal(p.columns.place_unit, "fr:com:05046");
  assert.equal(p.columns.locality_id, "fr:com:05046");
  assert.deepEqual([p.columns.lat, p.columns.lng], [44.5638, 6.4958]);
  assert.equal(p.columns.place_precision, "commune");
  assert.equal(p.columns.place_candidates, null);
  assert.equal(p.columns.geo_release, "geoapi-2026");
  assert.equal(p.units.length, 4);
  assert.deepEqual(calls.reuse, ["Embrun"]);
});

test("same-named communes: Serres settled by population, its candidates kept", async () => {
  const { deps: d } = deps();
  const p = placed(await placeLieu("Serres", { deps: d }));
  assert.equal(p.columns.place_unit, "fr:com:05166");
  assert.equal(p.columns.place_precision, "commune");
  const candidates = p.columns.place_candidates as unknown as { citycode: string }[];
  assert.deepEqual(
    candidates.map((c) => c.citycode),
    ["05166", "54502", "11377"],
  );
});

test("same-named communes: Saint-Denis unsettled stays unplaced with its candidates, settled by support", async () => {
  const { deps: d } = deps();
  const p = placed(await placeLieu("Saint-Denis", { deps: d }));
  assert.equal(p.columns.place_precision, "unplaced");
  assert.equal(p.columns.place_path, null);
  const candidates = p.columns.place_candidates as unknown as {
    name: string;
    departementCode: string;
    population: number;
  }[];
  assert.deepEqual(
    candidates.map((c) => [c.name, c.departementCode, c.population]),
    [
      ["Saint-Denis", "974", 155634],
      ["Saint-Denis", "93", 149077],
      ["Saint-Denis", "11", 523],
    ],
  );

  // Three lieux in Seine-Saint-Denis: that one, at placement…
  const { deps: d93 } = deps({ support: async () => new Map([["93", 3]]) });
  const settled = placed(await placeLieu("Saint-Denis", { deps: d93 }));
  assert.equal(settled.columns.place_unit, "fr:com:93066");
  assert.ok(settled.columns.place_candidates, "settled, its candidates are kept");

  // …or later, from the stored candidates, without BAN.
  const { deps: later, calls } = deps({
    support: async () =>
      new Map([
        ["93", 4],
        ["974", 1],
      ]),
  });
  const retried = await settleCandidates("Saint-Denis", "Saint-Denis", candidates as never, later);
  assert.ok(retried && retried !== "retry");
  assert.equal(retried.columns.place_unit, "fr:com:93066");
  assert.deepEqual(calls.locate, []);
  const { deps: still } = deps({ support: async () => new Map([["93", 2]]) });
  assert.equal(
    await settleCandidates("Saint-Denis", "Saint-Denis", candidates as never, still),
    null,
  );
});

test("no place by that name (Ribiers, a commune déléguée): unplaced, no candidates", async () => {
  const { deps: d } = deps();
  const p = placed(await placeLieu("Ribiers", { deps: d }));
  assert.equal(p.columns.place_precision, "unplaced");
  assert.equal(p.columns.place_candidates, null);
});

test("a département name is placed at the département", async () => {
  const { deps: d } = deps();
  const p = placed(await placeLieu("Hautes-Alpes", { deps: d }));
  assert.deepEqual(p.columns.place_path, ["FR", "fr:reg:93", "fr:dep:05"]);
  assert.equal(p.columns.locality_id, null);
  assert.equal(p.columns.place_precision, "departement");
});

test("a curated lieu keeps its curated point, precision address", async () => {
  const { deps: d } = deps();
  const p = placed(await placeLieu("parvis de la médiathèque, bron", { deps: d }));
  assert.equal(p.columns.lieu_key, "Parvis Médiathèque, Bron");
  assert.equal(p.columns.placed_location, "parvis de la médiathèque, bron");
  assert.deepEqual([p.columns.lat, p.columns.lng], getKnownCoordinates("Parvis Médiathèque, Bron"));
  assert.equal(p.columns.place_unit, "fr:com:69029");
  assert.equal(p.columns.place_precision, "address");
});

test("text alone reuses a lieu placed under the same name, its candidates too", async () => {
  const stored: StoredPlace = {
    place_unit: "fr:com:05166",
    place_path: ["FR", "fr:reg:93", "fr:dep:05", "fr:com:05166"],
    locality_id: "fr:com:05166",
    lat: 44.4,
    lng: 5.7,
    place_precision: "commune",
    place_candidates: [{ name: "Serres", departementCode: "05" }],
    geo_release: "geoapi-2026",
  };
  const { deps: d, calls } = deps({ reuse: async () => stored });
  const p = placed(await placeLieu("serres", { deps: d }));
  assert.deepEqual(p.units, []);
  assert.equal(p.columns.lieu_key, "Serres");
  assert.equal(p.columns.placed_location, "serres");
  assert.deepEqual(p.columns.place_candidates, stored.place_candidates);
  assert.deepEqual(p.columns.place_path, stored.place_path);
  assert.deepEqual([p.columns.lat, p.columns.lng], [44.4, 5.7]);
  assert.deepEqual(calls.locate, [], "no geocoder call");
});

test("an explicit BAN pick places the audition there, never reusing another's", async () => {
  const { deps: d, calls } = deps({
    reuse: async () => assert.fail("a pick never reuses"),
  });
  const pick = { kind: "ban", citycode: "69266", lat: 45.77, lng: 4.88, type: "street" } as const;
  const p = placed(await placeLieu("Rue Francis De Pressensé, Villeurbanne", { deps: d, pick }));
  assert.equal(p.columns.place_unit, "fr:com:69266");
  assert.deepEqual([p.columns.lat, p.columns.lng], [45.77, 4.88]);
  assert.equal(p.columns.place_precision, "address");
  assert.equal(p.columns.lieu_key, "Rue Francis De Pressensé, Villeurbanne");
  assert.deepEqual(calls.locate, []);

  // A lieu-dit picked: precision address.
  const lieuDit = placed(
    await placeLieu("Villeurbanne", { deps: d, pick: { ...pick, type: "locality" } }),
  );
  assert.equal(lieuDit.columns.place_precision, "address");

  // A curated lieu picked: its rule places it, at its curated point.
  const curated = placed(
    await placeLieu("Marché des Gratte-Ciel, Villeurbanne", { deps: d, pick }),
  );
  assert.equal(curated.columns.lieu_key, "Marché des Gratte-Ciel, Villeurbanne");
  assert.deepEqual(
    [curated.columns.lat, curated.columns.lng],
    getKnownCoordinates("Marché des Gratte-Ciel, Villeurbanne"),
  );
  assert.equal(curated.columns.place_unit, "fr:com:69266");
  assert.equal(curated.columns.place_precision, "address");
  // A rule claiming a picked street's text ("hébron" holds "bron") does not
  // pin Bron's médiathèque under the picked commune: the text places it,
  // under the rule's commune.
  const hebron = placed(await placeLieu("Rue D'hébron, Villeurbanne", { deps: d, pick }));
  assert.equal(hebron.columns.lieu_key, "Parvis Médiathèque, Bron");
  assert.equal(hebron.columns.place_unit, "fr:com:69029");
});

test("a pick 30 km off its commune, or of an unknown code, is the text's to place", async () => {
  // 69266's centre is in Villeurbanne; this point is in Grenoble (~95 km).
  assert.ok(distanceKm([45.188, 5.724], [45.7707, 4.8846]) > 30);
  const { deps: d, calls } = deps({ reuse: async () => assert.fail("no reuse after a pick") });
  const far = { kind: "ban", citycode: "69266", lat: 45.188, lng: 5.724, type: "street" } as const;
  const p = placed(await placeLieu("Embrun", { deps: d, pick: far }));
  assert.equal(p.columns.place_unit, "fr:com:05046", "placed from the text");
  assert.deepEqual([p.columns.lat, p.columns.lng], [44.5638, 6.4958]);
  assert.deepEqual(calls.locate, ["Embrun"]);

  const unknown = { ...far, citycode: "99999", lat: 44.56, lng: 6.49 };
  const q = placed(await placeLieu("Embrun", { deps: d, pick: unknown }));
  assert.equal(q.columns.place_unit, "fr:com:05046");
});

test("a commune the commune API does not know: filed under its département, with BAN's names", async () => {
  const { deps: d } = deps({
    commune: async () => null,
    departement: async () => ({
      units: CHAINS["05166"]!.units.slice(0, 3),
      path: ["FR", "fr:reg:93", "fr:dep:05"],
      unit: "fr:dep:05",
      localityId: null,
      centre: null,
    }),
  });
  const p = placed(await placeLieu("Embrun", { deps: d }));
  assert.deepEqual(p.columns.place_path, ["FR", "fr:reg:93", "fr:dep:05", "fr:com:05046"]);
  assert.equal(p.units[3].name, "Embrun");
  assert.equal(p.columns.place_precision, "commune");
});

test("an upstream that does not answer: 'retry'", async () => {
  const geocoderDown = deps({ locate: async () => "retry" });
  assert.equal(await placeLieu("Embrun", { deps: geocoderDown.deps }), "retry");
  const communesDown = deps({
    commune: async () => {
      throw new PlaceError("down", 503);
    },
  });
  assert.equal(await placeLieu("Embrun", { deps: communesDown.deps }), "retry");
  const dbDown = deps({
    reuse: async () => {
      throw new RetryLater("db");
    },
  });
  assert.equal(await placeLieu("Embrun", { deps: dbDown.deps }), "retry");
  const supportDown = deps({
    support: async () => {
      throw new RetryLater("db");
    },
  });
  assert.equal(await placeLieu("Saint-Denis", { deps: supportDown.deps }), "retry");
  // Anything else is a bug, not a wait.
  const broken = deps({
    reuse: async () => {
      throw new TypeError("bug");
    },
  });
  await assert.rejects(placeLieu("Embrun", { deps: broken.deps }), TypeError);
});

test("the default geocoder dependency tells a failed lookup from no place", async () => {
  const { defaultPlaceDeps } = await import("./placeLieu");
  const geocode = await import("../geo/geocode");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
  try {
    assert.equal(await defaultPlaceDeps.locate("Briançon"), "retry");
    assert.equal(geocode.getCachedEntry("Briançon"), undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("rulesHash: 8 hex of LOCATION_RULES, and moves with them", () => {
  assert.match(rulesHash(), /^[0-9a-f]{8}$/);
  assert.notEqual(rulesHash([]), rulesHash());
});
