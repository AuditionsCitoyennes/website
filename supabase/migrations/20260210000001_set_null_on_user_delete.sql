-- Change testimonies.created_by FK to SET NULL so testimonies are preserved when a user is deleted
ALTER TABLE public.testimonies
DROP CONSTRAINT IF EXISTS testimonies_created_by_fkey;

ALTER TABLE public.testimonies
ADD CONSTRAINT testimonies_created_by_fkey
FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
