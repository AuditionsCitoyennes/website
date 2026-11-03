// The grant guard: what anon and authenticated (the public key, and any
// signed-in user through PostgREST) can read and run stays what it is today.
//
// - testimonies: SELECT on exactly the nine columns of allowlist.json (no email,
//   no verification token, none of the derived columns);
// - the functions of the project's schemas they can EXECUTE equal the
//   allowlist (has_function_privilege, which ignores schema USAGE);
// - nothing in schema ac is executable by them, nor is the schema usable;
// - every migration that creates functions in ac ends with the revoke and grant
//   that keep it so (a function gets EXECUTE for PUBLIC when created), and the
//   generated helpers, replaced as a later migration would replace them, keep
//   their grants (rolled back);
// - every SECURITY DEFINER function sets search_path, but the baseline's seven
//   listed under securityDefinerWithoutSearchPath;
// - the tables of serverOnlyTables (geo_units among them) are the ones anon
//   and authenticated hold no privilege on, and cannot read: RLS on, the
//   service role reads and writes them;
// - the functions of schema public only the service role may run (not PUBLIC,
//   anon or authenticated) are serviceRoleOnly: placement_support and
//   submit_online_testimony among them.

import { readdirSync, readFileSync } from "node:fs";
import { derivedSql } from "../sql-gen/derived";
import { runSql, sqlJson } from "./psql";

export interface Allowlist {
  schemas: string[];
  testimoniesSelect: string[];
  executable: Record<"anon" | "authenticated", string[]>;
  securityDefinerWithoutSearchPath: string[];
  serverOnlyTables: string[];
  serviceRoleOnly: string[];
}

const ROLES = ["anon", "authenticated"] as const;

export function readAllowlist(): Allowlist {
  return JSON.parse(readFileSync(new URL("./allowlist.json", import.meta.url), "utf8"));
}

/** The functions of the schemas, as (oid, "schema.name(args)", security definer, config). */
const functions = (inSchemas: string) => `
  (select p.oid, n.nspname || '.' || p.proname || '('
                 || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as sig,
          p.prosecdef, p.proconfig
     from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where ${inSchemas})`;

interface Observed {
  testimoniesSelect: Record<string, string[]>;
  executable: Record<string, string[]>;
  securityDefinerWithoutSearchPath: string[];
  acUsage: Record<string, boolean>;
  serverOnlyTables: string[];
  /** Per server-only table: RLS on, and the service role's four privileges. */
  serverTables: Record<string, { rls: boolean; service_role: boolean }>;
  serviceRoleOnly: string[];
}

/** Every privilege a role may hold on a table, and on its columns. */
const ANY_TABLE = "'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'";
const ANY_COLUMN = "'SELECT, INSERT, UPDATE, REFERENCES'";

