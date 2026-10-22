-- Removes the imported-data feature (decided 2026-10-22): the table of
-- open-data events loaded by the former data-ingestion workspace (1,099
-- published Grand Débat National entries on production, public data that can
-- be re-imported from its source) and its enum. Nothing reads them any more:
-- the API module and the map layer are gone, and the old app never used them.
-- The table's indexes, policies and trigger go with it; handle_updated_at()
-- stays, a generic trigger function.
set lock_timeout = '200ms';

drop table if exists public.imported_auditions;
drop type if exists public.geocode_precision;
