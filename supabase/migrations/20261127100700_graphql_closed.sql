-- GraphQL is switched off: neither site calls /graphql/v1.
--
-- pg_graphql serves, to the public key, every table and function PostgREST
-- already serves. Where the migration role may drop the extension, it goes
-- (without CASCADE: nothing of the project depends on it); where it may not,
-- the public roles lose their access to schema graphql_public. The file then
-- prints what it observes, since both depend on the project: closed, or still
-- open, in which case the switch is in the dashboard (Database > Extensions,
-- pg_graphql off; API settings, exposed schemas: public only).
--
-- supabase/config.toml exposes schema public only, for the local stacks.
--
-- To undo: create extension pg_graphql with schema graphql;

set lock_timeout = '200ms';

do $$
declare
  v_installed boolean;
  v_reachable boolean;
begin
  begin
    drop extension if exists pg_graphql;
  exception when insufficient_privilege or dependent_objects_still_exist then
    if pg_catalog.to_regnamespace('graphql_public') is not null then
      begin
        revoke usage on schema graphql_public from public, anon, authenticated;
      exception when insufficient_privilege then
        null; -- reported below
      end;
    end if;
  end;

  v_installed := exists (select 1 from pg_catalog.pg_extension where extname = 'pg_graphql');
  v_reachable := pg_catalog.to_regnamespace('graphql_public') is not null
    and (pg_catalog.has_schema_privilege('anon', 'graphql_public', 'USAGE')
         or pg_catalog.has_schema_privilege('authenticated', 'graphql_public', 'USAGE'));

  if not v_installed then
    raise notice 'GraphQL closed: pg_graphql is not installed';
  elsif not v_reachable then
    raise notice 'GraphQL closed: pg_graphql is installed, the public roles cannot use schema graphql_public';
  else
    raise notice 'GraphQL still open: pg_graphql is installed and the public roles can use schema graphql_public. Switch it off in the dashboard (Database > Extensions) and expose schema public only (API settings)';
  end if;
end;
$$;
