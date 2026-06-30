-- Drop existing function first (parameter order: p_action, p_token)
DROP FUNCTION IF EXISTS public.verify_testimony(text, text);

-- Recreate with 14-day token expiration check
CREATE FUNCTION public.verify_testimony(p_action text, p_token text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_testimony_id uuid;
  v_created_at timestamptz;
BEGIN
  -- Find the testimony and check creation date
  SELECT id, created_at INTO v_testimony_id, v_created_at
  FROM public.testimonies
  WHERE verification_token = p_token
    AND verification_status = 'pending';

  IF v_testimony_id IS NULL THEN
    RETURN false;
  END IF;

  -- Check if token is expired (14 days)
  IF v_created_at < now() - interval '14 days' THEN
    RETURN false;
  END IF;

  IF p_action = 'verify' THEN
    UPDATE public.testimonies
    SET verification_status = 'verified'
    WHERE id = v_testimony_id;
    RETURN true;
  ELSIF p_action = 'reject' THEN
    DELETE FROM public.testimonies
    WHERE id = v_testimony_id;
    RETURN true;
  END IF;

  RETURN false;
END;
$$;
