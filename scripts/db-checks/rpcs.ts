// The read RPCs of map phase 1 (supabase/migrations/20261026200000_read_rpcs.sql):
// the API alone runs them, with the service role, which is bounded.
//
// - each is plpgsql, STABLE, SECURITY INVOKER, with search_path '' and exact
//   float output (extra_float_digits 1);
// - anon and authenticated calling one are refused (the grant guard checks
//   the privileges; this calls them, rolled back);
// - the service role's statements end after 5 s (its own statement_timeout,
//   which PostgREST applies to the calls it makes as that role).
//
// What they answer is npm run db:parity's (scripts/parity).

import { sqlJson, runSql } from "./psql";

export const READ_RPCS = [
  "public.place_counts(text, jsonb, integer, boolean, integer, boolean)",
  "public.place_counts_many(text[], jsonb, integer, boolean, integer, boolean)",
  "public.lieu_auditions(text, jsonb, text)",
  "public.audition_results(jsonb, text, jsonb, integer, uuid)",
  "public.testimony_page(uuid, jsonb, jsonb, integer)",
  "public.place_facets()",
  "public.admin_audition_filter(jsonb, uuid)",
];

interface Fn {
  sig: string;
  found: boolean;
  language?: string;
  volatility?: string;
  definer?: boolean;
  config?: string[] | null;
}

export function checkRpcs(): string[] {
  const errors: string[] = [];
  const [fns] = sqlJson<Fn[]>(`
select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'sig', s, 'found', p.oid is not null, 'language', l.lanname, 'volatility', p.provolatile,
         'definer', p.prosecdef, 'config', p.proconfig) order by s)
  from pg_catalog.unnest(array[${READ_RPCS.map((s) => `'${s}'`).join(", ")}]) as s
  left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(s)
  left join pg_catalog.pg_language l on l.oid = p.prolang;`);
  for (const f of fns) {
    if (!f.found) {
      errors.push(`${f.sig} is missing`);
      continue;
    }
    if (f.language !== "plpgsql") errors.push(`${f.sig} is ${f.language}, not plpgsql`);
    if (f.volatility !== "s") errors.push(`${f.sig} is not STABLE`);
    if (f.definer) errors.push(`${f.sig} is SECURITY DEFINER`);
    const config = f.config ?? [];
    if (!config.includes('search_path=""')) errors.push(`${f.sig} does not set search_path ''`);
    if (!config.includes("extra_float_digits=1")) {
      errors.push(`${f.sig} does not set extra_float_digits 1`);
    }
  }
  for (const role of ["anon", "authenticated"]) {
    for (const call of ["public.place_counts()", "public.place_facets()"]) {
      try {
        runSql(`
begin;
set local role ${role};
set local request.jwt.claims = '{"role": "${role}"}';
select ${call};
rollback;`);
        errors.push(`${role} can call ${call}`);
      } catch (e) {
        if (!/permission denied for function/.test((e as Error).message)) {
          errors.push(`${role} calling ${call}: ${(e as Error).message}`);
        }
      }
    }
  }
  const [config] = sqlJson<string[] | null>(
    "select pg_catalog.to_jsonb(rolconfig) from pg_catalog.pg_roles where rolname = 'service_role';",
  );
  if (!config?.includes("statement_timeout=5s")) {
    errors.push(
      `service_role's settings are ${JSON.stringify(config)}: statement_timeout=5s expected`,
    );
  }
  return errors;
}
