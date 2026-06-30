-- Fix function search path
DROP FUNCTION IF EXISTS public.handle_updated_at() CASCADE;

CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER 
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Re-add trigger to auditions table
CREATE TRIGGER set_auditions_updated_at
  BEFORE UPDATE ON public.auditions
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();