// The grant guard: what anon and authenticated (the public key, and any
// signed-in user through PostgREST) can read and run stays what it is today.
//
// - testimonies: SELECT on exactly the nine columns of allowlist.json (no email,
//   no verification token, none of the derived columns);
// - the functions of the project's schemas they can EXECUTE equal the
//   allowlist (has_function_privilege, which ignores schema USAGE);
// - nothing in schema ac is executable by them, nor is the schema usable, and a
//   function created there later gets no EXECUTE either (default privileges);
// - every SECURITY DEFINER function sets search_path, but the baseline's eight
//   listed under securityDefinerWithoutSearchPath.

import { readFileSync } from "node:fs";
import { sqlJson } from "./psql";

export interface Allowlist {
  schemas: string[];
  testimoniesSelect: string[];
  executable: Record<"anon" | "authenticated", string[]>;
  securityDefinerWithoutSearchPath: string[];
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
}

/** The grants as the database has them now, over the given schemas. */
export function observe(schemas: string[]): Observed {
  const inSchemas = `n.nspname = any (array[${schemas.map((s) => `'${s}'`).join(", ")}])`;
  const roles = `array[${ROLES.map((r) => `'${r}'`).join(", ")}]`;
  const [observed] = sqlJson<Observed>(`
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
      from pg_catalog.unnest(${roles}) as r)
);`);
  return observed;
}

/** A function created in ac after the migrations: who may run it (rolled back). */
function probeDefaultPrivileges(): Record<string, boolean> | null {
  const [exists] = sqlJson<boolean>(
    "select pg_catalog.to_jsonb(pg_catalog.to_regnamespace('ac') is not null);",
  );
  if (!exists) return null;
  const [probe] = sqlJson<Record<string, boolean>>(`
begin;
create function ac.db_check_probe() returns integer language sql return 1;
select pg_catalog.jsonb_object_agg(r, pg_catalog.has_function_privilege(r, 'ac.db_check_probe()', 'EXECUTE'))
  from pg_catalog.unnest(array['anon', 'authenticated', 'service_role']) as r;
rollback;`);
  return probe;
}

function diff(label: string, expected: string[], actual: string[]): string[] {
  const want = new Set(expected);
  const have = new Set(actual);
  return [
    ...[...have].filter((x) => !want.has(x)).map((x) => `${label}: unexpected ${x}`),
    ...[...want].filter((x) => !have.has(x)).map((x) => `${label}: missing ${x}`),
  ];
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
  const probe = probeDefaultPrivileges();
  if (probe) {
    if (probe.anon || probe.authenticated) {
      errors.push("a new function in schema ac is executable by anon or authenticated");
    }
    if (!probe.service_role)
      errors.push("a new function in schema ac is not executable by service_role");
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
  };
}
