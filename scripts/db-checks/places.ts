// Audition places as the writers leave them, in one rolled-back transaction.
//
// The old app writes auditions straight through PostgREST as `authenticated`
// (an admin's JWT) and sends the location only (OLD pages/Admin.tsx): its
// insert is born stale; once the API has placed the row, an unchanged resend
// leaves it placed and fresh, a new location makes it stale again (the
// generated place_stale), its placement kept for the API to redo.
//
// The API files online testimonies with submit_online_testimony as
// `service_role`, in named notation as PostgREST does: the eleven-argument
// call of builds before the place arguments still resolves and files a stale
// bucket; the full call places a new bucket, places that stale one under its
// own label, and leaves a placed one as it is.

import { createHash, randomUUID } from "node:crypto";
import { lit, sqlJson } from "./psql";
import { asAuthenticated } from "./writes";

export interface Unit {
  id: string;
  parent: string | null;
  level: string;
  country: string;
  name: string;
  code: string | null;
  source: "insee" | "overture";
}

/** Units of the fixtures: Lyon and its 7th arrondissement, and a German city. */
export const UNITS: Unit[] = [
  {
    id: "FR",
    parent: null,
    level: "country",
    country: "FR",
    name: "France",
    code: null,
    source: "insee",
  },
  {
    id: "fr:reg:84",
    parent: "FR",
    level: "region",
    country: "FR",
    name: "Auvergne-Rhône-Alpes",
    code: "84",
    source: "insee",
  },
  {
    id: "fr:dep:69",
    parent: "fr:reg:84",
    level: "county",
    country: "FR",
    name: "Rhône",
    code: "69",
    source: "insee",
  },
  {
    id: "fr:com:69123",
    parent: "fr:dep:69",
    level: "locality",
    country: "FR",
    name: "Lyon",
    code: "69123",
    source: "insee",
  },
  {
    id: "fr:com:69387",
    parent: "fr:com:69123",
    level: "locality",
    country: "FR",
    name: "Lyon 7e",
    code: "69387",
    source: "insee",
  },
  {
    id: "DE",
    parent: null,
    level: "country",
    country: "DE",
    name: "Allemagne",
    code: null,
    source: "overture",
  },
  {
    id: "db-check-de-region",
    parent: "DE",
    level: "region",
    country: "DE",
    name: "Berlin",
    code: "DE-BE",
    source: "overture",
  },
  {
    id: "db-check-de-locality",
    parent: "db-check-de-region",
    level: "locality",
    country: "DE",
    name: "Berlin",
    code: null,
    source: "overture",
  },
];

/** The insert of units, root first; those the database holds already are kept. */
export function insertUnits(units: Unit[]): string {
  const rows = units.map(
    (u) =>
      `(${lit(u.id)}, ${u.parent ? lit(u.parent) : "null"}, ${lit(u.level)}, ${lit(u.country)}, ` +
      `${lit(u.name)}, ${u.code ? lit(u.code) : "null"}, ${lit(u.source)}, 'db-check')`,
  );
  return `insert into public.geo_units (id, parent_id, level, country, name, code, source, geo_release) values
  ${rows.join(",\n  ")}
on conflict (id) do nothing;`;
}

/** A unit's chain, root first, as place_path holds it. */
export function pathOf(id: string, units: Unit[] = UNITS): string[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const path: string[] = [];
  for (let u = byId.get(id); u; u = u.parent ? byId.get(u.parent) : undefined) path.unshift(u.id);
  return path;
}

/** A text[] literal. */
export const textArray = (xs: string[]) => `array[${xs.map(lit).join(", ")}]::text[]`;

/** The lieu id the database derives (auditions.lieu_id). */
export function lieuId(unit: string, key: string): string {
  return `l:${createHash("md5").update(`${unit}\x1f${key}`).digest("hex").slice(0, 16)}`;
}

export interface PlaceRow {
  location: string;
  place_unit: string | null;
  place_path: string[] | null;
  locality_id: string | null;
  lieu_key: string | null;
  lat: number | null;
  lng: number | null;
  place_precision: string | null;
  place_candidates: unknown;
  placed_location: string | null;
  placed_rules: string | null;
  geo_release: string | null;
  place_stale: boolean;
  lieu_id: string | null;
}

