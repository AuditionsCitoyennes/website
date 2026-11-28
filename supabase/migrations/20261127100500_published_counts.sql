-- The public counts view lists published auditions only.
--
-- audition_testimony_counts runs with its owner's rights, so the rule sits in
-- the view itself: a draft audition has no row. Same columns, same grants;
-- the online rule is unchanged (only validated testimonies count). Both sites
-- join it to published auditions.
--
-- To undo: run again the `CREATE OR REPLACE VIEW "public"."audition_testimony_counts"`
-- of 20261021175021_baseline.sql.

-- The live site reads this view: fail fast rather than queue behind it.
set lock_timeout = '200ms';

create or replace view public.audition_testimony_counts as
  select
    t.audition_id,
    (count(*))::integer as total_count,
    (count(*) filter (where t.verification_status = 'verified'))::integer as verified_count
  from public.testimonies t
  join public.auditions a on a.id = t.audition_id
  where a.status = 'published'
    and (not a.audition_en_ligne or t.verification_status = 'verified')
  group by t.audition_id;
