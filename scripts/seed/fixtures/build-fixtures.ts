// Builds fr-units.json and fr-places.json: where the API puts every French
// seed lieu and online town hall, computed by the API's own code (placeLieu,
// frChain, resolveTownHall: apps/api/src/modules/places) against the live
// BAN and geo.api.gouv.fr, so that the seed and CI need no network. Run it
// again when the seed's places change, or LOCATION_RULES in a way that moves
// one of them (the seed says which: fr.ts placeOutdated):
//
//   npx tsx scripts/seed/fixtures/build-fixtures.ts
//
// No database: the reuse of a lieu already placed and the support that
// settles same-named communes (placement_support()) are computed over the
// seed's own lieux, as the placement job does over a pass. Every lieu
// counts, the few the seed writes as drafts too (none shares a département
// with a homonym's candidates; db:check compares with placement_support()).
// Calls are serial: BAN through the API's own throttle, geo.api one at a
// time. BAN's answers are kept in ~/.cache/ac-seed/fixtures (FIXTURES_CACHE_DIR,
// the geocoder's own cache file): delete it to ask BAN again.

import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import type { Placement, StoredPlace } from "../../../apps/api/src/modules/places/placeLieu";
import { FRANCE_CLUSTERS, ONLINE_TOWN_HALLS } from "../places";
import {
  FR_PLACES_FILE,
  FR_UNITS_FILE,
  RULES_HASH,
  type FrOnlinePlace,
  type FrPlace,
  type FrPlaces,
  type FrUnit,
} from "./fr";

// The API's config is read when the placement code first geocodes: give it a
// database that is not there, so that nothing (an .env included) can point it
// at a real one.
// No database call is made: reuse and support are passed in.
const cacheDir = process.env.FIXTURES_CACHE_DIR ?? join(homedir(), ".cache/ac-seed/fixtures");
mkdirSync(cacheDir, { recursive: true });
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: join(tmpdir(), "ac-seed-fixtures-no-env"),
  APP_ENV: "local",
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_ANON_KEY: "fixtures",
  SUPABASE_SERVICE_ROLE_KEY: "",
  CACHE_DIR: cacheDir,
});
delete process.env.BAN_BASE_URL;

const { placeLieu, rulesHash, settleCandidates } =
  await import("../../../apps/api/src/modules/places/placeLieu");
const { resolveTownHall } =
  await import("../../../apps/api/src/modules/online-testimonies/townHall");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asks again while an upstream does not answer: the geocoder backs a failed name off for 30 s. */
async function untilAnswered<T>(what: string, run: () => Promise<T | "retry">): Promise<T> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const v = await run();
    if (v !== "retry") return v;
    console.warn(`  ${what}: no answer upstream (attempt ${attempt}), again in 35 s`);
    await sleep(35_000);
  }
  throw new Error(`${what}: BAN or geo.api.gouv.fr did not answer`);
}

const units = new Map<string, FrUnit>();
function keepUnits(list: Placement["units"]) {
  for (const u of list) {
    const unit: FrUnit = {
      id: u.id,
      parent_id: u.parent_id ?? null,
      level: u.level as FrUnit["level"],
      country: u.country,
      name: u.name,
      code: u.code ?? null,
      lat: u.lat ?? null,
      lng: u.lng ?? null,
      source: "insee",
      geo_release: u.geo_release,
    };
    const had = units.get(u.id);
    if (!had) {
      units.set(u.id, unit);
      continue;
    }
    // A commune is written with its centre as a leaf, without it above an
    // arrondissement: the point is kept; anything else must agree.
    const same = (k: keyof FrUnit) => k === "lat" || k === "lng" || had[k] === unit[k];
    const differ = (Object.keys(unit) as (keyof FrUnit)[]).filter((k) => !same(k));
    if (differ.length) throw new Error(`unit ${u.id} differs between chains: ${differ.join(", ")}`);
    if (had.lat === null && unit.lat !== null) units.set(u.id, unit);
  }
}

const RULES = rulesHash();
if (RULES !== RULES_HASH)
  throw new Error(`fr.ts RULES_HASH ${RULES_HASH} is not the API's ${RULES}`);
const placements = new Map<string, Placement>();
/** Placed lieux by lieu key, as reuse finds them in the database. */
const placedByKey = new Map<string, StoredPlace>();

const locations = [...new Set(FRANCE_CLUSTERS.flatMap((c) => c.places.map((p) => p.location)))];
console.log(`${locations.length} French lieux, ${ONLINE_TOWN_HALLS.length} online town halls`);

// 1. Every lieu, same-named communes left for the end of the pass.
for (const location of locations) {
  const placement = await untilAnswered(location, () =>
    placeLieu(location, {
      settle: false,
      deps: {
        reuse: async (key) => placedByKey.get(key) ?? null,
        support: async () => {
          throw new Error("support is computed at the end of the pass");
        },
      },
    }),
  );
  placements.set(location, placement);
  const c = placement.columns;
  if (c.place_path && !placedByKey.has(c.lieu_key!)) {
    placedByKey.set(c.lieu_key!, {
      place_unit: c.place_unit ?? null,
      place_path: c.place_path,
      locality_id: c.locality_id ?? null,
      lat: c.lat ?? null,
      lng: c.lng ?? null,
      place_precision: c.place_precision ?? null,
      place_candidates: c.place_candidates ?? null,
      geo_release: c.geo_release ?? null,
    });
  }
  keepUnits(placement.units);
}