const PLACE_COLUMNS =
  "location, place_unit, place_path, locality_id, lieu_key, lat, lng, place_precision, " +
  "place_candidates, placed_location, placed_rules, geo_release, place_stale, lieu_id";

/** A select printing one audition's place columns (null when there is none). */
const placeOf = (where: string) =>
  `select coalesce((select pg_catalog.to_jsonb(x) from (select ${PLACE_COLUMNS} from public.auditions where ${where}) x), 'null'::jsonb);`;

/** What a row should hold; the rest of PlaceRow is compared as given. */
type Want = Partial<PlaceRow>;

function compare(label: string, row: PlaceRow | null, want: Want): string[] {
  if (!row) return [`${label}: no row`];
  const out: string[] = [];
  for (const [k, v] of Object.entries(want)) {
    const have = row[k as keyof PlaceRow];
    if (JSON.stringify(have) !== JSON.stringify(v)) {
      out.push(`${label}: ${k} is ${JSON.stringify(have)}, expected ${JSON.stringify(v)}`);
    }
  }
  return out;
}

const UNPLACED: Want = {
  place_unit: null,
  place_path: null,
  locality_id: null,
  lieu_key: null,
  lat: null,
  lng: null,
  place_precision: null,
  place_candidates: null,
  placed_location: null,
  placed_rules: null,
  geo_release: null,
  lieu_id: null,
};

const LYON_7E = "fr:com:69387";
const POINT = { lat: 45.7456, lng: 4.8421 };

interface Submission {
  email: string;
  citycode: string;
  location: string;
  /** The seven place arguments, or none (the eleven-argument call). */
  unit?: string;
}

function submit(s: Submission): string {
  const args = [
    `p_email_hash => ${lit(s.email)}`,
    `p_person_name => 'Inès'`,
    `p_person_info => null`,
    `p_content => 'Un témoignage en ligne'`,
    `p_citycode => ${lit(s.citycode)}`,
    `p_location => ${lit(s.location)}`,
    `p_place => ${lit(JSON.stringify({ insee: s.citycode }))}::jsonb`,
    `p_month => pg_catalog.date_trunc('month', current_date)::date`,
    `p_title => 'Audition en ligne de contrôle'`,
    `p_audition_content => 'Contrôle'`,
    `p_token => ${lit(randomUUID())}::uuid`,
  ];
  if (s.unit) {
    const path = pathOf(s.unit);
    args.push(
      `p_place_unit => ${lit(s.unit)}`,
      `p_place_path => ${textArray(path)}`,
      `p_locality_id => ${lit(path.find((id) => id.startsWith("fr:com:"))!)}`,
      `p_lat => ${POINT.lat}`,
      `p_lng => ${POINT.lng}`,
      `p_place_precision => 'address'`,
      `p_geo_release => 'geoapi-2026'`,
    );
  }
  return `select pg_catalog.to_jsonb(public.submit_online_testimony(${args.join(", ")}) ? 'testimony_id');`;
}

/** A bucket placed by the full call, under the label it holds. */
const placedBucket = (location: string, unit = LYON_7E): Want => ({
  location,
  place_unit: unit,
  place_path: pathOf(unit),
  locality_id: pathOf(unit).find((id) => id.startsWith("fr:com:"))!,
  lieu_key: location,
  ...POINT,
  place_precision: "address",
  place_candidates: null,
  placed_location: location,
  placed_rules: null,
  geo_release: "geoapi-2026",
  place_stale: false,
  lieu_id: lieuId(unit, location),
});