/** The grants as the database has them now, over the given schemas. */
export function observe(schemas: string[]): Observed {
  const inSchemas = `n.nspname = any (array[${schemas.map((s) => `'${s}'`).join(", ")}])`;
  const roles = `array[${ROLES.map((r) => `'${r}'`).join(", ")}]`;
  const [observed] = sqlJson<Observed>(`
with server_tables as (
  select c.oid, c.oid::pg_catalog.regclass::text as name, c.relrowsecurity as rls
    from pg_catalog.pg_class c
   where c.relnamespace = 'public'::pg_catalog.regnamespace and c.relkind in ('r', 'p')
     and not exists (
       select 1 from pg_catalog.unnest(array['public', ${ROLES.map((r) => `'${r}'`).join(", ")}]) as r
        where pg_catalog.has_table_privilege(r, c.oid, ${ANY_TABLE})
           or pg_catalog.has_any_column_privilege(r, c.oid, ${ANY_COLUMN})))
select pg_catalog.jsonb_build_object(
  'testimoniesSelect', (
    select pg_catalog.jsonb_object_agg(r, cols) from (
      select r, pg_catalog.jsonb_agg(a.attname order by a.attname) filter (
               where pg_catalog.has_column_privilege(r, a.attrelid, a.attnum, 'SELECT')) as cols
        from pg_catalog.unnest(${roles}) as r
       cross join pg_catalog.pg_attribute a
       where a.attrelid = 'public.testimonies'::pg_catalog.regclass and a.attnum > 0 and not a.attisdropped
       group by r) x),
  'executable', (
    select pg_catalog.jsonb_object_agg(r, coalesce(fns, '[]'::jsonb)) from (
      select r, (select pg_catalog.jsonb_agg(f.sig order by f.sig) from ${functions(inSchemas)} f
                  where pg_catalog.has_function_privilege(r, f.oid, 'EXECUTE')) as fns
        from pg_catalog.unnest(${roles}) as r) x),
  'securityDefinerWithoutSearchPath', coalesce((
    select pg_catalog.jsonb_agg(f.sig order by f.sig) from ${functions(inSchemas)} f
     where f.prosecdef
       and not exists (select 1 from pg_catalog.unnest(f.proconfig) c where c like 'search_path=%')), '[]'::jsonb),
  'acUsage', (
    select pg_catalog.jsonb_object_agg(r, pg_catalog.to_regnamespace('ac') is not null
                                          and pg_catalog.has_schema_privilege(r, 'ac', 'USAGE'))
      from pg_catalog.unnest(${roles}) as r),
  'serverOnlyTables', coalesce((select pg_catalog.jsonb_agg(t.name order by t.name) from server_tables t), '[]'::jsonb),
  'serverTables', coalesce((
    select pg_catalog.jsonb_object_agg(t.name, pg_catalog.jsonb_build_object(
             'rls', t.rls,
             'service_role', pg_catalog.has_table_privilege('service_role', t.oid, 'SELECT')
                             and pg_catalog.has_table_privilege('service_role', t.oid, 'INSERT')
                             and pg_catalog.has_table_privilege('service_role', t.oid, 'UPDATE')
                             and pg_catalog.has_table_privilege('service_role', t.oid, 'DELETE')))
      from server_tables t), '{}'::jsonb),
  'serviceRoleOnly', coalesce((
    select pg_catalog.jsonb_agg(f.sig order by f.sig) from ${functions("n.nspname = 'public'")} f
     where pg_catalog.has_function_privilege('service_role', f.oid, 'EXECUTE')
       and not exists (select 1 from pg_catalog.unnest(array['public', ${ROLES.map((r) => `'${r}'`).join(", ")}]) as r
                        where pg_catalog.has_function_privilege(r, f.oid, 'EXECUTE'))), '[]'::jsonb)
);`);
  return observed;
}

const MIGRATIONS = new URL("../../supabase/migrations/", import.meta.url);

/** How every migration that creates functions in ac ends (design B1 rule 6). */
const CLOSING_GRANTS =
  "revoke all on all functions in schema ac from public, anon, authenticated; " +
  "grant execute on all functions in schema ac to service_role;";

/** The migrations that create functions in ac without ending on CLOSING_GRANTS. */
export function migrationsWithoutClosingGrants(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => {
      const sql = readFileSync(new URL(f, MIGRATIONS), "utf8");
      if (!/create\s+(or\s+replace\s+)?function\s+ac\./i.test(sql)) return false;
      const tail = sql
        .replace(/--[^\n]*/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      return !tail.endsWith(CLOSING_GRANTS);
    });
}

type Reach = Record<string, { any: boolean; all: boolean }>;

/** The generated helpers replaced in place, as a later migration would (rolled
 *  back): who may run the functions of ac then. Null without schema ac. */
function probeReplacedHelpers(): Reach | null {
  const [exists] = sqlJson<boolean>(
    "select pg_catalog.to_jsonb(pg_catalog.to_regnamespace('ac') is not null);",
  );
  if (!exists) return null;
  const [reach] = sqlJson<Reach>(`
begin;
${derivedSql()}
select pg_catalog.jsonb_object_agg(r, pg_catalog.jsonb_build_object('any', a, 'all', b)) from (
  select r, pg_catalog.bool_or(x) as a, pg_catalog.bool_and(x) as b from (
    select r, pg_catalog.has_function_privilege(r, p.oid, 'EXECUTE') as x
      from pg_catalog.unnest(array['anon', 'authenticated', 'service_role']) as r
     cross join pg_catalog.pg_proc p
     where p.pronamespace = 'ac'::pg_catalog.regnamespace) y
  group by r) z;
rollback;`);
  return reach;
}

