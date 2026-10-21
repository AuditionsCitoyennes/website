-- Imported, located, dated citizen-participation events from external open
-- datasets (see data-ingestion/). Kept in a SEPARATE table from public.auditions
-- so it never touches the association's own editorial rows, their RLS, or the
-- cached/polled map path fixed in PR #16. Every row carries its `source`, so a
-- whole source can be re-imported or removed cleanly (unlike the old
-- delete-by-title cleanup in cleanup_grand_debat_anciens.sql).
--
-- Nothing here is public until it is both (a) status='published' AND (b) the
-- RGPD gate for that source is cleared (lawful basis + notice + erasure route).
-- Default status is 'draft', so a freshly loaded batch is invisible to anon.
--
-- Self-contained + idempotent: this repo shares its Supabase DB with the older
-- app, whose migration history differs, so this migration assumes NOTHING from
-- the other migrations (it defines its own helpers) and can be re-run safely.

-- BAN/geo precision tier, mirrors GEOCODE_PRECISIONS in
-- data-ingestion/src/lib/schema.ts.
DO $$ BEGIN
  CREATE TYPE public.geocode_precision AS ENUM
    ('housenumber', 'street', 'venue', 'municipality', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- updated_at touch trigger. CREATE OR REPLACE so we don't depend on the base
-- migration having created it on this database.
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS public.imported_auditions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source           TEXT NOT NULL,                 -- e.g. 'gdn'
  source_id        TEXT NOT NULL,                 -- stable id within the source
  title            TEXT NOT NULL,
  held_on          DATE,                          -- date of the assembly
  -- location (the honesty invariant below ties coords to an address-level tier)
  address          TEXT,
  city             TEXT,
  postcode         TEXT,
  citycode         TEXT,                          -- INSEE code (nullable for now)
  lat              DOUBLE PRECISION,
  lng              DOUBLE PRECISION,
  geocode_precision public.geocode_precision NOT NULL,
  -- content
  testimony        TEXT NOT NULL,                 -- anonymised report text
  topics           TEXT[] DEFAULT '{}',
  url              TEXT,
  -- licensing / provenance
  license          TEXT NOT NULL,
  attribution      TEXT NOT NULL,
  retrieved_at     TIMESTAMPTZ,
  source_offset_m  REAL,                          -- BAN-vs-platform distance (QA)
  -- RGPD / editorial gating. Own enum (not audition_status) so this table stays
  -- independent of the other app's schema on the shared DB.
  has_personal_data BOOLEAN NOT NULL DEFAULT FALSE,
  redaction_applied BOOLEAN NOT NULL DEFAULT FALSE,
  status           TEXT NOT NULL DEFAULT 'draft',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT imported_auditions_status_chk CHECK (status IN ('draft', 'published')),
  -- Idempotent re-import: one row per (source, source_id).
  CONSTRAINT imported_auditions_source_uid UNIQUE (source, source_id),
  -- Honesty invariant: a coordinate ALWAYS means an address-level tier; coarse
  -- tiers are structurally coordinate-free. A fabricated precise point can't persist.
  CONSTRAINT imported_auditions_precise_coords CHECK (
    (geocode_precision IN ('housenumber', 'street', 'venue')
       AND lat IS NOT NULL AND lng IS NOT NULL)
    OR
    (geocode_precision IN ('municipality', 'unknown')
       AND lat IS NULL AND lng IS NULL)
  ),
  -- Un-anonymised rows carrying personal data must never be publishable.
  CONSTRAINT imported_auditions_pd_gate CHECK (
    status <> 'published' OR has_personal_data = FALSE OR redaction_applied = TRUE
  )
);

CREATE INDEX IF NOT EXISTS imported_auditions_source_idx ON public.imported_auditions (source);
CREATE INDEX IF NOT EXISTS imported_auditions_citycode_idx ON public.imported_auditions (citycode);
CREATE INDEX IF NOT EXISTS imported_auditions_status_idx ON public.imported_auditions (status);

ALTER TABLE public.imported_auditions ENABLE ROW LEVEL SECURITY;

-- Public sees ONLY published rows. Default 'draft' keeps a freshly loaded batch
-- private until it is explicitly cleared for display. DROP-then-CREATE so the
-- migration is safely re-runnable.
DROP POLICY IF EXISTS "Anyone can view published imported auditions" ON public.imported_auditions;
CREATE POLICY "Anyone can view published imported auditions"
  ON public.imported_auditions
  FOR SELECT
  USING (status = 'published');

DROP POLICY IF EXISTS "Authenticated can insert imported auditions" ON public.imported_auditions;
CREATE POLICY "Authenticated can insert imported auditions"
  ON public.imported_auditions FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "Authenticated can update imported auditions" ON public.imported_auditions;
CREATE POLICY "Authenticated can update imported auditions"
  ON public.imported_auditions FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Authenticated can delete imported auditions" ON public.imported_auditions;
CREATE POLICY "Authenticated can delete imported auditions"
  ON public.imported_auditions FOR DELETE TO authenticated USING (true);

DROP TRIGGER IF EXISTS set_imported_auditions_updated_at ON public.imported_auditions;
CREATE TRIGGER set_imported_auditions_updated_at
  BEFORE UPDATE ON public.imported_auditions
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();
