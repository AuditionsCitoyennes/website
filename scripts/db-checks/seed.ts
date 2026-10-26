// The fake seed's places (scripts/seed/generate.ts), on a database it filled:
//
// - the counts of placed, unplaced and stale auditions, always reported;
// - while the database is as the seed left it (the fingerprint of its place
//   data, scripts/seed/fingerprint.ts, is the one the seed recorded in its
//   fake_seed_loaded entry; in CI, required): every French row holds exactly
//   its lieu's fixture place (scripts/seed/fixtures) under the current
//   LOCATION_RULES, the online buckets as submit_online_testimony places them;
//   the edge lieux are placed as the design says, each same-named commune
//   settled by what the design says settles it; the rows the old app wrote
//   are stale, and each can be placed by reuse from a placed row of its lieu
//   (so the placement job needs no upstream call for them); rows abroad are
//   unplaced, as after an attempt (so the job never looks them up); the
//   same-named communes settle as pickHomonym settles them against
//   placement_support() (so the job's retries leave them where they are);
//   geo_units holds the fixture's units the rows reference, and only those.
//
// A database used since the seed was loaded (the job ran, an admin wrote)
// gets its counts reported, and the rest skipped.

import { isDeepStrictEqual } from "node:util";
import { getCanonicalLocation, type PlaceCandidate } from "@ac/shared";
import { pickHomonym, type Homonyms } from "../../apps/api/src/modules/geo/match";
import { readFrFixtures, RULES_HASH, type FrPlace, type FrUnit } from "../seed/fixtures/fr";
import { PLACES_FINGERPRINT } from "../seed/fingerprint";
import { FRANCE_CLUSTERS } from "../seed/places";
import { lieuId } from "./places";
import { sqlJson } from "./psql";

interface Marker {
  profile?: string;
  shape?: string;
  auditions?: number;
  placed?: number;
  unplaced?: number;
  stale?: number;
  places?: string;
}

interface Row {
  id: string;
  location: string;
  online: boolean;
  citycode: string | null;
  place: { lat?: number; lng?: number } | null;
  place_unit: string | null;
  place_path: string[] | null;
  locality_id: string | null;
  lieu_key: string | null;
  lat: number | null;
  lng: number | null;
  place_precision: string | null;
  place_candidates: PlaceCandidate[] | null;
  placed_location: string | null;
  placed_rules: string | null;
  geo_release: string | null;
  place_stale: boolean;
  lieu_id: string | null;
}

const COLUMNS = [
  "place_unit",
  "place_path",
  "locality_id",
  "lieu_key",
  "lat",
  "lng",
  "place_precision",
  "place_candidates",
  "placed_location",
  "placed_rules",
  "geo_release",
] as const;
type Column = (typeof COLUMNS)[number];

/**
 * The design's edge lieux (map phase 1, F1): where each must be; for a
 * same-named commune, what settles it (population alone, or only the lieux
 * placed in its département: placement_support()).
 */
const EDGES: Record<
  string,
  {
    unit: string | null;
    precision: string;
    candidates: boolean;
    settledBy?: "population" | "support";
  }
> = {
  Ardèche: { unit: "fr:dep:07", precision: "departement", candidates: false },
  "Saint-Denis": { unit: null, precision: "unplaced", candidates: true },
  Serres: { unit: "fr:com:05166", precision: "commune", candidates: true, settledBy: "population" },
  Châteauvieux: {
    unit: "fr:com:05037",
    precision: "commune",
    candidates: true,
    settledBy: "support",
  },
  Ribiers: { unit: null, precision: "unplaced", candidates: false },
  France: { unit: null, precision: "unplaced", candidates: false },
};

/** How many French rows the seed writes as the old app does (places.ts `legacy`). */
const LEGACY = FRANCE_CLUSTERS.flatMap((c) => c.places).reduce((n, p) => n + (p.legacy ?? 0), 0);

const READ = `
select coalesce((select metadata from public.audit_log where action = 'fake_seed_loaded'
                  order by created_at desc, id desc limit 1), 'null'::jsonb);
select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'id', id, 'location', location, 'online', audition_en_ligne, 'citycode', citycode, 'place', place,
         'place_unit', place_unit, 'place_path', place_path, 'locality_id', locality_id, 'lieu_key', lieu_key,
         'lat', lat, 'lng', lng, 'place_precision', place_precision, 'place_candidates', place_candidates,
         'placed_location', placed_location, 'placed_rules', placed_rules, 'geo_release', geo_release,
         'place_stale', place_stale, 'lieu_id', lieu_id) order by id), '[]'::jsonb)
  from public.auditions;
select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'id', id, 'parent_id', parent_id, 'level', level, 'country', country, 'name', name,
         'code', code, 'lat', lat, 'lng', lng, 'source', source, 'geo_release', geo_release) order by id),
         '[]'::jsonb)
  from public.geo_units;
select public.placement_support();
select pg_catalog.to_jsonb(${PLACES_FINGERPRINT});`;