export function checkPlaceWrites(): string[] {
  const admin = randomUUID();
  const audition = randomUUID();
  // As the old app normalises them; the first is not ASCII, as md5 must hash UTF-8.
  const located = "Hôtel de Ville, Lyon";
  const moved = "Place Bellecour, Lyon";
  const path = pathOf(LYON_7E);
  const bucket = (citycode: string) => placeOf(`audition_en_ligne and citycode = ${lit(citycode)}`);
  const first = { citycode: "db-check-1", location: "Mairie de contrôle 1" };
  const second = { citycode: "db-check-2", location: "Mairie de contrôle 2" };

  const out = sqlJson<unknown>(`
begin;
-- The old app stamps created_by, which references auth.users.
insert into auth.users (id, aud, role, email)
values (${lit(admin)}, 'authenticated', 'authenticated', 'db-check@example.invalid');
insert into public.user_roles (user_id, role) values (${lit(admin)}, 'admin');
${insertUnits(UNITS)}
${asAuthenticated(admin)}
insert into public.auditions (id, title, date, location, content, status, created_by)
values (${lit(audition)}, 'db:check', current_date, ${lit(located)}, 'Audition de contrôle', 'published', ${lit(admin)});
reset role;
${placeOf(`id = ${lit(audition)}`)}
set local role service_role;
update public.auditions
   set place_unit = ${lit(LYON_7E)}, place_path = ${textArray(path)}, locality_id = 'fr:com:69123',
       lieu_key = location, lat = ${POINT.lat}, lng = ${POINT.lng}, place_precision = 'address',
       placed_location = location, placed_rules = '0123abcd', geo_release = 'geoapi-2026'
 where id = ${lit(audition)};
reset role;
${placeOf(`id = ${lit(audition)}`)}
${asAuthenticated(admin)}
update public.auditions
   set title = 'db:check, revue', date = current_date, location = ${lit(located)},
       content = 'Audition de contrôle, revue', status = 'published'
 where id = ${lit(audition)};
reset role;
${placeOf(`id = ${lit(audition)}`)}
${asAuthenticated(admin)}
update public.auditions
   set title = 'db:check, revue', date = current_date, location = ${lit(moved)},
       content = 'Audition de contrôle, revue', status = 'published'
 where id = ${lit(audition)};
reset role;
${placeOf(`id = ${lit(audition)}`)}
set local role service_role;
${submit({ email: "db-check-a", ...first })}
${submit({ email: "db-check-b", ...second, unit: LYON_7E })}
reset role;
${bucket(first.citycode)}
${bucket(second.citycode)}
set local role service_role;
${submit({ email: "db-check-c", citycode: first.citycode, location: "Mairie de contrôle 1, renommée", unit: LYON_7E })}
${submit({ email: "db-check-d", citycode: second.citycode, location: second.location, unit: "fr:com:69123" })}
reset role;
${bucket(first.citycode)}
${bucket(second.citycode)}
select pg_catalog.to_jsonb(count(*)) from public.testimonies t join public.auditions a on a.id = t.audition_id
 where a.audition_en_ligne and a.citycode in (${lit(first.citycode)}, ${lit(second.citycode)});
rollback;`);

  const [inserted, placed, resent, relocated, ...rest] = out as (PlaceRow | null)[];
  const [submitted1, submitted2, bucket1, bucket2, submitted3, submitted4, healed, kept, filed] =
    rest as [boolean, boolean, PlaceRow, PlaceRow, boolean, boolean, PlaceRow, PlaceRow, number];
  const errors: string[] = [];
  const kept7e: Want = {
    place_unit: LYON_7E,
    place_path: path,
    locality_id: "fr:com:69123",
    lieu_key: located,
    ...POINT,
    place_precision: "address",
    placed_location: located,
    placed_rules: "0123abcd",
    geo_release: "geoapi-2026",
    lieu_id: lieuId(LYON_7E, located),
  };
  errors.push(
    ...compare("old-app insert (location only)", inserted, {
      location: located,
      ...UNPLACED,
      place_stale: true,
    }),
    ...compare("placed by the API", placed, { ...kept7e, place_stale: false }),
    ...compare("old-app update resending the same location", resent, {
      ...kept7e,
      place_stale: false,
    }),
    ...compare("old-app update to a new location", relocated, {
      ...kept7e,
      location: moved,
      place_stale: true,
    }),
  );
  if (![submitted1, submitted2, submitted3, submitted4].every((s) => s === true)) {
    errors.push(
      `submit_online_testimony did not file every testimony: ${JSON.stringify([submitted1, submitted2, submitted3, submitted4])}`,
    );
  }
  errors.push(
    ...compare("eleven-argument submit_online_testimony", bucket1, {
      location: first.location,
      ...UNPLACED,
      place_stale: true,
    }),
    ...compare("full submit_online_testimony, new bucket", bucket2, placedBucket(second.location)),
    ...compare(
      "full submit_online_testimony into the stale bucket",
      healed,
      placedBucket(first.location),
    ),
    ...compare(
      "full submit_online_testimony into a placed bucket",
      kept,
      placedBucket(second.location),
    ),
  );
  if (filed !== 4) errors.push(`${filed} online testimonies filed of 4`);
  return errors;
}