// 2. Same-named communes, settled against the lieux placed without any
// (placement_support(): distinct lieux per département).
const support = new Map<string, number>();
const lieuxByDep = new Map<string, Set<string>>();
for (const p of placements.values()) {
  const c = p.columns;
  if (!c.place_path || c.place_candidates) continue;
  for (const id of c.place_path) {
    if (!id.startsWith("fr:dep:")) continue;
    const dep = id.slice("fr:dep:".length);
    const set = lieuxByDep.get(dep) ?? new Set<string>();
    set.add(c.lieu_key!);
    lieuxByDep.set(dep, set);
  }
}
for (const [dep, set] of lieuxByDep) support.set(dep, set.size);
for (const [location, p] of placements) {
  if (!p.homonyms) continue;
  const key = p.columns.lieu_key!;
  const settled = await untilAnswered(location, () =>
    settleCandidates(location, key, p.homonyms!, { support: async () => support }),
  );
  if (settled) {
    placements.set(location, settled);
    keepUnits(settled.units);
  }
}

// 3. The online town halls, as the online form files them: label, `place`
// (the bucket's point) and units.
const online: Record<string, FrOnlinePlace> = {};
for (const hall of ONLINE_TOWN_HALLS) {
  const t = await resolveTownHall(hall.citycode);
  if (!t.chain) throw new Error(`${hall.citycode}: geo.api gives no département`);
  if (t.key !== hall.citycode || t.location !== hall.location) {
    throw new Error(
      `${hall.citycode}: the API files it as ${t.key} "${t.location}", the seed as "${hall.location}"`,
    );
  }
  const { departementCode, departementName, region } = t.place;
  if (!departementCode || !departementName || !region) {
    throw new Error(`${hall.citycode}: geo.api gives no département or région`);
  }
  keepUnits(t.chain.units);
  online[hall.citycode] = {
    location: t.location,
    place: { ...t.place, departementCode, departementName, region },
    place_unit: t.chain.unit,
    place_path: t.chain.path,
    locality_id: t.chain.localityId,
    place_precision: t.pointKind === "mairie" ? "address" : "commune",
    geo_release: t.chain.units[0].geo_release,
  };
  await sleep(200);
}

// Root first: a unit after its parent, then by id.
const depth = (u: FrUnit): number => (u.parent_id ? 1 + depth(units.get(u.parent_id)!) : 0);
const unitRows = [...units.values()].sort(
  (a, b) => depth(a) - depth(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
);
for (const u of unitRows) {
  if (u.parent_id && !units.has(u.parent_id))
    throw new Error(`${u.id}: parent ${u.parent_id} missing`);
}

const lieux: Record<string, FrPlace> = {};
for (const location of locations) {
  const c = placements.get(location)!.columns;
  if (c.placed_rules !== RULES)
    throw new Error(`${location}: placed under rules ${c.placed_rules}`);
  lieux[location] = {
    place_unit: c.place_unit ?? null,
    place_path: c.place_path ?? null,
    locality_id: c.locality_id ?? null,
    lieu_key: c.lieu_key!,
    lat: c.lat ?? null,
    lng: c.lng ?? null,
    place_precision: c.place_precision as FrPlace["place_precision"],
    place_candidates: (c.place_candidates ?? null) as FrPlace["place_candidates"],
    geo_release: c.geo_release ?? null,
  };
}
const places: FrPlaces = { rules: RULES, lieux, online };

async function writeJson(file: URL, value: unknown) {
  const path = fileURLToPath(file);
  const options = (await prettier.resolveConfig(path)) ?? {};
  await writeFile(
    path,
    await prettier.format(JSON.stringify(value), { ...options, filepath: path }),
  );
}
await writeJson(FR_UNITS_FILE, unitRows);
await writeJson(FR_PLACES_FILE, places);

const count = (pred: (p: FrPlace) => boolean) => Object.values(lieux).filter(pred).length;
console.log(
  `fr-units.json: ${unitRows.length} units; fr-places.json: ${locations.length} lieux ` +
    `(${count((p) => p.place_path !== null)} placed, ${count((p) => p.place_path === null)} unplaced, ` +
    `${count((p) => p.place_candidates !== null)} with same-named communes), ` +
    `${Object.keys(online).length} town halls; rules ${RULES}`,
);
for (const location of ["Ardèche", "Saint-Denis", "Serres", "Châteauvieux", "Ribiers", "France"]) {
  const p = lieux[location];
  if (!p) continue;
  const candidates = p.place_candidates?.map((c) => `${c.citycode} (${c.departementCode})`);
  console.log(
    `  ${location}: ${p.place_unit ?? "unplaced"} ${p.place_precision}` +
      (candidates ? `, candidates ${candidates.join(", ")}` : ""),
  );
}
