-- DRAFT, NOT A MIGRATION: kept out of supabase/migrations on purpose.
--
-- Written in 2026 against what the old migration files described, not against
-- production: production's policies carry other names ("Admin insert
-- auditions", "Public read testimonies", ...), so on production most of the
-- DROP POLICY IF EXISTS below would do nothing and leave the open policies in
-- place. Rewrite it against supabase/migrations/20261021175021_baseline.sql
-- (and test it on staging) before the old app is switched off.

-- ============================================================================
-- TIGHTENING MIGRATION — apply ONLY when cutting over to the new Vue/Fastify
-- app. The OLD React app's /verifier page updates testimonies directly with
-- the anon key via the by-token policies dropped below; applying this while
-- the old app is still live would break its verification flow.
-- (Timestamped 2099 so `supabase db push` doesn't pick it up by accident
-- before the cutover; rename with a real timestamp when applying.)
--
-- Fixes two audit findings from the rebuild review:
--  1. The auditions mutation policies were never tightened: ANY authenticated
--     user (incl. unapproved pending signups) can insert/update/delete ANY
--     audition with the public anon key, bypassing the API entirely.
--  2. There is no admin SELECT policy on auditions, so admins cannot read
--     back their own drafts (draft management is broken under RLS).
-- ============================================================================

-- 1) Admins can read all auditions (drafts included); public stays published-only.
CREATE POLICY "Admins can view all auditions"
ON public.auditions
FOR SELECT
USING (is_admin() OR is_super_admin());

-- 2) Replace the wide-open authenticated mutation policies with the same
--    role/ownership model testimonies already use.
DROP POLICY IF EXISTS "Authenticated users can insert auditions" ON public.auditions;
DROP POLICY IF EXISTS "Authenticated users can update auditions" ON public.auditions;
DROP POLICY IF EXISTS "Authenticated users can delete auditions" ON public.auditions;

CREATE POLICY "Admins can insert auditions"
ON public.auditions
FOR INSERT
WITH CHECK (
  (is_admin() OR is_super_admin())
  AND (created_by = auth.uid() OR is_super_admin())
);

CREATE POLICY "Update auditions based on ownership"
ON public.auditions
FOR UPDATE
USING (is_super_admin() OR (is_admin() AND created_by = auth.uid()));

CREATE POLICY "Delete auditions based on ownership"
ON public.auditions
FOR DELETE
USING (is_super_admin() OR (is_admin() AND created_by = auth.uid()));

-- 3) Remove the public by-token policies. They expose every tokenised row
--    (the column default gives EVERY row a token) to anonymous reads and
--    updates. The new app performs the verification flow through its API.
DROP POLICY IF EXISTS "Anyone can view testimony for verification" ON public.testimonies;
DROP POLICY IF EXISTS "Anon can update testimony by token" ON public.testimonies;
DROP POLICY IF EXISTS "Anon can delete testimony by token" ON public.testimonies;

-- 4) Stop issuing verification tokens by default — only testimonies created
--    with an email address need one (the new API sets it explicitly).
ALTER TABLE public.testimonies ALTER COLUMN verification_token DROP DEFAULT;
