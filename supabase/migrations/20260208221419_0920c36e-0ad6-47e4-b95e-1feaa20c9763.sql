-- Drop the overly permissive public update policy
DROP POLICY IF EXISTS "Public can verify their own testimony" ON public.testimonies;

-- Create a more secure function for public verification
CREATE OR REPLACE FUNCTION public.verify_testimony(p_token uuid, p_action text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_testimony_id uuid;
BEGIN
  -- Validate action
  IF p_action NOT IN ('verified', 'rejected') THEN
    RETURN false;
  END IF;
  
  -- Find testimony by token
  SELECT id INTO v_testimony_id
  FROM public.testimonies
  WHERE verification_token = p_token
    AND verification_status = 'pending';
  
  IF v_testimony_id IS NULL THEN
    RETURN false;
  END IF;
  
  -- If rejected, delete the testimony
  IF p_action = 'rejected' THEN
    DELETE FROM public.testimonies WHERE id = v_testimony_id;
    RETURN true;
  END IF;
  
  -- If verified, update the status
  UPDATE public.testimonies
  SET verification_status = 'verified'
  WHERE id = v_testimony_id;
  
  RETURN true;
END;
$$;