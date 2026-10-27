-- The reviewed backfill (../migrations/20261027053536_backfill_places_fr.sql) over fixture rows, in a transaction
-- rolled back. Generated with it by scripts/place-backfill/generate.ts (nnnhefcdanzxsgnaletc.supabase.co,
-- 2026-10-27T05:35:36Z): do not edit.
--
--   * every listed offline spelling is placed exactly as listed;
--   * every online row of a listed town hall is placed under its units at its
--     own point, under its own label — or on no point without one;
--   * a row changed since the review, an offline row carrying a listed town
--     hall's code, an online row labelled like a listed spelling and an online
--     point out of range stay stale, untouched;
--   * a row already placed keeps its place, offline or online (of a town hall
--     geo.api knows or not, with a point of its own or without);
--   * a second run changes nothing.
--
-- After each run it prints what the table says that run placed and left (a
-- JSON line), which db:check compares with the migration's NOTICEs.
--
-- npm run db:check -- backfill (it inlines the \ir lines), or psql -f from the repository root.

\set ON_ERROR_STOP on
set client_min_messages = notice;
begin;

create temp table backfill_listed (n int primary key, online boolean, location text, citycode text, unit text, path text[], locality text, key text, lat double precision, lng double precision, prec text, cand jsonb, release text) on commit drop;
insert into backfill_listed (n, online, location, citycode, unit, path, locality, key, lat, lng, prec, cand, release) values
  (1, false, '2 Rue D''enghien, Lyon', null, 'fr:com:69382', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69123', 'fr:com:69382']::text[], 'fr:com:69123', '2 Rue D''enghien, Lyon', 45.753219, 4.827021, 'address', null, 'geoapi-2026'),
  (2, false, 'Avenue Roger Salengro, Villeurbanne', null, 'fr:com:69266', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69266']::text[], 'fr:com:69266', 'Avenue Roger Salengro, Villeurbanne', 45.778708, 4.87931, 'address', null, 'geoapi-2026'),
  (3, false, 'Cordeliers, Lyon', null, 'fr:com:69382', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69123', 'fr:com:69382']::text[], 'fr:com:69123', 'Cordeliers, Lyon', 45.764, 4.8357, 'address', null, 'geoapi-2026'),
  (4, false, 'La Tour-Du-Pin', null, 'fr:com:38509', array['FR', 'fr:reg:84', 'fr:dep:38', 'fr:com:38509']::text[], 'fr:com:38509', 'La Tour-Du-Pin', 45.573641, 5.446211, 'commune', null, 'geoapi-2026'),
  (5, false, 'Les États-Unis, Lyon', null, 'fr:com:69388', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69123', 'fr:com:69388']::text[], 'fr:com:69123', 'Les États-Unis, Lyon', 45.731437, 4.866061, 'address', null, 'geoapi-2026'),
  (6, false, 'Manif Interfac Jean Macé, Lyon 7', null, 'fr:com:69387', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69123', 'fr:com:69387']::text[], 'fr:com:69123', 'Manif Interfac Jean Macé, Lyon 7', 45.7456, 4.8422, 'address', null, 'geoapi-2026'),
  (7, false, 'Croix-Rousse, Lyon', null, 'fr:com:69381', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69123', 'fr:com:69381']::text[], 'fr:com:69123', 'Marché de la Croix-Rousse, Lyon', 45.7743, 4.8316, 'address', null, 'geoapi-2026'),
  (8, false, 'Marché de la Croix-Rousse, Lyon', null, 'fr:com:69381', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69123', 'fr:com:69381']::text[], 'fr:com:69123', 'Marché de la Croix-Rousse, Lyon', 45.7743, 4.8316, 'address', null, 'geoapi-2026'),
  (9, false, 'Charpennes, Villeurbanne', null, 'fr:com:69266', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69266']::text[], 'fr:com:69266', 'Marché des Charpennes, Villeurbanne', 45.771, 4.8633, 'address', null, 'geoapi-2026'),
  (10, false, 'Marché des Charpennes, Villeurbanne', null, 'fr:com:69266', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69266']::text[], 'fr:com:69266', 'Marché des Charpennes, Villeurbanne', 45.771, 4.8633, 'address', null, 'geoapi-2026'),
  (11, false, 'Marché des Gratte-Ciel, Villeurbanne', null, 'fr:com:69266', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69266']::text[], 'fr:com:69266', 'Marché des Gratte-Ciel, Villeurbanne', 45.7676, 4.8799, 'address', null, 'geoapi-2026'),
  (12, false, 'Maison Des Jeunes Et De La Culture Jean Macé, Lyon', null, 'fr:com:69387', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69123', 'fr:com:69387']::text[], 'fr:com:69123', 'Marché Jean Macé, Lyon 7', 45.7456, 4.8422, 'address', null, 'geoapi-2026'),
  (13, false, 'Marché Jean Macé, Lyon 7', null, 'fr:com:69387', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69123', 'fr:com:69387']::text[], 'fr:com:69123', 'Marché Jean Macé, Lyon 7', 45.7456, 4.8422, 'address', null, 'geoapi-2026'),
  (14, false, 'Place Jean Macé, Lyon', null, 'fr:com:69387', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69123', 'fr:com:69387']::text[], 'fr:com:69123', 'Marché Jean Macé, Lyon 7', 45.7456, 4.8422, 'address', null, 'geoapi-2026'),
  (15, false, 'Parc Blandan, Lyon', null, 'fr:com:69387', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69123', 'fr:com:69387']::text[], 'fr:com:69123', 'Parc Blandan, Lyon', 45.7452, 4.8546, 'address', null, 'geoapi-2026'),
  (16, false, 'Part-Dieu, Lyon', null, 'fr:com:69383', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69123', 'fr:com:69383']::text[], 'fr:com:69123', 'Part-Dieu, Lyon', 45.7606, 4.859, 'address', null, 'geoapi-2026'),
  (17, false, 'Médiathèque Jean Prévost, Bron', null, 'fr:com:69029', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69029']::text[], 'fr:com:69029', 'Parvis Médiathèque, Bron', 45.7387, 4.9127, 'address', null, 'geoapi-2026'),
  (18, false, 'Parvis Médiathèque, Bron', null, 'fr:com:69029', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69029']::text[], 'fr:com:69029', 'Parvis Médiathèque, Bron', 45.7387, 4.9127, 'address', null, 'geoapi-2026'),
  (19, false, 'Place Carnot, Lyon', null, 'fr:com:69382', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69123', 'fr:com:69382']::text[], 'fr:com:69123', 'Place Carnot, Lyon', 45.750935, 4.828142, 'address', null, 'geoapi-2026'),
  (20, false, 'Place Colbert, Lyon', null, 'fr:com:69381', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69123', 'fr:com:69381']::text[], 'fr:com:69123', 'Place Colbert, Lyon', 45.772465, 4.834424, 'address', null, 'geoapi-2026'),
  (21, false, 'Place Du Docteur Lazare Goujon, Villeurbanne', null, 'fr:com:69266', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69266']::text[], 'fr:com:69266', 'Place Du Docteur Lazare Goujon, Villeurbanne', 45.765944, 4.879525, 'address', null, 'geoapi-2026'),
  (22, false, 'Grandclément, Villeurbanne', null, 'fr:com:69266', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69266']::text[], 'fr:com:69266', 'Place Grandclément, Villeurbanne', 45.766, 4.887, 'address', null, 'geoapi-2026'),
  (23, false, 'Place Grandclément, Villeurbanne', null, 'fr:com:69266', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69266']::text[], 'fr:com:69266', 'Place Grandclément, Villeurbanne', 45.766, 4.887, 'address', null, 'geoapi-2026'),
  (24, false, 'Place Sathonay, Lyon', null, 'fr:com:69381', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69123', 'fr:com:69381']::text[], 'fr:com:69123', 'Place Sathonay, Lyon', 45.769208, 4.830386, 'address', null, 'geoapi-2026'),
  (25, false, 'Place Wilson, Villeurbanne', null, 'fr:com:69266', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69266']::text[], 'fr:com:69266', 'Place Wilson, Villeurbanne', 45.773601, 4.868233, 'address', null, 'geoapi-2026'),
  (26, false, 'Quai Augagneur, Lyon', null, 'fr:com:69383', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69123', 'fr:com:69383']::text[], 'fr:com:69123', 'Quai Augagneur, Lyon', 45.759153, 4.841068, 'address', null, 'geoapi-2026'),
  (27, false, 'Quai Victor Augagneur, Lyon', null, 'fr:com:69383', array['FR', 'fr:reg:84', 'fr:dep:69', 'fr:com:69123', 'fr:com:69383']::text[], 'fr:com:69123', 'Quai Victor Augagneur, Lyon', 45.759153, 4.841068, 'address', null, 'geoapi-2026');

-- One audition never placed per listed value (online: with a point of its
-- own); then the rows the migration must place otherwise, or not at all.
create temp table backfill_fixture (
  id uuid primary key default gen_random_uuid(), role text not null, n int,
  location text not null, online boolean not null, citycode text, place jsonb
) on commit drop;
insert into backfill_fixture (role, n, location, online, citycode, place)
  select 'listed', n, location, online, citycode,
         case when online then pg_catalog.jsonb_build_object('lat', 10 + n / 1000.0, 'lng', 20 + n / 1000.0) end
    from backfill_listed;
insert into backfill_fixture (role, n, location, online, citycode, place) values
  ('changed', null, '2 Rue D''enghien, Lyon (modifié après la revue)', false, null, null),
  ('placed', null, '2 Rue D''enghien, Lyon', false, null, null),
  ('untouched', null, '2 Rue D''enghien, Lyon', true, '99999', '{"lat": 45.1, "lng": 5.1}'::jsonb);

-- One month each, months no real row has (online rows are one per town hall and month).
insert into public.auditions (id, title, "date", location, content, status, audition_en_ligne, citycode, place)
select f.id, 'Backfill fixture',
       (date '1800-01-01' + pg_catalog.make_interval(months => (row_number() over (order by f.id))::int))::date,
       f.location, 'Backfill fixture', 'published', f.online, f.citycode, f.place
  from backfill_fixture f;
update public.auditions a
   set lieu_key = 'backfill fixture', place_precision = 'unplaced', placed_location = a.location
  from backfill_fixture f
 where f.id = a.id and f.role = 'placed';
create temp table backfill_placed_before on commit drop as
  select a.id, place_unit, place_path, locality_id, lieu_key, lat, lng, place_precision, place_candidates, placed_location, placed_rules, geo_release from public.auditions a
    join backfill_fixture f on f.id = a.id
   where f.role = 'placed';

-- What each run finds: listed or not, placed or not (the NOTICEs' counts).
create temp table backfill_seen (
  run int not null, id uuid not null, online boolean not null, listed boolean not null,
  was_placed boolean not null
) on commit drop;
insert into backfill_seen (run, id, online, listed, was_placed)
  select 1, a.id, a.audition_en_ligne,
         coalesce(case when a.audition_en_ligne
                       then a.citycode in (select l.citycode from backfill_listed l where l.online)
                       else a.location in (select l.location from backfill_listed l where not l.online)
                  end, false),
         a.placed_location is not null
    from public.auditions a;

\ir ../migrations/20261027053536_backfill_places_fr.sql

select pg_catalog.jsonb_build_object(
         'run', 1,
         'map', count(*) filter (where not s.online and not s.was_placed and a.placed_location is not null and a.place_path is not null),
         'nowhere', count(*) filter (where not s.online and not s.was_placed and a.placed_location is not null and a.place_path is null),
         'own', count(*) filter (where s.online and not s.was_placed and a.placed_location is not null and a.place_path is not null),
         'pointless', count(*) filter (where s.online and not s.was_placed and a.placed_location is not null and a.place_path is null),
         'kept_offline', count(*) filter (where not s.online and s.listed and s.was_placed),
         'kept_online', count(*) filter (where s.online and s.listed and s.was_placed),
         'stale_offline', count(*) filter (where a.place_stale and not a.audition_en_ligne),
         'stale_online', count(*) filter (where a.place_stale and a.audition_en_ligne))
  from backfill_seen s join public.auditions a on a.id = s.id
 where s.run = 1;

do $$
declare bad text;
begin
  select string_agg(l.location, ' | ' order by l.n) into bad
    from backfill_fixture f
    join public.auditions a on a.id = f.id
    join backfill_listed l on l.n = f.n
   where f.role = 'listed' and not l.online
     and not (a.place_unit is not distinct from l.unit
          and a.place_path is not distinct from l.path
          and a.locality_id is not distinct from l.locality
          and a.lieu_key is not distinct from l.key
          and a.lat is not distinct from l.lat
          and a.lng is not distinct from l.lng
          and a.place_precision is not distinct from l.prec
          and a.place_candidates is not distinct from l.cand
          and a.placed_location is not distinct from a.location
          and a.placed_rules is not distinct from '6c6fb15e'
          and a.geo_release is not distinct from l.release
          and not a.place_stale);
  if bad is not null then
    raise exception 'backfill: not placed as listed: %', bad;
  end if;
  -- Online: the town hall's units at the row's own point, or no point without one.
  select string_agg(l.citycode || ' (' || f.location || ')', ' | ' order by l.n, f.location) into bad
    from backfill_fixture f
    join public.auditions a on a.id = f.id
    join backfill_listed l on l.n = f.n
    cross join lateral (select l.path is not null and f.place ? 'lat' as here) p
   where f.role in ('listed', 'renamed', 'pointless') and l.online
     and not (a.place_unit is not distinct from (case when p.here then l.unit end)
          and a.place_path is not distinct from (case when p.here then l.path end)
          and a.locality_id is not distinct from (case when p.here then l.locality end)
          and a.lieu_key is not distinct from a.location
          and a.lat is not distinct from (case when p.here then (f.place->>'lat')::double precision end)
          and a.lng is not distinct from (case when p.here then (f.place->>'lng')::double precision end)
          and a.place_precision is not distinct from (case when p.here then l.prec else 'unplaced' end)
          and a.place_candidates is null
          and a.placed_location is not distinct from a.location
          and a.placed_rules is null
          and a.geo_release is not distinct from (case when p.here then l.release end)
          and not a.place_stale);
  if bad is not null then
    raise exception 'backfill: an online row not placed at its own point under its town hall: %', bad;
  end if;
  select string_agg(f.role || ': ' || f.location, ' | ') into bad
    from backfill_fixture f join public.auditions a on a.id = f.id
   where f.role in ('changed', 'untouched', 'far')
     and not (a.place_stale and a.placed_location is null and a.place_path is null
              and a.lieu_key is null and a.place_precision is null and a.lat is null);
  if bad is not null then
    raise exception 'backfill: a row it must leave alone was placed: %', bad;
  end if;
  select string_agg(f.location || case when f.online then ' (online, ' || f.citycode || ')' else '' end,
                    ' | ' order by f.location) into bad
    from backfill_fixture f
   where f.role = 'placed'
     and exists (select a.id, place_unit, place_path, locality_id, lieu_key, lat, lng, place_precision, place_candidates, placed_location, placed_rules, geo_release from public.auditions a where a.id = f.id
                 except select * from backfill_placed_before p where p.id = f.id);
  if bad is not null then
    raise exception 'backfill: a row already placed was placed again: %', bad;
  end if;
end $$;

create temp table backfill_auditions_once on commit drop as
  select id, place_unit, place_path, locality_id, lieu_key, lat, lng, place_precision, place_candidates, placed_location, placed_rules, geo_release from public.auditions;
create temp table backfill_units_once on commit drop as select * from public.geo_units;
insert into backfill_seen (run, id, online, listed, was_placed)
  select 2, a.id, a.audition_en_ligne,
         coalesce(case when a.audition_en_ligne
                       then a.citycode in (select l.citycode from backfill_listed l where l.online)
                       else a.location in (select l.location from backfill_listed l where not l.online)
                  end, false),
         a.placed_location is not null
    from public.auditions a;

\ir ../migrations/20261027053536_backfill_places_fr.sql

select pg_catalog.jsonb_build_object(
         'run', 2,
         'map', count(*) filter (where not s.online and not s.was_placed and a.placed_location is not null and a.place_path is not null),
         'nowhere', count(*) filter (where not s.online and not s.was_placed and a.placed_location is not null and a.place_path is null),
         'own', count(*) filter (where s.online and not s.was_placed and a.placed_location is not null and a.place_path is not null),
         'pointless', count(*) filter (where s.online and not s.was_placed and a.placed_location is not null and a.place_path is null),
         'kept_offline', count(*) filter (where not s.online and s.listed and s.was_placed),
         'kept_online', count(*) filter (where s.online and s.listed and s.was_placed),
         'stale_offline', count(*) filter (where a.place_stale and not a.audition_en_ligne),
         'stale_online', count(*) filter (where a.place_stale and a.audition_en_ligne))
  from backfill_seen s join public.auditions a on a.id = s.id
 where s.run = 2;

do $$
begin
  if exists (select * from backfill_auditions_once
             except select id, place_unit, place_path, locality_id, lieu_key, lat, lng, place_precision, place_candidates, placed_location, placed_rules, geo_release from public.auditions)
     or exists (select id, place_unit, place_path, locality_id, lieu_key, lat, lng, place_precision, place_candidates, placed_location, placed_rules, geo_release from public.auditions
                except select * from backfill_auditions_once) then
    raise exception 'backfill: a second run changed auditions';
  end if;
  if exists (select * from backfill_units_once except select * from public.geo_units)
     or exists (select * from public.geo_units except select * from backfill_units_once) then
    raise exception 'backfill: a second run changed geo_units';
  end if;
end $$;

rollback;
