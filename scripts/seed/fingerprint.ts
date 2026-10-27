// The seed's place data as loaded: an md5, computed by Postgres, over every
// audition's location, status and place columns and every geo_units row. The
// seed records it in its fake_seed_loaded entry (generate.ts); db:check
// compares the rows with the fixtures only while the database still gives the
// same (scripts/db-checks/seed.ts), since any later write changes it: the
// placement job's, an admin's. Qualified names: the checks run with an empty
// search_path.

const AUDITION = [
  "id",
  "location",
  "status",
  "audition_en_ligne",
  "citycode",
  "place",
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
];
const UNIT = [
  "id",
  "parent_id",
  "level",
  "country",
  "name",
  "code",
  "lat",
  "lng",
  "polygon",
  "wikidata",
  "source",
  "geo_release",
];

const rows = (table: string, alias: string, columns: string[]) =>
  `coalesce((select pg_catalog.string_agg(row(${columns.map((c) => `${alias}.${c}`).join(", ")})::text, ',' order by ${alias}.id) from public.${table} ${alias}), '')`;

/** A SQL expression (text). */
export const PLACES_FINGERPRINT = `pg_catalog.md5(${rows("auditions", "a", AUDITION)} || '|' || ${rows("geo_units", "g", UNIT)})`;
