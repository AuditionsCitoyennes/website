-- One-off cleanup: remove the imported historical datasets.
--   1) "Anciens témoignages"               (location 'France')  -> 1 audition,  ~1399 testimonies
--   2) "Cahier de doléances (Grand Débat 2019)"                 -> 29 auditions, ~332 testimonies
--
-- testimonies.audition_id is declared ON DELETE CASCADE, so deleting these
-- auditions removes their testimonies automatically. Nothing else references
-- testimonies.
--
-- ⚠ IRREVERSIBLE — this deletes ~1731 of 1955 testimonies. Export/back up first
--   (Supabase dashboard → Table editor → Export, or pg_dump).
-- ⚠ Must be run with a privileged role (Supabase SQL editor / service role /
--   psql). The public/anon API key cannot delete these rows (RLS).

-- 1. PREVIEW — run this on its own first and confirm the rows + counts:
SELECT title, location, count(t.id) AS testimonies
FROM public.auditions a
LEFT JOIN public.testimonies t ON t.audition_id = a.id
WHERE a.title IN ('Anciens témoignages', 'Cahier de doléances (Grand Débat 2019)')
GROUP BY a.id, a.title, a.location
ORDER BY a.title, a.location;

-- 2. DELETE — run inside a transaction once the preview looks right.
BEGIN;

DELETE FROM public.auditions
WHERE title = 'Anciens témoignages';

DELETE FROM public.auditions
WHERE title = 'Cahier de doléances (Grand Débat 2019)';

-- Sanity check the remaining totals BEFORE committing; ROLLBACK if they look wrong.
-- SELECT (SELECT count(*) FROM public.auditions)  AS auditions_left,   -- expect 62
--        (SELECT count(*) FROM public.testimonies) AS testimonies_left; -- expect 224

COMMIT;
