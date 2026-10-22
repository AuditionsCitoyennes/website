-- Deletes the legacy import of 2026-04-24 (decided 2026-10-22, no copy kept:
-- irreversible on production):
--
--   "Anciens témoignages"                     1 audition (2020-12-05), 1,399 testimonies
--   "Cahier de doléances (Grand Débat 2019)"  29 auditions (2019-02-01), 332 testimonies
--
-- They were loaded without their witnesses (no email, so nobody could
-- confirm or withdraw them). Rows are matched by title AND date, so an
-- audition that happens to reuse a title is not touched; and the whole
-- migration aborts unless it finds exactly those rows (production) or none
-- of them (local, staging, CI: a no-op there).
set lock_timeout = '200ms';

do $$
declare
  v_auditions int;
  v_testimonies int;
begin
  create temporary table legacy_auditions on commit drop as
    select id from public.auditions
    where (title = 'Anciens témoignages' and "date" = '2020-12-05')
       or (title = 'Cahier de doléances (Grand Débat 2019)' and "date" = '2019-02-01');

  select count(*) into v_auditions from legacy_auditions;
  select count(*) into v_testimonies
  from public.testimonies where audition_id in (select id from legacy_auditions);

  if not ((v_auditions = 30 and v_testimonies = 1731) or (v_auditions = 0 and v_testimonies = 0)) then
    raise exception 'Expected 30 auditions and 1731 testimonies (or none), found % and %',
      v_auditions, v_testimonies;
  end if;

  -- Testimonies first: the foreign key does not cascade. Each delete fires
  -- drop_emptied_audition, which already removes an audition left empty.
  delete from public.testimonies where audition_id in (select id from legacy_auditions);
  delete from public.auditions where id in (select id from legacy_auditions);

  raise notice 'Deleted % auditions and % testimonies', v_auditions, v_testimonies;
end $$;
