-- An admin writes the content they created; super admins write all.
--
-- Six restrictive policies, beside the existing ones (which stay as they are:
-- a restrictive policy only narrows):
--   - auditions: inserted, updated and deleted by a super admin, or by the
--     account named in created_by (which an update cannot hand to another);
--   - testimonies: inserted by a super admin, or into an audition the caller
--     created; updated and deleted by a super admin, by the account that
--     created them, or by the one that created their audition.
-- An audition without an author (an online one, or one whose author's account
-- is gone) is a super admin's.
--
-- The insert rule of testimonies names the audition's author, not the row's
-- own created_by: the write guard sets that column to the caller before the
-- policy is checked.
--
-- Both sites send created_by with every audition they insert, and offer these
-- actions on an admin's own content only.
--
-- To undo:
--   drop policy "Auditions are added under their author's name" on public.auditions;
--   drop policy "Auditions are changed by their author and super admins" on public.auditions;
--   drop policy "Auditions are deleted by their author and super admins" on public.auditions;
--   drop policy "Testimonies are added to one's own auditions" on public.testimonies;
--   drop policy "Testimonies are changed by their authors and super admins" on public.testimonies;
--   drop policy "Testimonies are deleted by their authors and super admins" on public.testimonies;

-- The live site reads and writes these tables: fail fast rather than queue behind it.
set lock_timeout = '200ms';

create policy "Auditions are added under their author's name"
  on public.auditions
  as restrictive
  for insert
  to authenticated, anon
  with check (
    (select public.is_super_admin())
    or created_by = (select auth.uid())
  );

create policy "Auditions are changed by their author and super admins"
  on public.auditions
  as restrictive
  for update
  to authenticated, anon
  using (
    (select public.is_super_admin())
    or created_by = (select auth.uid())
  )
  with check (
    (select public.is_super_admin())
    or created_by = (select auth.uid())
  );

create policy "Auditions are deleted by their author and super admins"
  on public.auditions
  as restrictive
  for delete
  to authenticated, anon
  using (
    (select public.is_super_admin())
    or created_by = (select auth.uid())
  );

create policy "Testimonies are added to one's own auditions"
  on public.testimonies
  as restrictive
  for insert
  to authenticated, anon
  with check (
    (select public.is_super_admin())
    or exists (
      select 1
      from public.auditions a
      where a.id = testimonies.audition_id
        and a.created_by = (select auth.uid())
    )
  );

create policy "Testimonies are changed by their authors and super admins"
  on public.testimonies
  as restrictive
  for update
  to authenticated, anon
  using (
    (select public.is_super_admin())
    or created_by = (select auth.uid())
    or exists (
      select 1
      from public.auditions a
      where a.id = testimonies.audition_id
        and a.created_by = (select auth.uid())
    )
  );

create policy "Testimonies are deleted by their authors and super admins"
  on public.testimonies
  as restrictive
  for delete
  to authenticated, anon
  using (
    (select public.is_super_admin())
    or created_by = (select auth.uid())
    or exists (
      select 1
      from public.auditions a
      where a.id = testimonies.audition_id
        and a.created_by = (select auth.uid())
    )
  );