function diff(label: string, expected: string[], actual: string[]): string[] {
  const want = new Set(expected);
  const have = new Set(actual);
  return [
    ...[...have].filter((x) => !want.has(x)).map((x) => `${label}: unexpected ${x}`),
    ...[...want].filter((x) => !have.has(x)).map((x) => `${label}: missing ${x}`),
  ];
}

/** Why a role's read of a table failed, or null when it went through. */
function readAs(role: (typeof ROLES)[number], table: string): string | null {
  try {
    runSql(`
begin;
set local role ${role};
set local request.jwt.claims = '{"role": "${role}"}';
select count(*) from ${table};
rollback;`);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export function checkGrants(): string[] {
  const allow = readAllowlist();
  const seen = observe(allow.schemas);
  const errors: string[] = [];
  for (const r of ROLES) {
    errors.push(
      ...diff(
        `${r} SELECT on testimonies`,
        allow.testimoniesSelect,
        seen.testimoniesSelect[r] ?? [],
      ),
    );
    errors.push(...diff(`${r} EXECUTE`, allow.executable[r], seen.executable[r] ?? []));
    for (const fn of seen.executable[r] ?? []) {
      if (fn.startsWith("ac.")) errors.push(`${r} can execute ${fn}`);
    }
    if (seen.acUsage[r]) errors.push(`${r} has USAGE on schema ac`);
  }
  errors.push(
    ...diff(
      "SECURITY DEFINER without search_path",
      allow.securityDefinerWithoutSearchPath,
      seen.securityDefinerWithoutSearchPath,
    ).filter((e) => e.includes("unexpected")),
  );
  errors.push(
    ...diff(
      "tables closed to anon and authenticated",
      allow.serverOnlyTables,
      seen.serverOnlyTables,
    ),
  );
  for (const table of allow.serverOnlyTables) {
    const t = seen.serverTables[table];
    if (t && !t.rls) errors.push(`${table} has no row level security`);
    if (t && !t.service_role) errors.push(`service_role cannot read and write ${table}`);
    for (const r of ROLES) {
      const refused = readAs(r, table);
      if (refused === null) errors.push(`${r} can read ${table}`);
      else if (!/permission denied for table/.test(refused)) {
        errors.push(`${r} reading ${table}: ${refused}`);
      }
    }
  }
  errors.push(
    ...diff("functions only service_role may run", allow.serviceRoleOnly, seen.serviceRoleOnly),
  );
  for (const f of migrationsWithoutClosingGrants()) {
    errors.push(`${f} creates functions in ac but does not end with: ${CLOSING_GRANTS}`);
  }
  let reach: Reach | null = null;
  try {
    reach = probeReplacedHelpers();
  } catch (e) {
    errors.push(`the generated helpers do not replace the database's: ${(e as Error).message}`);
  }
  if (reach) {
    if (reach.anon?.any || reach.authenticated?.any) {
      errors.push("once replaced, functions of ac are executable by anon or authenticated");
    }
    if (!reach.service_role?.all) {
      errors.push("once replaced, functions of ac are not all executable by service_role");
    }
  }
  return errors;
}

/** allowlist.json as the database stands (npm run db:check -- --allowlist). */
export function currentAllowlist(): Allowlist {
  const schemas = readAllowlist().schemas;
  const seen = observe(schemas);
  const cols = seen.testimoniesSelect;
  if (JSON.stringify(cols.anon) !== JSON.stringify(cols.authenticated)) {
    throw new Error(
      "anon and authenticated read different testimonies columns: list them by hand.",
    );
  }
  return {
    schemas,
    testimoniesSelect: cols.anon ?? [],
    executable: {
      anon: seen.executable.anon ?? [],
      authenticated: seen.executable.authenticated ?? [],
    },
    securityDefinerWithoutSearchPath: seen.securityDefinerWithoutSearchPath,
    serverOnlyTables: seen.serverOnlyTables,
    serviceRoleOnly: seen.serviceRoleOnly,
  };
}