const homonymsOf = (candidates: PlaceCandidate[]): Homonyms => ({
  homonyms: candidates.map((c) => ({
    coords: [c.lat, c.lng],
    city: c.name || null,
    citycode: c.citycode,
    arrondissement: c.arrondissement,
    depCode: c.departementCode,
    depName: c.departementName,
    region: c.region,
    level: c.level,
    population: c.population,
  })),
});

/** Where pickHomonym puts same-named communes under this support: a unit id, or null. */
const settledAt = (candidates: PlaceCandidate[], support: Map<string, number>) => {
  const settled = pickHomonym(homonymsOf(candidates), support);
  return settled ? `fr:com:${settled.citycode}` : null;
};

export function checkSeed(): string[] {
  const [marker, rows, units, supportObject, fingerprint] = sqlJson<unknown>(READ) as [
    Marker | null,
    Row[],
    FrUnit[],
    Record<string, number>,
    string,
  ];
  if (!marker) {
    console.log("  no fake seed in this database: nothing to compare");
    return [];
  }
  if (marker.shape !== "places") {
    console.log(`  a seed without places (profile ${marker.profile}): nothing to compare`);
    return [];
  }

  const fixtures = readFrFixtures();
  const { places } = fixtures;
  const french = (r: Row) => !r.online && r.location in places.lieux;
  const placed = rows.filter((r) => !r.place_stale && r.place_path !== null);
  const unplaced = rows.filter((r) => !r.place_stale && r.place_path === null);
  const stale = rows.filter((r) => r.place_stale);
  console.log(
    `  profile ${marker.profile}: ${rows.length} auditions, ${placed.length} placed ` +
      `(${placed.filter((r) => r.online).length} online), ${unplaced.length} unplaced ` +
      `(${unplaced.filter((r) => !r.online && !french(r)).length} abroad), ` +
      `${stale.length} stale (${stale.filter(french).length} in France, ` +
      `${stale.filter((r) => r.online).length} online, ${stale.filter((r) => !r.online && !french(r)).length} abroad)`,
  );

  if (marker.places !== fingerprint) {
    if (process.env.CI === "true") {
      return ["the database's place data is not what the seed loaded (fingerprint differs)"];
    }
    console.log("  the place data changed since the seed was loaded: the rest is skipped");
    return [];
  }

  const errors: string[] = [];
  const counts = {
    auditions: rows.length,
    placed: placed.length,
    unplaced: unplaced.length,
    stale: stale.length,
  };
  const recorded = {
    auditions: marker.auditions,
    placed: marker.placed,
    unplaced: marker.unplaced,
    stale: marker.stale,
  };
  if (!isDeepStrictEqual(counts, recorded)) {
    errors.push(`counts ${JSON.stringify(counts)}, the seed recorded ${JSON.stringify(recorded)}`);
  }

  const differ = (label: string, row: Row, want: Partial<Record<Column, unknown>>) => {
    for (const [k, v] of Object.entries(want)) {
      const have = row[k as Column];
      if (!isDeepStrictEqual(have, v)) {
        errors.push(`${label}: ${k} is ${JSON.stringify(have)}, expected ${JSON.stringify(v)}`);
      }
    }
  };
  const never = Object.fromEntries(COLUMNS.map((c) => [c, null]));
  const stored = (p: FrPlace, location: string) => ({
    place_unit: p.place_unit,
    place_path: p.place_path,
    locality_id: p.locality_id,
    lieu_key: p.lieu_key,
    lat: p.lat,
    lng: p.lng,
    place_precision: p.place_precision,
    place_candidates: p.place_candidates,
    placed_location: location,
    placed_rules: RULES_HASH,
    geo_release: p.geo_release,
  });

  for (const row of rows) {
    const label = `"${row.location}" (${row.id})`;
    if (row.online) {
      const p = row.citycode ? places.online[row.citycode] : undefined;
      if (!p) {
        errors.push(`${label}: an online bucket of no fixture town hall`);
        continue;
      }
      differ(label, row, {
        place_unit: p.place_unit,
        place_path: p.place_path,
        locality_id: p.locality_id,
        lieu_key: row.location,
        lat: p.place.lat,
        lng: p.place.lng,
        place_precision: p.place_precision,
        place_candidates: null,
        placed_location: row.location,
        placed_rules: null,
        geo_release: p.geo_release,
      });
      if (!isDeepStrictEqual(row.place, p.place)) {
        errors.push(`${label}: place ${JSON.stringify(row.place)}, expected the town hall's`);
      }
      if (row.location !== p.location)
        errors.push(`${label}: not its town hall's label "${p.location}"`);
      continue;
    }
    const p = places.lieux[row.location];
    if (row.place_stale) {
      // Written as the old app writes: never placed.
      if (!p) errors.push(`${label}: stale abroad, where the seed leaves rows unplaced`);
      differ(label, row, never);
      continue;
    }
    if (!p) {
      // Abroad: unplaced, as after an attempt.
      differ(label, row, {
        ...never,
        lieu_key: getCanonicalLocation(row.location),
        place_precision: "unplaced",
        placed_location: row.location,
        placed_rules: RULES_HASH,
      });
      continue;
    }
    differ(label, row, stored(p, row.location));
    if (row.place_unit && row.lieu_id !== lieuId(row.place_unit, row.lieu_key!)) {
      errors.push(
        `${label}: lieu_id ${row.lieu_id}, expected ${lieuId(row.place_unit, row.lieu_key!)}`,
      );
    }
  }

  // The rows the old app wrote: as many as places.ts says, each with a
  // placed, up-to-date row of its lieu to be placed from.
  const legacy = stale.filter(french);
  const hasFrance = marker.profile === "france" || marker.profile === "all";
  if (legacy.length !== (hasFrance ? LEGACY : 0)) {
    errors.push(`${legacy.length} French rows stale, expected ${hasFrance ? LEGACY : 0}`);
  }
  for (const row of legacy) {
    const key = places.lieux[row.location].lieu_key;
    const from = placed.find(
      (r) => !r.online && r.lieu_key === key && r.placed_rules === RULES_HASH,
    );
    if (!from)
      errors.push(`"${row.location}" (${row.id}): stale, and no placed row of its lieu to reuse`);
  }

  const support = new Map(Object.entries(supportObject));
  if (hasFrance) {
    for (const [location, want] of Object.entries(EDGES)) {
      const edge = rows.filter((r) => !r.online && r.location === location);
      if (edge.length === 0) errors.push(`edge lieu "${location}": no audition`);
      for (const row of edge) {
        const { settledBy, ...where } = want;
        const have = {
          unit: row.place_unit,
          precision: row.place_precision,
          candidates: (row.place_candidates?.length ?? 0) > 0,
        };
        if (!isDeepStrictEqual(have, where)) {
          errors.push(
            `edge lieu "${location}": ${JSON.stringify(have)}, expected ${JSON.stringify(where)}`,
          );
        }
        if (!settledBy || !row.place_candidates) continue;
        // Population alone settles it, or nothing does without the support
        // (which the check below holds it to).
        const alone = settledAt(row.place_candidates, new Map());
        const wantAlone = settledBy === "population" ? want.unit : null;
        if (alone !== wantAlone) {
          errors.push(
            `edge lieu "${location}": without support at ${alone}, expected ${wantAlone} (settled by ${settledBy})`,
          );
        }
      }
    }
  }

  // Same-named communes: settled as the job would settle them now.
  for (const row of placed.concat(unplaced)) {
    if (row.online || !row.place_candidates) continue;
    if (row.place_candidates.length < 2) {
      errors.push(`"${row.location}" (${row.id}): fewer than two same-named communes`);
      continue;
    }
    const want = settledAt(row.place_candidates, support);
    if (row.place_unit !== want) {
      errors.push(
        `"${row.location}" (${row.id}): at ${row.place_unit}, but placement_support() ${JSON.stringify(supportObject)} settles it at ${want}`,
      );
    }
  }

  // geo_units: the fixture's units the rows' paths name, as the fixture has
  // them, and those only.
  const named = new Set(rows.flatMap((r) => r.place_path ?? []));
  const held = new Map(units.map((u) => [u.id, u]));
  const fixture = new Map(fixtures.units.map((u) => [u.id, u]));
  for (const id of named)
    if (!held.has(id)) errors.push(`unit ${id}: named by a path, not in geo_units`);
  for (const [id, unit] of held) {
    if (!named.has(id)) errors.push(`unit ${id}: in geo_units, named by no path`);
    const want = fixture.get(id);
    if (!want) {
      errors.push(`unit ${id}: not in fr-units.json`);
      continue;
    }
    for (const k of Object.keys(want) as (keyof FrUnit)[]) {
      if (!isDeepStrictEqual(unit[k], want[k])) {
        errors.push(
          `unit ${id}: ${k} is ${JSON.stringify(unit[k])}, fr-units.json has ${JSON.stringify(want[k])}`,
        );
      }
    }
  }
  return errors;
}
